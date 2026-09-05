// `8bs build` — compile a program for a target.
//
//     8bs build --target vic20        [entry.8bs]   NTSC (60Hz), the default
//     8bs build --target vic20 --pal  [entry.8bs]
//     8bs build --target web          [entry.8bs]
//     8bs build --target atari8 --profile 130xe [entry.8bs]
//     8bs build --target vic20 --profile 16k    [entry.8bs]
//     8bs build --target c64 --profile reu512   [entry.8bs]
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
// --profile picks a hardware profile — a named bundle of settings for
// hardware that composes on top of the base target, same idea for every
// target that has one, different meaning per target because the hardware
// itself differs:
//
//   atari8: which machine in the 400/800/XL/XE/XEGS family (default 800XL,
//     see docs/setup) — one target because LLVM-MOS itself treats that
//     whole lineage as one family that only varies output format.
//   vic20: how much RAM-expansion cartridge is plugged in — unexpanded
//     (default, 3583 bytes free, the machine as sold), 3k/8k/16k/24k, the
//     same five configurations VICE's `xvic -memory` and the SDK's own
//     link.ld both recognize (see VIC20_PROFILES in backend-6502).
//   c64: whether a RAM Expansion Unit is attached — stock (default, no
//     REU) or reu128/256/512/1m/2m/4m/8m/16m, VICE's own `-reusize` values
//     (see @8bitscript/c64's `reu` namespace for the register-level API).
//
// The entry defaults to src/main.8bs, or to the `entry` in 8bs.config.ts when
// the project has one — and whichever file that names, a `.<target>.8bs`
// twin beside it (main.nes.8bs next to main.8bs) is what a build for that
// target actually starts from; see resolveEntryPath. Output lands in dist/, named
// <name>-<machine>[-<profile>][-<region>].<ext> — .prg for the Commodore/
// CX16/MEGA65 targets, .xex (or .rom for the xegs profile) for Atari 8-bit,
// .nes for the NES, .wasm for the web — with the generated C or
// AssemblyScript beside it so what the compiler did is never a mystery. A
// vic20/c64 profile only appears in the filename when it isn't the default
// (atari8's profile always does — see the comment beside nameParts below).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
  MACHINES, isVariantPath, link, positionAt, variantOf,
} from '@8bitscript/compiler';

import { loadConfig, resolveFrameRate } from './config.mjs';

const TARGETS = new Set(MACHINES);

// The targets whose frame-sync strategy has a real NTSC/PAL split, auto-
// detected at runtime (packages/backend-6502's FRAME_SYNC 'level' machines)
// — the only ones where --pal changes anything, or where a region suffix on
// the output filename means anything.
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
 * @param {{ pal?: boolean, profile?: string }} [options] `pal` selects the
 *   real hardware/emulator region (NTSC unless true; ignored outside
 *   REGION_TARGETS) — it does not affect the logical frame rate, which is
 *   read from 8bs.config.ts's `frameRate` instead (default 60). `profile`
 *   only matters for atari8 (defaults to 800xl), vic20 (defaults to
 *   unexpanded), and c64 (defaults to stock); ignored elsewhere.
 * @returns {Promise<{ ok: boolean, outFile?: string, frameRate?: number }>}
 */
export async function compile(target, entryArg, { pal = false, profile } = {}) {
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
  if (config?.targets && !config.targets.includes(target)) {
    process.stderr.write(
      `8bs build: this project's 8bs.config.ts does not list '${target}' ` +
      `(targets: ${config.targets.join(', ')})\n`,
    );
    return { ok: false };
  }

  const {
    ATARI8_PROFILES, ATARI8_DEFAULT_PROFILE,
    VIC20_PROFILES, VIC20_DEFAULT_PROFILE,
    C64_PROFILES, C64_DEFAULT_PROFILE,
  } = await import('@8bitscript/backend-6502');
  const atari8Profile = target === 'atari8' ? (profile ?? ATARI8_DEFAULT_PROFILE) : undefined;
  if (target === 'atari8' && !ATARI8_PROFILES.has(atari8Profile)) {
    process.stderr.write(
      `8bs build: unknown atari8 profile '${atari8Profile}'. Profiles: ${[...ATARI8_PROFILES].join(', ')}\n`,
    );
    return { ok: false };
  }
  const vic20Profile = target === 'vic20' ? (profile ?? VIC20_DEFAULT_PROFILE) : undefined;
  if (target === 'vic20' && !VIC20_PROFILES.has(vic20Profile)) {
    process.stderr.write(
      `8bs build: unknown vic20 profile '${vic20Profile}'. Profiles: ${[...VIC20_PROFILES].join(', ')}\n`,
    );
    return { ok: false };
  }
  const c64Profile = target === 'c64' ? (profile ?? C64_DEFAULT_PROFILE) : undefined;
  if (target === 'c64' && !C64_PROFILES.has(c64Profile)) {
    process.stderr.write(
      `8bs build: unknown c64 profile '${c64Profile}'. Profiles: ${[...C64_PROFILES].join(', ')}\n`,
    );
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
  // conditional entries resolve to this machine's implementation.
  const { ir, diagnostics, sources } = link(text, entry, { machine: target, frameRate });
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
    return { ok: true, outFile, frameRate };
  }

  const { buildPrg, outputExtension } = await import('@8bitscript/backend-6502');
  const nameParts = [stem, target];
  if (target === 'atari8') nameParts.push(atari8Profile);
  // Unlike atari8 (whose profile is always in the filename, even the
  // default 800xl), vic20/c64 only grow a profile suffix for a non-default
  // profile — most builds are the stock machine, and changing every
  // existing main-vic20-ntsc.prg/main-c64-ntsc.prg filename for a feature
  // most projects never touch was not worth it.
  if (target === 'vic20' && vic20Profile !== VIC20_DEFAULT_PROFILE) nameParts.push(vic20Profile);
  if (target === 'c64' && c64Profile !== C64_DEFAULT_PROFILE) nameParts.push(c64Profile);
  if (REGION_TARGETS.has(target)) nameParts.push(pal ? 'pal' : 'ntsc');
  const ext = outputExtension(target, atari8Profile);
  const outFile = resolve('dist', `${nameParts.join('-')}.${ext}`);
  const result = await buildPrg(ir, {
    machine: target, atari8Profile, vic20Profile, c64Profile, outFile, frameRate,
  });
  if (!result.ok) {
    process.stderr.write(`8bs build: ${result.error}\n`);
    return { ok: false };
  }
  process.stdout.write(`built ${outFile}\n(generated C: ${result.cFile})\n`);
  return { ok: true, outFile, frameRate };
}

/** @returns {Promise<number>} exit code */
export async function build(args) {
  const pal = args.includes('--pal');
  const targetIndex = args.indexOf('--target');
  const profileIndex = args.indexOf('--profile');
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined;
  const positionals = args.filter((a, i) => {
    if (targetIndex >= 0 && (i === targetIndex || i === targetIndex + 1)) return false;
    if (profileIndex >= 0 && (i === profileIndex || i === profileIndex + 1)) return false;
    return !a.startsWith('-');
  });
  const target = targetIndex >= 0 ? args[targetIndex + 1] : positionals[0];
  const entry = targetIndex >= 0 ? positionals[0] : positionals[1];

  if (!target) {
    process.stderr.write(
      'Usage: 8bs build --target <vic20|c64|pet|c128|atari8|nes|cx16|mega65|web>\n'
      + '                 [--pal]\n'
      + '                 [--profile <800xl|65xe|130xe|800|400|xegs>]        (atari8)\n'
      + '                 [--profile <unexpanded|3k|8k|16k|24k>]             (vic20)\n'
      + '                 [--profile <stock|reu128|reu256|reu512|reu1m|reu2m|reu4m|reu8m|reu16m>] (c64)\n'
      + '                 [entry.8bs]\n',
    );
    return 2;
  }
  const { ok } = await compile(target, entry, { pal, profile });
  return ok ? 0 : 1;
}
