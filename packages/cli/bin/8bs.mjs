#!/usr/bin/env node
// The `8bs` entry point — thin dispatch to each subcommand's own module in
// ../src/; see each one for what it actually does. `check` runs the
// compiler's diagnostics over files; `lsp` starts the language server on
// stdio for an editor to drive. Both go through @8bitscript/compiler, which
// is the point: one set of rules, reported in the terminal, in CI, and
// under the cursor.
const [, , command, ...rest] = process.argv;

const IMPLEMENTED = new Set(['check', 'lsp', 'doctor', 'build', 'run', 'setup']);
const PLANNED = ['dev'];

const usage = () => `Usage: 8bs <command> [options]

Implemented:
  build --target <t> [--pal] [--profile <p>]
    [entry]                   Compile for a target: vic20, c64, pet, c128,
                               atari8, nes, cx16, mega65, or web. vic20/c64/
                               c128/mega65/atari8 default to NTSC (60Hz);
                               --pal builds the PAL (50Hz) machine model
                               instead. --profile is a hardware profile,
                               meaning differs by target: atari8 picks the
                               machine (800xl default, 65xe, 130xe, 800,
                               400, xegs), vic20 picks a RAM expansion
                               (unexpanded default, 3k, 8k, 16k, 24k), c64
                               picks a REU (stock default, reu128, reu256,
                               reu512, reu1m, reu2m, reu4m, reu8m, reu16m).
  run <target> [--pal] [--profile <p>] [entry]
                               Build, then open that target's emulator
                               (VICE for vic20/c64/pet/c128, atari800,
                               fceux, x16emu, or Xemu for mega65) at the
                               right machine model — or execute the .wasm
                               and print its state (web)
  check <files...>             Report diagnostics for 8BitScript source files
  doctor                       Verify the toolchains every target needs
  setup <target>               Install/configure what a target needs beyond
    [--c64-forever <msi>]      what doctor can offer as a single package-
    [--rom-patch <zip>]        manager command. Currently: mega65 (builds
                               Xemu from source; --c64-forever/--rom-patch
                               supply local files instead of prompting/
                               downloading — see docs/setup/mega65.md)
  lsp [--stdio]                Start the language server on stdio

Planned, not implemented:
  ${PLANNED.join(', ')}

The compiler covers the first-milestone subset of the language: globals,
functions, arithmetic, control flow, @address hardware access, and asm6502
blocks. Constructs beyond that fail with a message. See docs/compiler.md.
`;

if (!command || command === '--help' || command === '-h') {
  process.stdout.write(usage());
  process.exit(command ? 0 : 1);
}

if (command === '--version' || command === '-v') {
  process.stdout.write('8bs 0.0.0\n');
  process.exit(0);
}

if (command === 'check') {
  const { check } = await import('../src/check.mjs');
  process.exit(await check(rest.filter((a) => !a.startsWith('-'))));
}

if (command === 'doctor') {
  const { doctor } = await import('../src/doctor.mjs');
  process.exit(await doctor());
}

if (command === 'build') {
  const { build } = await import('../src/build.mjs');
  process.exit(await build(rest));
}

if (command === 'run') {
  const { run } = await import('../src/run.mjs');
  process.exit(await run(rest));
}

if (command === 'setup') {
  const { setup } = await import('../src/setup.mjs');
  process.exit(await setup(rest));
}

if (command === 'lsp') {
  // --stdio is accepted because every editor passes it by convention; stdio is
  // the only transport, so there is nothing to select.
  const { start } = await import('@8bitscript/language-server');
  start();
} else {
  const known = IMPLEMENTED.has(command) || PLANNED.includes(command);
  process.stderr.write(
    known
      ? `8bs ${command}: not implemented yet.\nThe compiler has no parser or backend yet, so there is nothing to ${command}.\n`
      : `8bs: unknown command '${command}'\n\n${usage()}`,
  );
  process.exit(1);
}
