// `8bs build` — compile a program for a target.
//
//     8bs build --target vic20        [entry.8bs]   NTSC (60Hz), the default
//     8bs build --target vic20 --pal  [entry.8bs]
//     8bs build --target web          [entry.8bs]
//     8bs build --target atari8 --profile 130xe [entry.8bs]
//     8bs build --target vic20 --profile 16k    [entry.8bs]
//     8bs build --target c64 --profile reu512   [entry.8bs]
//     8bs build --target pet --profile 8032     [entry.8bs]   80 columns, 32K
//     8bs build --release                       Every artifact 8bitscript.config.ts
//                                                declares for a release — see
//                                                buildRelease below.
//
// The system (vic20/c64/pet/c128/atari8/nes/cx16/mega65/web) is the target;
// NTSC/PAL is a --pal/--ntsc option on top of it, not a separate flavor of
// the target, because it changes the emulator's machine model at run time
// and nothing about the build — see the comment on MODEL_ARGS in run.mjs
// for why that still means picking a whole machine model rather than just a
// sync-factor flag. It only applies to targets with a real region split
// (see REGION_TARGETS below); it's silently ignored everywhere else, the
// same as it already was for web. "NTSC (60Hz)" above is the emulator's real
// hardware region, not the language's logical frame rate — that's a
// separate, project-level setting (`frameRate` in 8bitscript.config.ts, default 60,
// see packages/compiler/src/mos FRAME_SYNC),
// unaffected by --pal.
//
// --profile names the hardware the build is for: a preset from the
// machine package's catalog (`8032`, `130xe`, `reu512` — the community's
// names for whole configurations) or a profile the project composes in
// its 8bitscript.config.ts (`targets: { c64: { profiles: { loaded: { ram:
// 'reu512', port1: 'mouse1351' } } } }`). --hardware option=value,...
// sets single options on top of either. What each option changes — a
// link symbol, a driver, an emulator flag, a fact a program can read — is
// the catalog's to say; see packages/cli/src/hardware.mjs and
// docs/systems.md. `8bs targets` lists every option and preset.
//
// The entry defaults to src/main.8bs, or to the `entry` in
// 8bitscript.config.ts when the project has one — and whichever file that
// names, a `.<target>.8bs`
// twin beside it (main.nes.8bs next to main.8bs) is what a build for that
// target actually starts from; see resolveEntryPath. Output lands in dist/, named
// <name>-<machine>[-<hardware>...][-<region>].<ext> — .prg for the Commodore/
// CX16/MEGA65 targets, .xex (or .rom for an XEGS cartridge) for Atari 8-bit,
// .nes for the NES, .wasm for the web.
// Only hardware that changes the *build* is in the name (a PET's model, a
// VIC-20's RAM): a mouse or a REU makes the same program, so it is not.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
  MACHINES, RELEASE_MACHINES, isVariantPath, link, positionAt, variantOf,
  unmetRequirements,
} from '@8bitscript/compiler';

import { loadConfig, resolveFrameRate } from './config.mjs';
import {
  HARDWARE_USAGE, REGION_MACHINES, hardwareArgs, listedTargets, loadCatalog, projectHardware,
  projectProfiles, projectRequires, projectSystems, resolveHardware, whatSatisfies,
} from './hardware.mjs';
import { compileReport, writeLastRun } from './last-run.mjs';

const TARGETS = new Set(MACHINES);

// The targets whose frame-sync strategy has a real NTSC/PAL split, auto-
// detected at runtime (packages/compiler/src/mos FRAME_SYNC 'level' machines)
// — the only ones where --pal changes the build or a region suffix on the
// output filename. The PET has no region at all: its refresh is the
// model's (a hardware option — see packages/pet/package.json's catalog),
// FRAME_SYNC.pet measures it at start-up, and `8bs run pet` says so if
// given --pal. It is the same set `8bs targets` reports a region for, so
// there is one of it (hardware.mjs).
const REGION_TARGETS = REGION_MACHINES;

// Diagnostics may come from any module in the import graph, so each one is
// rendered against its own file's text, not the entry's.
function printDiagnostics(diagnostics, sources) {
  for (const d of diagnostics) {
    const { line, column } = positionAt(sources.get(d.file) ?? '', d.start);
    process.stdout.write(`${basename(d.file)}:${line}:${column}\n`);
    process.stdout.write(`${d.severity} ${d.code}: ${d.message}\n\n`);
  }
}

// The old target names, kept only to point people at their replacement
// rather than failing with a bare "unknown target".
const RETIRED_TARGET = /^(vic20|c64)-(ntsc|pal)$/;

// `entry` in 8bitscript.config.ts is one path, shared by every target, and the
// filename rule does the rest: a project whose entry point genuinely has to
// differ on one machine — its execution model, its screen codes, its grid
// — puts that machine's version beside the shared file as
// `main.<target>.8bs`, and a build for that target starts there instead.
// The same rule applies to every file the entry imports, so this is not a
// special case for the entry; it is just where the CLI applies it first.
// The rule is applied to whatever names the entry — the config, the
// default, or an explicit argument — unless that path already names one
// machine's version (`8bs build src/main.nes.8bs`), which is taken as is.
//
// `entry` may still be an object keyed by machine (`{ default, nes }`), the
// older spelling of the same idea, kept working for projects that use it;
// `default` covers whichever targets aren't named.
export function resolveEntryPath(config, target, entryArg) {
  let entry = config?.entry;
  if (entry && typeof entry === 'object') entry = entry[target] ?? entry.default;
  const path = resolve(entryArg ?? entry ?? 'src/main.8bs');
  if (isVariantPath(path)) return path;
  const variant = variantOf(path, target);
  return existsSync(variant) ? variant : path;
}

/**
 * Compile one entry file for one target.
 *
 * @param {'vic20'|'c64'|'pet'|'c128'|'atari8'|'nes'|'cx16'|'mega65'|'web'} target
 * @param {string} [entryArg]
 * @param {{ pal?: boolean, profile?: string, hardware?: object, report?: boolean }} [options] `pal` selects the
 *   real hardware/emulator region (NTSC unless true; ignored outside
 *   REGION_TARGETS) — it does not affect the logical frame rate, which is
 *   read from 8bitscript.config.ts's `frameRate` instead (default 60). `profile`
 *   names a project profile or a catalog preset, `hardware` is option
 *   values set on top (`--hardware`); see hardware.mjs. `report` is
 *   `--size`: print the per-function breakdown and include it in the
 *   last-run JSON the editor's Running machines tree reads.
 * @returns {Promise<{ ok: boolean, outFile?: string, frameRate?: number, hardware?: object, memory?: object, sizeReport?: object[] }>}
 *   `hardware` is the resolved hardware the program was built for, for
 *   whoever runs it next. `memory` / `sizeReport` are what the last-run
 *   file and `--size` print; they are absent when the compile failed.
 */
export async function compile(target, entryArg, { pal = false, profile, hardware: overrides = {}, report = false } = {}) {
  const config = await loadConfig(process.cwd(), '8bs build');

  const frameRateResult = resolveFrameRate(config);
  if (!frameRateResult.ok) {
    process.stderr.write(`8bs build: ${frameRateResult.error}\n`);
    return { ok: false };
  }
  const { frameRate } = frameRateResult;

  // Nothing in a build reads the `systems` block, but a typo in one should
  // not wait for someone to open the editor to be noticed. Said once, and
  // not fatal: the build asked for is still the build to make.
  const systems = projectSystems(config);
  if (!systems.ok) process.stderr.write(`8bs build: ${systems.error}\n`);

  const retired = RETIRED_TARGET.exec(target ?? '');
  if (retired) {
    process.stderr.write(
      `8bs build: '${target}' is no longer a target. Use '${retired[1]}'` +
      `${retired[2] === 'pal' ? " with '--pal'" : ' (NTSC is the default)'} instead.\n`,
    );
    return { ok: false };
  }
  if (!TARGETS.has(target)) {
    process.stderr.write(
      `8bs build: unknown target '${target}'. Targets: ${[...TARGETS].join(', ')}\n`,
    );
    return { ok: false };
  }
  // A machine the language knows but this release does not build for. Its
  // package is still in the workspace, its twin files still resolve, and
  // `8bs check` still reads a program written for it; only producing a
  // binary waits for its backend (see RELEASE_MACHINES in the compiler).
  if (!RELEASE_MACHINES.includes(target)) {
    process.stderr.write(
      `8bs build: '${target}' is not a target in this release. 0.2.0 builds for ` +
      `${RELEASE_MACHINES.join(' and ')} only; the ${target} returns in a later release.\n`,
    );
    return { ok: false };
  }
  const listed = listedTargets(config);
  if (listed && !listed.includes(target)) {
    process.stderr.write(
      `8bs build: this project's 8bitscript.config.ts does not list '${target}' ` +
      `(targets: ${listed.join(', ')})\n`,
    );
    return { ok: false };
  }

  const resolved = resolveHardware(loadCatalog(target), {
    profile, overrides, profiles: projectProfiles(config, target), defaults: projectHardware(config, target),
  });
  if (!resolved.ok) {
    process.stderr.write(`8bs build: ${resolved.error}\n`);
    return { ok: false };
  }
  const { hardware } = resolved;

  // What the program needs of the machine, before the machine gets a
  // chance to disappoint it. A program that cannot run in the RAM it was
  // given fails at the linker with an overflow measured in bytes of
  // section; this says the same thing in the program's own terms, names
  // what it asked for, and — the useful half — what this machine could be
  // fitted with that would do.
  const required = projectRequires(config);
  if (!required.ok) {
    process.stderr.write(`8bs build: ${required.error}\n`);
    return { ok: false };
  }
  const unmet = unmetRequirements(required.requires, hardware.facts);
  if (unmet.length > 0) {
    const catalog = loadCatalog(target);
    process.stderr.write(
      `8bs build: this program asks for more than a ${hardware.label === 'stock' ? `stock ${target}` : `${target} with ${hardware.label}`} gives.\n`,
    );
    for (const { key, need, have } of unmet) {
      process.stderr.write(
        `  ${key}: needs ${need === true ? 'it' : need}, this build has ${have === true ? 'it' : have}\n`,
      );
      const fits = whatSatisfies(catalog, key, need, {
        profile, overrides, profiles: projectProfiles(config, target), defaults: projectHardware(config, target),
      });
      process.stderr.write(fits.length > 0
        ? `    fit one of: ${fits.join(', ')}  (--hardware, or a system in 8bitscript.config.ts)\n`
        : `    no ${target} can be fitted with that; this program is not for this machine\n`);
    }
    return { ok: false };
  }

  const entry = resolveEntryPath(config, target, entryArg);
  if (!existsSync(entry)) {
    process.stderr.write(`8bs build: entry ${entry} does not exist\n`);
    return { ok: false };
  }

  const text = await readFile(entry, 'utf8');

  // The linker runs the full front end over the entry and everything it
  // imports, then merges the graph into one program. Any error in any module
  // means no build. The machine rides along so packages with target-
  // conditional entries resolve to this machine's implementation, and the
  // hardware's facts so every `#fact(...)` — the sheet @8bitscript/system
  // declares — folds to this build's value, and the
  // hardware's tags so a file with a `.<machine>.<tag>.8bs` twin resolves
  // to that.
  const { ir, diagnostics, sources } = link(text, entry, { machine: target, tags: hardware.tags, facts: hardware.facts, frameRate });
  if (diagnostics.length > 0) {
    printDiagnostics(diagnostics, sources);
    process.stdout.write(`${diagnostics.length} problem(s); not building.\n`);
    return { ok: false };
  }

  // A target's own entry file is named after it (main.nes.8bs — see
  // resolveEntryPath); the output name carries the target once, in the
  // same place every other target's does, so main.nes.8bs builds to
  // main-nes.nes just as main.8bs does, not to main.nes-nes.nes.
  let stem = basename(entry, '.8bs');
  if (stem.endsWith(`.${target}`)) stem = stem.slice(0, -(target.length + 1));
  if (target === 'web') {
    const { build } = await import('@8bitscript/compiler/wasm');
    const outFile = resolve('dist', `${stem}.wasm`);
    const result = await build(ir, { outFile, frameRate, report });
    if (!result.ok) {
      process.stderr.write(`8bs build: ${result.error}\n`);
      return { ok: false };
    }
    const { writeWebBundle } = await import('./web-runtime.mjs');
    const webDir = resolve('dist', 'web');
    await writeWebBundle(webDir, await readFile(outFile), { frameRate });
    process.stdout.write(`built ${outFile}\n`);
    process.stdout.write(`web bundle: ${webDir}/\n`);
    process.stdout.write(`${memoryLine(ir.memory)}\n`);
    if (result.sizeReport) process.stdout.write(sizeReportLines(result.sizeReport, result.bytes.length));
    const memory = { variables: ir.memory.variables, program: result.bytes.length, data: ir.memory.data };
    await writeLastRun(target, compileReport(target, {
      outFile, hardware, memory, sizeReport: result.sizeReport, frameRate,
    }));
    return { ok: true, outFile, frameRate, hardware, webDir, memory, sizeReport: result.sizeReport };
  }

  const { build, outputExtension } = await import('@8bitscript/compiler/mos');
  // Hardware that changes the build is in the name (an 8032 PET, an
  // expanded VIC-20, an XEGS cartridge); hardware that only changes the
  // emulator is not, because the file is the same file.
  const nameParts = [stem, target, ...hardware.buildValues];
  if (REGION_TARGETS.has(target)) nameParts.push(pal ? 'pal' : 'ntsc');
  const ext = outputExtension(target, hardware);
  const outFile = resolve('dist', `${nameParts.join('-')}.${ext}`);
  const result = await build(ir, { machine: target, hardware, outFile, frameRate, report });
  if (!result.ok) {
    process.stderr.write(`8bs build: ${result.error}\n`);
    return { ok: false };
  }
  process.stdout.write(`built ${outFile}\n`);
  process.stdout.write(`${memoryLine(ir.memory, result.memory)}\n`);
  if (result.sizeReport) process.stdout.write(sizeReportLines(result.sizeReport, result.memory.program));
  await writeLastRun(target, compileReport(target, {
    outFile, hardware, memory: result.memory, sizeReport: result.sizeReport, frameRate,
  }));
  return { ok: true, outFile, frameRate, hardware, memory: result.memory, sizeReport: result.sizeReport };
}

/**
 * The memory line under "built": how much RAM the program's variables
 * take and how much constant data it carries. Measured from the
 * backend's size report when the build returns one (`memory.variables`
 * and `memory.program`), else as declared in the source. The machine's
 * own limit is the backend's: a program that does not fit does not
 * build, and the build says so.
 */
export function memoryLine(declared, measured = null) {
  if (measured) {
    return `memory: ${measured.variables} bytes of RAM for variables, ${measured.program} bytes of program (code and data)`;
  }
  return `memory: ${declared.variables} bytes of RAM for variables, ${declared.data} bytes of constant data (as declared)`;
}

/**
 * `--size`'s own breakdown, under the memory line: every function the
 * build actually compiled (dead ones are already gone — see
 * @8bitscript/compiler's own reachability pruning), inlined callees that
 * now live inside one of those, plus each backend's fixed-cost buckets
 * (wait-frame setup vs the per-frame routine, a module's own section
 * framing, …), largest first, with a percentage of `total` so a big
 * program's own worst offender is obvious without doing the division by
 * hand.
 */
export function sizeReportLines(entries, total) {
  const width = Math.max(...entries.map((e) => String(e.bytes).length));
  const lines = entries.map((e) => {
    const pct = total > 0 ? ((e.bytes / total) * 100).toFixed(1) : '0.0';
    return `  ${String(e.bytes).padStart(width)}  ${pct.padStart(5)}%  ${e.name}`;
  });
  return `size breakdown:\n${lines.join('\n')}\n`;
}

/**
 * `8bs build --release` — every artifact this project's config declares for
 * a release, in one command, instead of one CI step per artifact.
 *
 * The targets built are whatever `targets` in 8bitscript.config.ts lists
 * (or, with no `targets` block, every RELEASE_MACHINES target — pet and
 * web today), filtered to the ones this release actually builds for; a
 * parked machine listed there is silently skipped rather than failing the
 * whole release, the same way `8bs targets` marks it "parked" rather than
 * erroring.
 *
 * Each target builds once per entry in its own `release` array —
 * `targets.pet.release: ['2001', {}]`. A string names a preset or
 * project profile, resolved exactly like `--profile` (a catalog preset —
 * see `8bs targets` — or a name under `targets.pet.profiles`), so a name
 * that's wrong or unknown fails the same way `--profile` would. `{}` (or
 * a target with no `release` array at all) builds once with the target's
 * own default hardware (`targets.pet.hardware`) instead of a preset —
 * not the same thing: the '4032' catalog preset, for one, sets a speaker
 * option this project's own default hardware for that model may not.
 * `{ profile, hardware }` composes a preset/profile with `--hardware`-style
 * overrides on top, the same as passing both flags would.
 *
 * The output filenames don't collide: build.mjs already names hardware
 * that changes the build into the filename, so `2001` and this target's
 * own default land as two distinct .prg files without anything extra here.
 *
 * @param {{ report?: boolean }} [options]
 * @returns {Promise<number>} exit code
 */
async function buildRelease({ report = false } = {}) {
  const config = await loadConfig(process.cwd(), '8bs build');
  const listed = listedTargets(config);
  const machines = (listed ?? RELEASE_MACHINES).filter((m) => RELEASE_MACHINES.includes(m));
  if (machines.length === 0) {
    process.stderr.write(
      "8bs build --release: this project's 8bitscript.config.ts lists no target this release "
      + `builds for (${RELEASE_MACHINES.join(', ')})\n`,
    );
    return 1;
  }
  let ok = true;
  for (const target of machines) {
    const variants = Array.isArray(config?.targets?.[target]?.release)
      ? config.targets[target].release
      : [null];
    for (const variant of variants) {
      const profile = typeof variant === 'string' ? variant : variant?.profile;
      const hardware = (variant && typeof variant === 'object') ? (variant.hardware ?? {}) : {};
      const result = await compile(target, undefined, { profile, hardware, report });
      if (!result.ok) ok = false;
    }
  }
  return ok ? 0 : 1;
}

/** @returns {Promise<number>} exit code */
export async function build(args) {
  if (args.includes('--release')) return buildRelease({ report: args.includes('--size') });
  const pal = args.includes('--pal');
  const report = args.includes('--size');
  const targetIndex = args.indexOf('--target');
  const hw = hardwareArgs(args);
  if (!hw.ok) {
    process.stderr.write(`8bs build: ${hw.error}\n`);
    return 2;
  }
  const positionals = args.filter((a, i) => {
    if (targetIndex >= 0 && (i === targetIndex || i === targetIndex + 1)) return false;
    if (hw.consumed.has(i)) return false;
    return !a.startsWith('-');
  });
  const target = targetIndex >= 0 ? args[targetIndex + 1] : positionals[0];
  const entry = targetIndex >= 0 ? positionals[0] : positionals[1];

  if (!target) {
    process.stderr.write(
      'Usage: 8bs build --target <pet|web>\n'
      + '                 (vic20, c64, c128, atari8, nes, cx16, mega65 are parked until a later release)\n'
      + '                 [--pal] [--size]\n'
      + HARDWARE_USAGE
      + '                 [entry.8bs]\n',
    );
    return 2;
  }
  const { ok } = await compile(target, entry, { pal, profile: hw.profile, hardware: hw.overrides, report });
  return ok ? 0 : 1;
}
