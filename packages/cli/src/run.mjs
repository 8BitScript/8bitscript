// `8bs run <target>` — build, then actually run the program.
//
//   8bs run vic20        builds the .prg and opens it in the VICE VIC-20
//                        emulator, machine model NTSC (60fps) — the default
//   8bs run vic20 --pal  the same, machine model PAL (50fps)
//   8bs run c64          the same idea, in the C64 emulator (NTSC default)
//   8bs run c64 --pal
//   8bs run pet          builds the .prg and opens it in VICE's PET emulator
//                        (xpet) as the model the hardware names — a 3032 by
//                        default: no CRTC, 40 columns, 32K, VICE's hardcoded
//                        ~60.1Hz. --profile 8032 builds for and launches the
//                        80-column business machine, 3008/3016/4016/4032 the
//                        other RAM sizes and series (the `model` option in
//                        packages/pet's catalog). There is no --pal for the
//                        PET: its refresh is the model's (the CRTC models
//                        run their 50Hz editor ROMs; the 60Hz ones make VICE
//                        refuse autostart), and the program measures the
//                        actual frame period at runtime (FRAME_SYNC.pet).
//   8bs run c128         VICE's C128 emulator (x128), NTSC default, --pal
//   8bs run atari8       builds for the default 800XL and opens it in
//                        atari800; --profile picks another machine in the
//                        family (130xe, xegs, ...), --pal/--ntsc the TV
//                        standard (NTSC default)
//   8bs run vic20 --profile 16k   builds for a 16K-expanded VIC-20 and
//                        passes xvic the matching `-memory` flag, so the
//                        emulated machine's RAM matches what the program
//                        was linked for
//   8bs run c64 --hardware ram=reu512,port1=mouse1351
//                        builds for the stock C64 (neither changes the
//                        memory map) and fits x64sc a 512K REU and a 1351
//                        in port 1 — every option, and what each does, is
//                        the machine package's catalog (`8bs targets`)
//   8bs run nes          builds the .nes and opens it in FCEUX
//   8bs run cx16          builds the .prg and opens it in x16emu
//   8bs run mega65        builds the .prg and opens it in Xemu's MEGA65
//                        core (xmega65) with -prg, which autoloads and RUNs
//                        it in MEGA65 mode ($2001 load address; a c64-target
//                        .prg would go to C64 mode) — verified on screen,
//                        see packages/mega65/AGENTS.md
//   8bs run web          builds the .wasm and opens it in the browser
//                        runtime (web-runtime.mjs): the program runs in a
//                        worker, its waitFrame() paced by the page's frame
//                        clock, the page painting its screen memory — the
//                        same for every program, whether it loops on
//                        waitFrame(), returns, or spins
//   8bs run web --no-open  the same, without spawning a browser window —
//                        for pasting the printed URL into an editor's own
//                        browser (e.g. VS Code/Cursor's "Simple Browser:
//                        Show" command), which no CLI can open unattended:
//                        that command only exists inside the editor, with
//                        no terminal-invokable equivalent
//
// `8bs boot <target>` (below `run`'s own exports) is the hardware-only
// sibling: the same emulator, the same --pal/--profile/--hardware fitting,
// but nothing loaded into it — a stock (or fitted) machine booting to
// whatever it boots to on its own, no build and no project required.
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { compile } from './build.mjs';
import { HARDWARE_USAGE, hardwareArgs, loadArgs } from './hardware.mjs';
import { hardwareSnapshot, writeLastRun } from './last-run.mjs';

// The VICE family (vic20/c64/pet/c128): one emulator suite, one invocation
// shape — -autostart injects the built file straight into RAM. Exported so
// screenshot.mjs's --screenshot path (8bs run <target> --screenshot <file>)
// can drive the same emulators/flags rather than keeping a second copy that
// could drift from this one.
export const VICE_EMULATOR = { vic20: 'xvic', c64: 'x64sc', pet: 'xpet', c128: 'x128' };

// Flags the emulator needs to run our .prg files. The emulated machine must
// match the memory layout the program was linked for: 8BitScript's vic20
// target is the UNEXPANDED VIC-20 ($1001), which is also xvic's stock
// configuration, so no memory flag is needed — but if the backend's
// __memory_expansion pin ever changes, this table must change with it, or
// autostart injects the program at the wrong address and silently never runs
// it. RAM injection (-autostartprgmode 1) skips the emulated disk load. The
// PET's __ram_size pin (32K) is likewise xpet's own stock default, so it
// needs no matching flag either.
// x128 alone among these drives two physical displays — the VIC-IIe (40-
// column, what this target's screen/border/background all actually reach)
// and the 80-column VDC, which this target never touches. Without
// -hidevdcwindow, x128 opens a second window for it anyway, showing
// whatever the VDC's power-on RAM happens to contain (typically a plain
// black screen) alongside the real output — not a second copy of the
// program, just an unused second monitor the hardware genuinely has.
export const VICE_EMULATOR_ARGS = {
  vic20: ['-autostartprgmode', '1'],
  c64: ['-autostartprgmode', '1'],
  pet: ['-autostartprgmode', '1'],
  c128: ['-autostartprgmode', '1', '-hidevdcwindow'],
};
// -ntsc/-pal only flip VICE's sync factor (raster timing): the screen-origin
// registers the KERNAL sets up at boot stay wired to whichever machine model
// is loaded, so -ntsc alone can pair NTSC timing with PAL geometry and the
// picture renders off-center. -model switches the whole machine (ROM set,
// VIC-II/VIC geometry, and timing together), which is why vic20/c64/c128
// name a model rather than a sync-factor flag. Verified against `x128 -help`
// ("Set C128 model (c128/c128dcr, pal/ntsc)").
//
// The PET is not in this table: its refresh is not a sync factor but the
// model's, and the model is a hardware option — see PET_REGION_NOTE below.
export const VICE_MODEL_ARGS = {
  vic20: { ntsc: ['-model', 'vic20ntsc'], pal: ['-model', 'vic20pal'] },
  c64: { ntsc: ['-model', 'ntsc'], pal: ['-model', 'c64'] },
  c128: { ntsc: ['-model', 'ntsc'], pal: ['-model', 'pal'] },
};

// The PET's model is a hardware option (packages/pet's catalog: `-model`
// to xpet, `__ram_size` to the linker, the columns as a fact). No
// `-ntsc`/`-pal` goes with it. VICE's own pet.h: 50Hz vs 60Hz on a PET is
// which editor ROM programs the CRTC, not a sync factor. The 60Hz editor
// ROMs VICE ships (`edit-4-*-60Hz*`) do switch the CRTC to ~60Hz, but
// they also make VICE refuse autostart ("Autostart is not available on
// this setup") — observed with both the 40-column and 80-column 60Hz
// editors, with and without `-default` — so the CRTC models (4016, 4032,
// 8032) run their stock 50Hz editors here, measured at 49.92-50.02Hz, and
// the no-CRTC 3xxx models run at VICE's hardcoded ~60.1Hz. The program
// measures whichever it gets at start-up (FRAME_SYNC.pet), so the build is
// the same either way; `8bs run pet --pal` prints a note and changes
// nothing. Verified with `xpet -verbose -limitcycles` and by whether
// `-autostart` of a built `.prg` stays running.
export const PET_REGION_NOTE = '8bs run: the PET has no --pal/--ntsc — its refresh rate is the model\'s. '
  + 'Pick a model with --profile (3032 is ~60Hz; 4016, 4032 and 8032 are 50Hz).\n';

// How each emulator is handed the built file when the hardware does not
// say otherwise (a catalog value's `load` — the Atari XEGS cartridge —
// overrides this; see hardware.mjs's loadArgs).
export const DEFAULT_LOAD = {
  xvic: (out) => ['-autostart', out],
  x64sc: (out) => ['-autostart', out],
  xpet: (out) => ['-autostart', out],
  x128: (out) => ['-autostart', out],
  atari800: (out) => ['-run', out],
  fceux: (out) => [out],
  x16emu: (out) => ['-prg', out, '-run'],
  xmega65: (out) => ['-prg', out],
};

// atari800's SDL2 OpenGL shader (atari800-shader.frag) defaults
// CRT_BEAM_SHAPE=10, which spreads each emulated pixel with a Gaussian
// falloff — visible as dark vertical stripes across the whole frame,
// border included, on top of the ordinary horizontal scanline overlay.
// There is no CLI flag for that uniform (only SCANLINES_PERCENTAGE has
// `-scanlines`), so `8bs run` copies the user's ~/.atari800.cfg, zeros
// the CRT knobs, and points `-config` at a *per-process* copy with
// `-no-autosave-config` so the user's own file is left alone. The path
// includes the pid because `pnpm test` runs atari8 screenshot tests in
// parallel (banks vs layers, and other packages' emulators at the same
// time): a shared `8bs-atari800.cfg` is two writers and two atari800s
// reading one file. ROM paths stay whatever the user already configured;
// without those the emulator boots to black.
export async function atari800CleanDisplayConfig() {
  let cfg;
  try {
    cfg = await readFile(join(homedir(), '.atari800.cfg'), 'utf8');
  } catch {
    return null;
  }
  const setKey = (text, key, value) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) return text.replace(re, `${key}=${value}`);
    return `${text.trimEnd()}\n${key}=${value}\n`;
  };
  cfg = setKey(cfg, 'CRT_BEAM_SHAPE', '0');
  cfg = setKey(cfg, 'CRT_PHOSPHOR_GLOW', '0');
  cfg = setKey(cfg, 'SCANLINES_PERCENTAGE', '0');
  cfg = setKey(cfg, 'INTERPOLATE_SCANLINES', '0');
  const outPath = join(tmpdir(), `8bs-atari800-${process.pid}.cfg`);
  await writeFile(outPath, cfg);
  return outPath;
}

/**
 * The emulator and its arguments for one target, hardware selection, and
 * region — shared by `run()` (which passes `outFile` so something loads
 * into it) and `boot()` (which leaves `outFile` out, so nothing does).
 * Everything about *which* machine this is (model, RAM, a REU, a mouse, TV
 * standard) comes from `hardware`/`pal` alone; whether anything gets
 * loaded into it is entirely the caller's own choice.
 *
 * @param {string} target
 * @param {{ pal: boolean, hardware: object, outFile?: string }} options
 * @returns {Promise<{ ok: true, emulator: string, emulatorArgs: string[] } | { ok: false, error: string }>}
 */
export async function emulatorInvocation(target, { pal, hardware, outFile }) {
  const region = pal ? 'pal' : 'ntsc';
  // Nothing to load into: every load-args call below is skipped outright
  // when there is no outFile, rather than asked to load nothing — each
  // emulator's own DEFAULT_LOAD template calls `out.replaceAll(...)` (or
  // similar) on its argument, which `undefined` cannot take.
  const load = (emulator, fallback) => (outFile ? loadArgs(hardware, emulator, outFile, fallback(outFile)) : []);

  // The emulator's own flags for the machine, then whatever the hardware
  // fits (the catalog's `run` list for this emulator), then the file, if
  // there is one to load.
  if (target in VICE_EMULATOR) {
    const emulator = VICE_EMULATOR[target];
    return {
      ok: true,
      emulator,
      emulatorArgs: [
        ...(VICE_EMULATOR_ARGS[target] ?? []),
        ...(VICE_MODEL_ARGS[target]?.[region] ?? []),
        ...(hardware.run[emulator] ?? []),
        // Skip the "really quit?" confirmation dialog — closing the
        // emulator window during dev/test cycles should not need a click
        // every time.
        '+confirmonexit',
        ...load(emulator, DEFAULT_LOAD[emulator]),
      ],
    };
  }
  if (target === 'atari8') {
    // atari800's TV-area visible size (DOC/USAGE -horiz-area/-vert-area):
    // 336 wide, 224 tall on NTSC and 240 tall on PAL. The emulator opens
    // at 1x of that — a postage stamp on any modern display — and unlike
    // VICE it has no larger default of its own. 3x is a window worth
    // looking at on a 1080p screen and still an exact integer scale, which
    // is what atari800's own default INTEGRAL stretch wants: a non-multiple
    // just letterboxes the same small image inside a bigger window.
    const tvHeight = pal ? 240 : 224;
    const displayCfg = await atari800CleanDisplayConfig();
    return {
      ok: true,
      emulator: 'atari800',
      emulatorArgs: [
        ...(displayCfg ? ['-config', displayCfg, '-no-autosave-config'] : []),
        ...(hardware.run.atari800 ?? []),
        pal ? '-pal' : '-ntsc',
        '-horiz-area', 'tv',
        '-vert-area', 'tv',
        '-stretch', 'integral',
        '-scanlines', '0',
        '-win-width', String(336 * 3),
        '-win-height', String(tvHeight * 3),
        ...load('atari800', DEFAULT_LOAD.atari800),
      ],
    };
  }
  if (target === 'nes') {
    return { ok: true, emulator: 'fceux', emulatorArgs: [...(hardware.run.fceux ?? []), ...load('fceux', DEFAULT_LOAD.fceux)] };
  }
  if (target === 'cx16') {
    // Confirmed against the X16Community/x16-emulator README.
    return { ok: true, emulator: 'x16emu', emulatorArgs: [...(hardware.run.x16emu ?? []), ...load('x16emu', DEFAULT_LOAD.x16emu)] };
  }
  if (target === 'mega65') {
    // -videostd pins the video standard to match the region the .prg was
    // built for (0=PAL, 1=NTSC); left unset, Xemu's Hyppo default is PAL
    // regardless of which region this target compiled for, so an NTSC
    // build gets PAL's ~100 extra scanlines of VIC-IV border/overscan — the
    // exact off-geometry mismatch VICE_MODEL_ARGS above documents for
    // -ntsc/-pal not implying a model.
    return {
      ok: true,
      emulator: 'xmega65',
      emulatorArgs: [...(hardware.run.xmega65 ?? []), ...load('xmega65', DEFAULT_LOAD.xmega65), '-videostd', pal ? '0' : '1'],
    };
  }
  // Every caller already validated the target against the same set this
  // function branches over (build()'s TARGETS via compile(), or boot()'s
  // own check for the one target — web — that has no bare emulator at all),
  // so this is unreachable.
  return { ok: false, error: `no emulator wired up for target '${target}'` };
}

/** Spawns `emulator`, streaming its own stdio, and resolves once its window closes. */
async function spawnEmulator(emulator, emulatorArgs) {
  process.stdout.write(`starting ${emulator}; close the emulator window to finish.\n`);
  const { spawn } = await import('node:child_process');
  return new Promise((resolvePromise) => {
    const child = spawn(emulator, emulatorArgs, { stdio: 'inherit' });
    child.on('error', () => {
      process.stderr.write(`cannot start ${emulator}. Run '8bs doctor' — docs/setup/index.md\n`);
      resolvePromise(1);
    });
    child.on('close', (code) => resolvePromise(code === 0 ? 0 : 0));
  });
}

/** @returns {Promise<number>} exit code */
export async function run(args) {
  const pal = args.includes('--pal');
  const open = !args.includes('--no-open');
  const report = args.includes('--size');
  const hw = hardwareArgs(args);
  if (!hw.ok) {
    process.stderr.write(`8bs run: ${hw.error}\n`);
    return 2;
  }
  const screenshotIndex = args.indexOf('--screenshot');
  const screenshotPath = screenshotIndex >= 0 ? resolve(args[screenshotIndex + 1]) : undefined;
  const framesIndex = args.indexOf('--frames');
  const framesArg = framesIndex >= 0 ? args[framesIndex + 1] : undefined;
  const frames = framesArg !== undefined ? Number.parseInt(framesArg, 10) : undefined;
  if (framesArg !== undefined && !Number.isFinite(frames)) {
    process.stderr.write(`8bs run: --frames expects a number, got '${framesArg}'\n`);
    return 2;
  }
  const consumed = new Set([
    ...hw.consumed,
    ...[screenshotIndex, framesIndex].flatMap((i) => (i >= 0 ? [i, i + 1] : [])),
  ]);
  const positionals = args.filter((a, i) => !consumed.has(i) && !a.startsWith('-'));
  const target = positionals[0];
  if (!target) {
    process.stderr.write(
      'Usage: 8bs run <pet|web>\n'
      + '                (vic20, c64, c128, atari8, nes, cx16, mega65 are parked until a later release)\n'
      + '                [--pal]\n'
      + HARDWARE_USAGE
      + '                [--size] [--no-open] [entry.8bs]\n'
      + '                [--screenshot <file.png>] [--frames <n>]\n'
      + '                  capture one screenshot through the target\'s own\n'
      + '                  emulator API instead of opening an interactive\n'
      + '                  window — see docs/setup/verify.md#screenshots for\n'
      + '                  what --frames counts on each target\n',
    );
    return 2;
  }
  const entry = positionals[1];

  // Said once, before either route — the PET has no region (PET_REGION_NOTE).
  if (target === 'pet' && pal) process.stderr.write(PET_REGION_NOTE);

  const { ok, outFile, frameRate, hardware } = await compile(target, entry, {
    pal, profile: hw.profile, hardware: hw.overrides, report,
  });
  if (!ok) return 1;

  if (screenshotPath) {
    const { captureScreenshot } = await import('./screenshot.mjs');
    try {
      await captureScreenshot(target, outFile, screenshotPath, {
        pal, hardware, frames, frameRate,
      });
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    process.stdout.write(`wrote ${screenshotPath}\n`);
    return 0;
  }

  if (target === 'web') {
    // Every program runs the same way on the web: in the browser runtime's
    // worker (web-runtime.mjs), whether it loops on waitFrame(), returns, or
    // spins. Headless execution is `--screenshot`'s job, bounded by --frames.
    const { runInBrowser } = await import('./web-runtime.mjs');
    const bytes = await readFile(outFile);
    return runInBrowser(bytes, {
      open, frameRate, root: resolve('dist', 'web'), lastRunTarget: 'web',
    });
  }

  const invocation = await emulatorInvocation(target, { pal, hardware, outFile });
  if (!invocation.ok) {
    process.stderr.write(`8bs run: ${invocation.error}\n`);
    return 1;
  }
  await writeLastRun(target, { emulator: invocation.emulator });
  return spawnEmulator(invocation.emulator, invocation.emulatorArgs);
}

/**
 * `8bs boot <target>` — opens the target's own emulator fitted with
 * whatever `--pal`/`--profile`/`--hardware` name, exactly as `8bs run`
 * would fit it, but loads nothing into it: a stock (or fitted) machine
 * booting to whatever it boots to on its own — BASIC's READY. prompt on
 * the Commodore/CX16 family, DOS or a cartridge menu on the Atari, a blank
 * NES/MEGA65 screen — with no program, no build, and no project required
 * at all. What "just this hardware, nothing loaded" is for: checking a
 * `--profile`/`--hardware` combination actually boots before spending a
 * build on it, or simply looking at a real machine.
 *
 * The web target has no bare emulator to boot — there is no ROM without a
 * program to run in its worker — so it is refused by name here rather
 * than silently opening nothing.
 *
 * @returns {Promise<number>} exit code
 */
export async function boot(args) {
  const pal = args.includes('--pal');
  const hw = hardwareArgs(args);
  if (!hw.ok) {
    process.stderr.write(`8bs boot: ${hw.error}\n`);
    return 2;
  }
  const positionals = args.filter((a, i) => !hw.consumed.has(i) && !a.startsWith('-'));
  const target = positionals[0];
  if (!target) {
    process.stderr.write(
      'Usage: 8bs boot <pet>\n'
      + '                (vic20, c64, c128, atari8, nes, cx16, mega65 are parked until a later release;\n'
      + '                web has no bare emulator to boot without a program)\n'
      + '                [--pal]\n'
      + HARDWARE_USAGE,
    );
    return 2;
  }
  if (target === 'web') {
    process.stderr.write('8bs boot: the web target has no bare emulator — nothing to boot without a program. Use \'8bs run web\'.\n');
    return 2;
  }

  const { MACHINES, RELEASE_MACHINES } = await import('@8bitscript/compiler');
  if (!MACHINES.includes(target)) {
    process.stderr.write(`8bs boot: unknown target '${target}'. Targets: ${MACHINES.join(', ')}\n`);
    return 2;
  }
  if (!RELEASE_MACHINES.includes(target)) {
    process.stderr.write(
      `8bs boot: '${target}' is not a target in this release. 0.2.0 builds for ` +
      `${RELEASE_MACHINES.join(' and ')} only; the ${target} returns in a later release.\n`,
    );
    return 2;
  }

  // Said once, before either route — the PET has no region (PET_REGION_NOTE).
  if (target === 'pet' && pal) process.stderr.write(PET_REGION_NOTE);

  const { loadConfig } = await import('./config.mjs');
  const { loadCatalog, projectHardware, projectProfiles, resolveHardware } = await import('./hardware.mjs');
  const config = await loadConfig(process.cwd(), '8bs boot');
  const resolved = resolveHardware(loadCatalog(target), {
    profile: hw.profile, overrides: hw.overrides, profiles: projectProfiles(config, target), defaults: projectHardware(config, target),
  });
  if (!resolved.ok) {
    process.stderr.write(`8bs boot: ${resolved.error}\n`);
    return 1;
  }

  const invocation = await emulatorInvocation(target, { pal, hardware: resolved.hardware });
  if (!invocation.ok) {
    process.stderr.write(`8bs boot: ${invocation.error}\n`);
    return 1;
  }
  await writeLastRun(target, {
    hardware: hardwareSnapshot(resolved.hardware),
    emulator: invocation.emulator,
    size: [],
    memory: null,
    outFile: null,
  });
  return spawnEmulator(invocation.emulator, invocation.emulatorArgs);
}
