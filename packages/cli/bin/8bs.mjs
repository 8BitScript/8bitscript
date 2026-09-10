#!/usr/bin/env node
// The `8bs` entry point — thin dispatch to each subcommand's own module in
// ../src/; see each one for what it actually does. `check` runs the
// compiler's diagnostics over files; `lsp` starts the language server on
// stdio for an editor to drive. Both go through @8bitscript/compiler, which
// is the point: one set of rules, reported in the terminal, in CI, and
// under the cursor.
const [, , command, ...rest] = process.argv;

const IMPLEMENTED = new Set(['check', 'lsp', 'doctor', 'build', 'run', 'boot', 'setup', 'targets']);
const PLANNED = ['dev'];

const usage = () => `Usage: 8bs <command> [options]

Implemented:
  build --target <t> [--pal] [--size] [--profile <name>]
    [--hardware option=value,...] [entry]
                               Compile for a target. This release (0.2.0)
                               builds for pet and web; vic20, c64, c128,
                               atari8, nes, cx16 and mega65 are parked and
                               refused until a later release. The pet has
                               no region: its model is hardware. --profile
                               names the hardware fitted — a preset from
                               the machine's catalog (8032) or a profile the
                               project composes in 8bs.config.ts — and
                               --hardware sets single options on top
                               (model=4032). --size prints a per-function
                               breakdown of the built program, largest
                               first, under the memory line. "8bs targets"
                               lists every option, value and preset, and
                               which machines this release builds for.
  run <target> [--pal] [--profile <name>]
    [--hardware option=value,...] [entry]
                               Build, then open that target's emulator
                               (VICE's xpet for the pet) at the right
                               machine model — or execute the .wasm and
                               print its state (web)
    [--screenshot <file.png>] Instead of an interactive window, capture one
    [--frames <n>]             screenshot through the target's own emulator
                               API (or, for atari8 only, a macOS window
                               capture — see docs/setup/verify.md#screenshots).
                               --frames means a different unit per target
                               (cycles, wall-clock seconds, or exact
                               frame-advances); omit it for a tested default.
  boot <target> [--pal] [--profile <name>]
    [--hardware option=value,...]
                               Opens that target's emulator fitted the same
                               way 'run' would, but loads nothing into it —
                               a stock (or fitted) machine booting to
                               whatever it boots to on its own (BASIC's
                               READY. on the Commodore/CX16 family). No
                               build, no project, no entry file. The web
                               target has none of this: there is no bare
                               ROM without a program to run in its worker.
  targets [--json]             List every target and the hardware it can be
                               fitted with — options, values, presets, and
                               this project's own profiles; --json is what
                               the editor reads
  check <files...>             Report diagnostics for 8BitScript source files
  doctor                       Verify the toolchains every target needs
  setup <target>               Install/configure what a target needs beyond
    [--rom <path>]             what doctor can offer as a single package-
    [--c64-forever <msi>]      manager command. mega65 builds Xemu from
    [--rom-patch <zip>]        source on macOS (Homebrew) and Arch/Manjaro
    [--repair] [--update]      (pacman), then installs a MEGA65 ROM: --rom
                               points at an already-generated MEGA65.ROM
                               (the primary path); --c64-forever/--rom-patch
                               generate one from a C64 Forever MSI instead
                               — docs/setup/mega65.md. cx16 builds x16emu and
                               a matching ROM from upstream source into
                               /opt/commander-x16 (--repair fixes a broken
                               launcher, --update rebuilds the pair —
                               docs/setup/cx16.md)
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
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
  );
  process.stdout.write(`8bs ${pkg.version}\n`);
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

if (command === 'boot') {
  const { boot } = await import('../src/run.mjs');
  process.exit(await boot(rest));
}

if (command === 'targets') {
  const { targets } = await import('../src/targets.mjs');
  process.exit(await targets(rest));
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
