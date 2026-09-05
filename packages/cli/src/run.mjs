// `8bs run <target>` — build, then actually run the program.
//
//   8bs run vic20        builds the .prg and opens it in the VICE VIC-20
//                        emulator, machine model NTSC (60fps) — the default
//   8bs run vic20 --pal  the same, machine model PAL (50fps)
//   8bs run c64          the same idea, in the C64 emulator (NTSC default)
//   8bs run c64 --pal
//   8bs run pet          builds the .prg and opens it in VICE's PET emulator
//                        (xpet) — no --pal/--ntsc: unlike the raster-based
//                        machines above, this target measures its actual
//                        frame rate at runtime (see FRAME_SYNC.pet in
//                        packages/backend-6502), so there's no separate
//                        machine model to pick here
//   8bs run c128         VICE's C128 emulator (x128), NTSC default, --pal
//   8bs run atari8       builds for the default 800XL profile and opens it
//                        in atari800; --profile picks a different Atari
//                        8-bit hardware profile, --pal/--ntsc the TV
//                        standard (NTSC default)
//   8bs run vic20 --profile 16k   builds for a 16K-expanded VIC-20 and
//                        passes xvic the matching `-memory` flag, so the
//                        emulated machine's RAM matches what the program
//                        was linked for
//   8bs run c64 --profile reu512  builds for the stock C64 (a REU changes
//                        nothing about the base memory map) and attaches a
//                        512K REU to x64sc via `-reu -reusize`
//   8bs run nes          builds the .nes and opens it in FCEUX
//   8bs run cx16          builds the .prg and opens it in x16emu
//   8bs run mega65        builds the .prg and opens it in Xemu's MEGA65
//                        core (xmega65) — best-effort: unlike the VICE and
//                        atari800 integrations above, this project has not
//                        independently confirmed Xemu's mega65 core accepts
//                        -prg the way its other machine cores do (its docs
//                        don't cover autoloading); run `xmega65 -h` if this
//                        doesn't work as expected
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
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { compile } from './build.mjs';

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
// VIC-II/VIC geometry, and timing together), which is why the target names
// a model rather than a sync-factor flag. Verified against `x128 -help`
// ("Set C128 model (c128/c128dcr, pal/ntsc)"); the PET has no entry here —
// see the run() docstring above for why.
export const VICE_MODEL_ARGS = {
  vic20: { ntsc: ['-model', 'vic20ntsc'], pal: ['-model', 'vic20pal'] },
  c64: { ntsc: ['-model', 'ntsc'], pal: ['-model', 'c64'] },
  c128: { ntsc: ['-model', 'ntsc'], pal: ['-model', 'pal'] },
};

// atari800's machine-model flag per profile — verified against its own
// DOC/USAGE: -atari (800/400), -xl (800XL), -xe (130XE), -xegs (XEGS). The
// 65XE has no flag of its own: it's electrically and OS-compatible with the
// 800XL, so it reuses -xl. -pal/-ntsc is a fully independent flag from the
// model, unlike VICE's combined -model above.
export const ATARI8_MODEL_ARG = {
  '800xl': '-xl',
  '65xe': '-xl',
  '130xe': '-xe',
  800: '-atari',
  400: '-atari',
  xegs: '-xegs',
};

// atari800's SDL2 OpenGL shader (atari800-shader.frag) defaults
// CRT_BEAM_SHAPE=10, which spreads each emulated pixel with a Gaussian
// falloff — visible as dark vertical stripes across the whole frame,
// border included, on top of the ordinary horizontal scanline overlay.
// There is no CLI flag for that uniform (only SCANLINES_PERCENTAGE has
// `-scanlines`), so `8bs run` copies the user's ~/.atari800.cfg, zeros
// the CRT knobs, and points `-config` at the copy with `-no-autosave-config`
// so the user's own file is left alone. ROM paths stay whatever the user
// already configured; without those the emulator boots to black.
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
  const outPath = join(tmpdir(), '8bs-atari800.cfg');
  await writeFile(outPath, cfg);
  return outPath;
}

// xvic's own -memory spec strings (confirmed against `xvic -help`:
// "none/3k/8k/16k/24k/all") for each VIC20_PROFILES name. 'unexpanded' maps
// to 'none' — xvic's own default, which is why the unexpanded case worked
// with no flag at all before profiles existed.
export const VIC20_MEMORY_ARG = {
  unexpanded: 'none', '3k': '3k', '8k': '8k', '16k': '16k', '24k': '24k',
};

/** @returns {Promise<number>} exit code */
export async function run(args) {
  const pal = args.includes('--pal');
  const open = !args.includes('--no-open');
  const profileIndex = args.indexOf('--profile');
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined;
  const screenshotIndex = args.indexOf('--screenshot');
  const screenshotPath = screenshotIndex >= 0 ? resolve(args[screenshotIndex + 1]) : undefined;
  const framesIndex = args.indexOf('--frames');
  const framesArg = framesIndex >= 0 ? args[framesIndex + 1] : undefined;
  const frames = framesArg !== undefined ? Number.parseInt(framesArg, 10) : undefined;
  if (framesArg !== undefined && !Number.isFinite(frames)) {
    process.stderr.write(`8bs run: --frames expects a number, got '${framesArg}'\n`);
    return 2;
  }
  const consumed = new Set(
    [profileIndex, screenshotIndex, framesIndex].flatMap((i) => (i >= 0 ? [i, i + 1] : [])),
  );
  const positionals = args.filter((a, i) => !consumed.has(i) && !a.startsWith('-'));
  const target = positionals[0];
  if (!target) {
    process.stderr.write(
      'Usage: 8bs run <vic20|c64|pet|c128|atari8|nes|cx16|mega65|web>\n'
      + '                [--pal]\n'
      + '                [--profile <800xl|65xe|130xe|800|400|xegs>]        (atari8)\n'
      + '                [--profile <unexpanded|3k|8k|16k|24k>]             (vic20)\n'
      + '                [--profile <stock|reu128|reu256|reu512|reu1m|reu2m|reu4m|reu8m|reu16m>] (c64)\n'
      + '                [--no-open] [entry.8bs]\n'
      + '                [--screenshot <file.png>] [--frames <n>]\n'
      + '                  capture one screenshot through the target\'s own\n'
      + '                  emulator API instead of opening an interactive\n'
      + '                  window — see docs/setup/verify.md#screenshots for\n'
      + '                  what --frames counts on each target\n',
    );
    return 2;
  }
  const entry = positionals[1];

  const { ok, outFile, frameRate } = await compile(target, entry, { pal, profile });
  if (!ok) return 1;

  if (screenshotPath) {
    const { captureScreenshot } = await import('./screenshot.mjs');
    try {
      await captureScreenshot(target, outFile, screenshotPath, {
        pal, profile, frames, frameRate,
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
    const bytes = await readFile(outFile);
    const { runInBrowser } = await import('./web-runtime.mjs');
    return runInBrowser(bytes, { open, frameRate });
  }

  const {
    ATARI8_DEFAULT_PROFILE, VIC20_DEFAULT_PROFILE, C64_DEFAULT_PROFILE, C64_REU_SIZE_KIB,
  } = await import('@8bitscript/backend-6502');
  const region = pal ? 'pal' : 'ntsc';

  let emulator;
  let emulatorArgs;
  if (target in VICE_EMULATOR) {
    emulator = VICE_EMULATOR[target];
    // vic20's -memory must match whichever RAM-expansion profile the
    // program was linked for (see VIC20_MEMORY_ARG above); c64's REU is
    // purely additive hardware, so it only ever appends `-reu -reusize`,
    // never changes anything else about the base machine.
    const vic20Profile = target === 'vic20' ? (profile ?? VIC20_DEFAULT_PROFILE) : undefined;
    const c64Profile = target === 'c64' ? (profile ?? C64_DEFAULT_PROFILE) : undefined;
    emulatorArgs = [
      ...(VICE_EMULATOR_ARGS[target] ?? []),
      ...(VICE_MODEL_ARGS[target]?.[region] ?? []),
      ...(vic20Profile ? ['-memory', VIC20_MEMORY_ARG[vic20Profile]] : []),
      ...(c64Profile && c64Profile !== 'stock' ? ['-reu', '-reusize', String(C64_REU_SIZE_KIB[c64Profile])] : []),
      // Skip the "really quit?" confirmation dialog — closing the emulator
      // window during dev/test cycles should not need a click every time.
      '+confirmonexit',
      '-autostart', outFile,
    ];
  } else if (target === 'atari8') {
    const atari8Profile = profile ?? ATARI8_DEFAULT_PROFILE;
    emulator = 'atari800';
    // atari800's TV-area visible size (DOC/USAGE -horiz-area/-vert-area):
    // 336 wide, 224 tall on NTSC and 240 tall on PAL. The emulator opens
    // at 1x of that — a postage stamp on any modern display — and unlike
    // VICE it has no larger default of its own. 3x is a window worth
    // looking at on a 1080p screen and still an exact integer scale, which
    // is what atari800's own default INTEGRAL stretch wants: a non-multiple
    // just letterboxes the same small image inside a bigger window.
    const tvHeight = pal ? 240 : 224;
    const displayCfg = await atari800CleanDisplayConfig();
    emulatorArgs = [
      ...(displayCfg ? ['-config', displayCfg, '-no-autosave-config'] : []),
      ATARI8_MODEL_ARG[atari8Profile],
      pal ? '-pal' : '-ntsc',
      '-horiz-area', 'tv',
      '-vert-area', 'tv',
      '-stretch', 'integral',
      '-scanlines', '0',
      '-win-width', String(336 * 3),
      '-win-height', String(tvHeight * 3),
      atari8Profile === 'xegs' ? '-cart' : '-run',
      outFile,
    ];
  } else if (target === 'nes') {
    emulator = 'fceux';
    emulatorArgs = [outFile];
  } else if (target === 'cx16') {
    // Confirmed against the X16Community/x16-emulator README.
    emulator = 'x16emu';
    emulatorArgs = ['-prg', outFile, '-run'];
  } else if (target === 'mega65') {
    // Best-effort — see the run() docstring above. -videostd pins the video
    // standard to match the region the .prg was built for (0=PAL, 1=NTSC);
    // left unset, Xemu's Hyppo default is PAL regardless of which region
    // this target compiled for, so an NTSC build gets PAL's ~100 extra
    // scanlines of VIC-IV border/overscan — the exact off-geometry mismatch
    // VICE_MODEL_ARGS above documents for -ntsc/-pal not implying a model.
    emulator = 'xmega65';
    emulatorArgs = ['-prg', outFile, '-videostd', pal ? '0' : '1'];
  } else {
    // build() already validated the target against the same TARGETS set
    // this function branches over, so this is unreachable.
    process.stderr.write(`8bs run: no emulator wired up for target '${target}'\n`);
    return 1;
  }

  process.stdout.write(`starting ${emulator}; close the emulator window to finish.\n`);
  const { spawn } = await import('node:child_process');
  return new Promise((resolvePromise) => {
    const child = spawn(emulator, emulatorArgs, { stdio: 'inherit' });
    child.on('error', () => {
      process.stderr.write(`8bs run: cannot start ${emulator}. Run '8bs doctor' — docs/setup/index.md\n`);
      resolvePromise(1);
    });
    child.on('close', (code) => resolvePromise(code === 0 ? 0 : 0));
  });
}
