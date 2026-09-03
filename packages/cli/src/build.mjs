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
// same as it already was for web.
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
// the project has one. Output lands in dist/, named
// <name>-<machine>[-<profile>][-<region>].<ext> — .prg for the Commodore/
// CX16/MEGA65 targets, .xex (or .rom for the xegs profile) for Atari 8-bit,
// .nes for the NES, .wasm for the web — with the generated C or
// AssemblyScript beside it so what the compiler did is never a mystery. A
// vic20/c64 profile only appears in the filename when it isn't the default
// (atari8's profile always does — see the comment beside nameParts below).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { link, positionAt } from '@8bitscript/compiler';

const TARGETS = new Set(['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web']);

// The targets whose frame-sync strategy has a real NTSC/PAL split, auto-
// detected at runtime (packages/backend-6502's FRAME_SYNC 'level' machines)
// — the only ones where --pal changes anything, or where a region suffix on
// the output filename means anything.
const REGION_TARGETS = new Set(['vic20', 'c64', 'c128', 'mega65', 'atari8']);

/**
 * The project's 8bs.config.ts, if present. Node 26 imports TypeScript with
 * type stripping, so the config is an ordinary module, not a parsed format.
 */
async function loadConfig(dir) {
  const path = join(dir, '8bs.config.ts');
  if (!existsSync(path)) return null;
  try {
    const module = await import(pathToFileURL(path).href);
    return module.default ?? null;
  } catch (error) {
    process.stderr.write(`8bs build: cannot load 8bs.config.ts: ${error.message}\n`);
    return null;
  }
}

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

// `entry` in 8bs.config.ts is usually one path shared by every target, the
// same way @8bitscript/machine resolves one package per target — but a
// project's *own* entry point can need to differ by target too, not just the
// hardware package it imports, when a target's execution model (called once
// forever vs. called once per frame) isn't something a shared source file
// can paper over. Keyed the same way "8bitscript".entry is, so the two
// mechanisms read alike; `default` covers whichever targets aren't named.
function resolveEntryPath(config, target) {
  const entry = config?.entry;
  if (entry && typeof entry === 'object') return entry[target] ?? entry.default;
  return entry;
}

/**
 * Compile one entry file for one target.
 *
 * @param {'vic20'|'c64'|'pet'|'c128'|'atari8'|'nes'|'cx16'|'mega65'|'web'} target
 * @param {string} [entryArg]
 * @param {{ pal?: boolean, profile?: string }} [options] NTSC (60Hz) unless
 *   pal is true; ignored outside REGION_TARGETS. `profile` only matters for
 *   atari8 (defaults to 800xl), vic20 (defaults to unexpanded), and c64
 *   (defaults to stock); ignored elsewhere.
 * @returns {Promise<{ ok: boolean, outFile?: string }>}
 */
export async function compile(target, entryArg, { pal = false, profile } = {}) {
  const config = await loadConfig(process.cwd());

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

  const entry = resolve(entryArg ?? resolveEntryPath(config, target) ?? 'src/main.8bs');
  if (!existsSync(entry)) {
    process.stderr.write(`8bs build: entry ${entry} does not exist\n`);
    return { ok: false };
  }

  const text = await readFile(entry, 'utf8');

  // The linker runs the full front end over the entry and everything it
  // imports, then merges the graph into one program. Any error in any module
  // means no build. The machine rides along so packages with target-
  // conditional entries resolve to this machine's implementation.
  const { ir, diagnostics, sources } = link(text, entry, { machine: target });
  if (diagnostics.length > 0) {
    printDiagnostics(diagnostics, sources);
    process.stdout.write(`${diagnostics.length} problem(s); not building.\n`);
    return { ok: false };
  }

  const stem = basename(entry, '.8bs');
  if (target === 'web') {
    const { buildWasm } = await import('@8bitscript/backend-web');
    const outFile = resolve('dist', `${stem}.wasm`);
    const result = await buildWasm(ir, { outFile });
    if (!result.ok) {
      process.stderr.write(`8bs build: ${result.error}\n`);
      return { ok: false };
    }
    process.stdout.write(`built ${outFile}\n(generated AssemblyScript: ${result.asFile})\n`);
    return { ok: true, outFile };
  }

  const { buildPrg, outputExtension } = await import('@8bitscript/backend-6502');
  // A per-target entry (config.entry keyed by machine — see
  // resolveEntryPath above) is commonly named after its target already
  // (main-atari8.8bs, say, for a target whose execution model needs its own
  // entry file); skip the redundant second copy of the target name that
  // would otherwise produce main-atari8-atari8-....xex.
  const nameParts = stem.endsWith(`-${target}`) ? [stem] : [stem, target];
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
    machine: target, atari8Profile, vic20Profile, c64Profile, outFile,
  });
  if (!result.ok) {
    process.stderr.write(`8bs build: ${result.error}\n`);
    return { ok: false };
  }
  process.stdout.write(`built ${outFile}\n(generated C: ${result.cFile})\n`);
  return { ok: true, outFile };
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
