#!/usr/bin/env node
// The `8bs` entry point.
//
// Two subcommands are real. `check` runs the compiler's diagnostics over files;
// `lsp` starts the language server on stdio for an editor to drive. Both go
// through @8bitscript/compiler, which is the point: one set of rules, reported
// in the terminal, in CI, and under the cursor.
//
// Everything else is still a stub. The parser, the IR, and the backends do not
// exist, so `build` and `run` have nothing to do yet and say so rather than
// pretending.
const [, , command, ...rest] = process.argv;

const IMPLEMENTED = new Set(['check', 'lsp', 'doctor', 'build', 'run']);
const PLANNED = ['dev'];

const usage = () => `Usage: 8bs <command> [options]

Implemented:
  build --target <t> [entry]   Compile for a target: vic20, c64, or web
  run <target> [entry]         Build, then open VICE (vic20/c64) or execute the
                               .wasm and print its state (web)
  check <files...>             Report diagnostics for 8BitScript source files
  doctor                       Verify the toolchains every target needs
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
