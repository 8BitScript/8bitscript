// `8bs run <target>` — build, then actually run the program.
//
//   8bs run vic20         builds the .prg and opens it in the VICE VIC-20
//                         emulator, at 60fps (NTSC)
//   8bs run vic20 --pal   the same, at 50fps (PAL) — for checking PAL timing
//   8bs run c64           the same idea, in the C64 emulator
//   8bs run web           builds the .wasm, instantiates it, calls main()
//                         once, and prints the exported globals — a
//                         provisional harness that stands in until a real
//                         browser runtime exists
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
//
// Neither emulator defaults to NTSC on its own — VICE's stock default is PAL
// (50Hz) for both machines — so the region is always passed explicitly.
const EMULATOR_ARGS = {
  vic20: ['-autostartprgmode', '1'],
  c64: ['-autostartprgmode', '1'],
};
const REGION_ARGS = { ntsc: ['-ntsc'], pal: ['-pal'] };

/** @returns {Promise<number>} exit code */
export async function run(args) {
  const target = args.find((a) => !a.startsWith('-'));
  if (!target) {
    process.stderr.write('Usage: 8bs run <vic20|c64|web> [--pal] [entry.8bs]\n');
    return 2;
  }
  const entry = args.filter((a) => !a.startsWith('-'))[1];
  const region = args.includes('--pal') ? 'pal' : 'ntsc';

  const { ok, outFile } = await compile(target, entry);
  if (!ok) return 1;

  if (target === 'web') {
    const bytes = await readFile(outFile);
    const { instance } = await WebAssembly.instantiate(bytes);
    if (typeof instance.exports.main !== 'function') {
      process.stderr.write('8bs run: the program exports no main() to call\n');
      return 1;
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

  const emulator = EMULATOR[target];
  process.stdout.write(`starting ${emulator} (${region}); close the emulator window to finish.\n`);
  const { spawn } = await import('node:child_process');
  return new Promise((resolvePromise) => {
    const emulatorArgs = [...(EMULATOR_ARGS[target] ?? []), ...REGION_ARGS[region], '-autostart', outFile];
    const child = spawn(emulator, emulatorArgs, { stdio: 'inherit' });
    child.on('error', () => {
      process.stderr.write(`8bs run: cannot start ${emulator}. Run '8bs doctor' — docs/setup/vice.md\n`);
      resolvePromise(1);
    });
    child.on('close', (code) => resolvePromise(code === 0 ? 0 : 0));
  });
}
