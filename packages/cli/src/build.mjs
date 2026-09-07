// `8bs build` — compile a program for a target.
//
//     8bs build --target vic20        [entry.8bs]   NTSC (60Hz), the default
//     8bs build --target vic20 --pal  [entry.8bs]
//     8bs build --target web          [entry.8bs]
//     8bs build --target atari8 --profile 130xe [entry.8bs]
//     8bs build --target vic20 --profile 16k    [entry.8bs]
//     8bs build --target c64 --profile reu512   [entry.8bs]
//     8bs build --target pet --profile 8032     [entry.8bs]   80 columns, 32K
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
// separate, project-level setting (`frameRate` in 8bs.config.ts, default 60,
// see packages/backend-6502's FRAME_SYNC and examples/borders/README.md),
// unaffected by --pal.
//
// --profile names the hardware the build is for: a preset from the
// machine package's catalog (`8032`, `130xe`, `reu512` — the community's
// names for whole configurations) or a profile the project composes in
// its 8bs.config.ts (`targets: { c64: { profiles: { loaded: { ram:
// 'reu512', port1: 'mouse1351' } } } }`). --hardware option=value,...
// sets single options on top of either. What each option changes — a
// link symbol, a driver, an emulator flag, a fact a program can read — is
// the catalog's to say; see packages/cli/src/hardware.mjs and
// docs/systems.md. `8bs targets` lists every option and preset.
//
// The entry defaults to src/main.8bs, or to the `entry` in 8bs.config.ts when
// the project has one — and whichever file that names, a `.<target>.8bs`
// twin beside it (main.nes.8bs next to main.8bs) is what a build for that
// target actually starts from; see resolveEntryPath. Output lands in dist/, named
// <name>-<machine>[-<hardware>...][-<region>].<ext> — .prg for the Commodore/
// CX16/MEGA65 targets, .xex (or .rom for an XEGS cartridge) for Atari 8-bit,
// .nes for the NES, .wasm for the web — with the generated C or
// AssemblyScript beside it so what the compiler did is never a mystery.
// Only hardware that changes the *build* is in the name (a PET's model, a
// VIC-20's RAM): a mouse or a REU makes the same program, so it is not.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
  MACHINES, isVariantPath, link, positionAt, variantOf,
} from '@8bitscript/compiler';

import { loadConfig, resolveFrameRate } from './config.mjs';
import {
  HARDWARE_USAGE, hardwareArgs, listedTargets, loadCatalog, projectHardware, projectProfiles, resolveHardware,
} from './hardware.mjs';

const TARGETS = new Set(MACHINES);

// The targets whose frame-sync strategy has a real NTSC/PAL split, auto-
// detected at runtime (packages/backend-6502's FRAME_SYNC 'level' machines)
// — the only ones where --pal changes the build or a region suffix on the
// output filename. The PET has no region at all: its refresh is the
// model's (a hardware option — see packages/pet/package.json's catalog),
// FRAME_SYNC.pet measures it at start-up, and `8bs run pet` says so if
// given --pal.
const REGION_TARGETS = new Set(['vic20', 'c64', 'c128', 'mega65', 'atari8']);

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

// `entry` in 8bs.config.ts is one path, shared by every target, and the
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
 * @param {{ pal?: boolean, profile?: string, hardware?: object }} [options] `pal` selects the
 *   real hardware/emulator region (NTSC unless true; ignored outside
 *   REGION_TARGETS) — it does not affect the logical frame rate, which is
 *   read from 8bs.config.ts's `frameRate` instead (default 60). `profile`
 *   names a project profile or a catalog preset, `hardware` is option
 *   values set on top (`--hardware`); see hardware.mjs.
 * @returns {Promise<{ ok: boolean, outFile?: string, frameRate?: number, hardware?: object }>}
 *   `hardware` is the resolved hardware the program was built for, for
 *   whoever runs it next.
 */
export async function compile(target, entryArg, { pal = false, profile, hardware: overrides = {} } = {}) {
  const config = await loadConfig(process.cwd(), '8bs build');

  const frameRateResult = resolveFrameRate(config);
  if (!frameRateResult.ok) {
    process.stderr.write(`8bs build: ${frameRateResult.error}\n`);
    return { ok: false };
  }
  const { frameRate } = frameRateResult;

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
  const listed = listedTargets(config);
  if (listed && !listed.includes(target)) {
    process.stderr.write(
      `8bs build: this project's 8bs.config.ts does not list '${target}' ` +
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
    const { buildWasm } = await import('@8bitscript/backend-web');
    const outFile = resolve('dist', `${stem}.wasm`);
    const result = await buildWasm(ir, { outFile });
    if (!result.ok) {
      process.stderr.write(`8bs build: ${result.error}\n`);
      return { ok: false };
    }
    process.stdout.write(`built ${outFile}\n(generated AssemblyScript: ${result.asFile})\n`);
    process.stdout.write(`${memoryLine(ir.memory)}\n`);
    return { ok: true, outFile, frameRate, hardware };
  }

  const { buildPrg, outputExtension } = await import('@8bitscript/backend-6502');
  // Hardware that changes the build is in the name (an 8032 PET, an
  // expanded VIC-20, an XEGS cartridge); hardware that only changes the
  // emulator is not, because the file is the same file.
  const nameParts = [stem, target, ...hardware.buildValues];
  if (REGION_TARGETS.has(target)) nameParts.push(pal ? 'pal' : 'ntsc');
  const ext = outputExtension(target, hardware);
  const outFile = resolve('dist', `${nameParts.join('-')}.${ext}`);
  const result = await buildPrg(ir, { machine: target, hardware, outFile, frameRate });
  if (!result.ok) {
    process.stderr.write(`8bs build: ${result.error}\n`);
    return { ok: false };
  }
  process.stdout.write(`built ${outFile}\n(generated C: ${result.cFile})\n`);
  process.stdout.write(`${memoryLine(ir.memory, result.memory)}\n`);
  return { ok: true, outFile, frameRate, hardware };
}

/**
 * The memory line under "built": how much RAM the program's variables
 * take and how much constant data it carries. Measured from the linked
 * program when the backend could (the 6502 backend reads the ELF; a
 * variable LLVM dropped for being unread is not counted), else as
 * declared in the source. The machine's own limit is the toolchain's:
 * a program that does not fit does not build, and the build says so.
 */
export function memoryLine(declared, measured = null) {
  if (measured) {
    return `memory: ${measured.variables} bytes of RAM for variables, ${measured.program} bytes of program (code and data)`;
  }
  return `memory: ${declared.variables} bytes of RAM for variables, ${declared.data} bytes of constant data (as declared)`;
}

/** @returns {Promise<number>} exit code */
export async function build(args) {
  const pal = args.includes('--pal');
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
      'Usage: 8bs build --target <vic20|c64|pet|c128|atari8|nes|cx16|mega65|web>\n'
      + '                 [--pal]\n'
      + HARDWARE_USAGE
      + '                 [entry.8bs]\n',
    );
    return 2;
  }
  const { ok } = await compile(target, entry, { pal, profile: hw.profile, hardware: hw.overrides });
  return ok ? 0 : 1;
}
