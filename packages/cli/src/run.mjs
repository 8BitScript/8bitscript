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
//   8bs run web          builds the .wasm; if it exports frame(), opens it
//                        in the browser on a fixed-timestep requestAnimation
//                        Frame loop (web-runtime.mjs) — otherwise (no
//                        frame(), e.g. examples/counter) falls back to
//                        instantiating it in Node, calling main() once, and
//                        printing the exported globals
//   8bs run web --no-open  the same, without spawning a browser window —
//                        for pasting the printed URL into an editor's own
//                        browser (e.g. VS Code/Cursor's "Simple Browser:
//                        Show" command), which no CLI can open unattended:
//                        that command only exists inside the editor, with
//                        no terminal-invokable equivalent
import { readFile } from 'node:fs/promises';

import { compile } from './build.mjs';

// The VICE family (vic20/c64/pet/c128): one emulator suite, one invocation
// shape — -autostart injects the built file straight into RAM.
const VICE_EMULATOR = { vic20: 'xvic', c64: 'x64sc', pet: 'xpet', c128: 'x128' };

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
const VICE_EMULATOR_ARGS = {
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
const VICE_MODEL_ARGS = {
  vic20: { ntsc: ['-model', 'vic20ntsc'], pal: ['-model', 'vic20pal'] },
  c64: { ntsc: ['-model', 'ntsc'], pal: ['-model', 'c64'] },
  c128: { ntsc: ['-model', 'ntsc'], pal: ['-model', 'pal'] },
};

// atari800's machine-model flag per profile — verified against its own
// DOC/USAGE: -atari (800/400), -xl (800XL), -xe (130XE), -xegs (XEGS). The
// 65XE has no flag of its own: it's electrically and OS-compatible with the
// 800XL, so it reuses -xl. -pal/-ntsc is a fully independent flag from the
// model, unlike VICE's combined -model above.
const ATARI8_MODEL_ARG = {
  '800xl': '-xl',
  '65xe': '-xl',
  '130xe': '-xe',
  800: '-atari',
  400: '-atari',
  xegs: '-xegs',
};

// xvic's own -memory spec strings (confirmed against `xvic -help`:
// "none/3k/8k/16k/24k/all") for each VIC20_PROFILES name. 'unexpanded' maps
// to 'none' — xvic's own default, which is why the unexpanded case worked
// with no flag at all before profiles existed.
const VIC20_MEMORY_ARG = {
  unexpanded: 'none', '3k': '3k', '8k': '8k', '16k': '16k', '24k': '24k',
};

/** @returns {Promise<number>} exit code */
export async function run(args) {
  const pal = args.includes('--pal');
  const open = !args.includes('--no-open');
  const profileIndex = args.indexOf('--profile');
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined;
  const positionals = args.filter((a, i) => {
    if (profileIndex >= 0 && (i === profileIndex || i === profileIndex + 1)) return false;
    return !a.startsWith('-');
  });
  const target = positionals[0];
  if (!target) {
    process.stderr.write(
      'Usage: 8bs run <vic20|c64|pet|c128|atari8|nes|cx16|mega65|web>\n'
      + '                [--pal]\n'
      + '                [--profile <800xl|65xe|130xe|800|400|xegs>]        (atari8)\n'
      + '                [--profile <unexpanded|3k|8k|16k|24k>]             (vic20)\n'
      + '                [--profile <stock|reu128|reu256|reu512|reu1m|reu2m|reu4m|reu8m|reu16m>] (c64)\n'
      + '                [--no-open] [entry.8bs]\n',
    );
    return 2;
  }
  const entry = positionals[1];

  const { ok, outFile } = await compile(target, entry, { pal, profile });
  if (!ok) return 1;

  if (target === 'web') {
    const bytes = await readFile(outFile);
    const { instance } = await WebAssembly.instantiate(bytes);
    if (typeof instance.exports.main !== 'function') {
      process.stderr.write('8bs run: the program exports no main() to call\n');
      return 1;
    }
    // frame() is the per-frame contract main.web.8bs-style programs export
    // (see web-runtime.mjs); a program without one, like examples/counter,
    // has nothing for a browser loop to call back into, so it keeps the
    // original one-shot behaviour instead.
    if (typeof instance.exports.frame === 'function') {
      const { runInBrowser } = await import('./web-runtime.mjs');
      return runInBrowser(bytes, { open });
    }
    instance.exports.main();
    process.stdout.write('ran main(); exported state afterwards:\n');
    for (const [name, value] of Object.entries(instance.exports)) {
      if (value instanceof WebAssembly.Global) {
        process.stdout.write(`  ${name} = ${value.value}\n`);
      }
    }
    return 0;
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
    emulatorArgs = [
      ATARI8_MODEL_ARG[atari8Profile],
      pal ? '-pal' : '-ntsc',
      // atari800 opens at its emulated resolution — 336x240 — which on any
      // modern display is a postage stamp you have to lean in to read, and
      // unlike VICE it has no larger default of its own. 3x that (1008x720)
      // is a window worth looking at on a 1080p screen and still an exact
      // integer scale, which is what atari800's own default INTEGRAL
      // stretch wants: a non-multiple just letterboxes the same small image
      // inside a bigger window.
      '-win-width', '1008', '-win-height', '720',
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
