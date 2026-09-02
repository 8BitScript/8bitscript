// `8bs run <target>` — build, then actually run the program.
//
//   8bs run vic20        builds the .prg and opens it in the VICE VIC-20
//                        emulator, machine model NTSC (60fps) — the default
//   8bs run vic20 --pal  the same, machine model PAL (50fps)
//   8bs run c64          the same idea, in the C64 emulator (NTSC default)
//   8bs run c64 --pal
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

const EMULATOR = { vic20: 'xvic', c64: 'x64sc' };

// Flags the emulator needs to run our .prg files. The emulated machine must
// match the memory layout the program was linked for: 8BitScript's vic20
// target is the UNEXPANDED VIC-20 ($1001), which is also xvic's stock
// configuration, so no memory flag is needed — but if the backend's
// __memory_expansion pin ever changes, this table must change with it, or
// autostart injects the program at the wrong address and silently never runs
// it. RAM injection (-autostartprgmode 1) skips the emulated disk load.
const EMULATOR_ARGS = {
  vic20: ['-autostartprgmode', '1'],
  c64: ['-autostartprgmode', '1'],
};
// -ntsc/-pal only flip VICE's sync factor (raster timing): the screen-origin
// registers the KERNAL sets up at boot stay wired to whichever machine model
// is loaded, so -ntsc alone can pair NTSC timing with PAL geometry and the
// picture renders off-center. -model switches the whole machine (ROM set,
// VIC-II/VIC geometry, and timing together), which is why the target names
// a model rather than a sync-factor flag.
const MODEL_ARGS = {
  vic20: { ntsc: ['-model', 'vic20ntsc'], pal: ['-model', 'vic20pal'] },
  c64: { ntsc: ['-model', 'ntsc'], pal: ['-model', 'c64'] },
};

/** @returns {Promise<number>} exit code */
export async function run(args) {
  const pal = args.includes('--pal');
  const open = !args.includes('--no-open');
  const positionals = args.filter((a) => !a.startsWith('-'));
  const target = positionals[0];
  if (!target) {
    process.stderr.write('Usage: 8bs run <vic20|c64|web> [--pal] [--no-open] [entry.8bs]\n');
    return 2;
  }
  const entry = positionals[1];

  const { ok, outFile } = await compile(target, entry, { pal });
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

  // build() already rejected anything that isn't vic20/c64, so this
  // always matches.
  const machine = target;
  const region = pal ? 'pal' : 'ntsc';
  const emulator = EMULATOR[machine];
  process.stdout.write(`starting ${emulator} (${region}); close the emulator window to finish.\n`);
  const { spawn } = await import('node:child_process');
  return new Promise((resolvePromise) => {
    const emulatorArgs = [
      ...(EMULATOR_ARGS[machine] ?? []),
      ...MODEL_ARGS[machine][region],
      // Skip the "really quit?" confirmation dialog — closing the emulator
      // window during dev/test cycles should not need a click every time.
      '+confirmonexit',
      '-autostart', outFile,
    ];
    const child = spawn(emulator, emulatorArgs, { stdio: 'inherit' });
    child.on('error', () => {
      process.stderr.write(`8bs run: cannot start ${emulator}. Run '8bs doctor' — docs/setup/vice.md\n`);
      resolvePromise(1);
    });
    child.on('close', (code) => resolvePromise(code === 0 ? 0 : 0));
  });
}
