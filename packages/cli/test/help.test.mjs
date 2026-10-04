// `8bs <command> --help` / `-h` prints that command's usage and exits 0
// without building or launching anything. bin/8bs.mjs used to forward the
// flag to the command's handler as an unknown argument, so `8bs run pet
// --help` built the project and opened the emulator.
//
// The process-level tests run the real bin with an EMPTY PATH and an empty
// working directory: even the old behaviour could not start an emulator
// there, so the test fails on output (wrong exit code, no usage) rather than
// by opening a window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { helpFor, usageFor, wantsHelp } from '../src/help.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(HERE, '..', 'bin', '8bs.mjs');

const SAMPLE = `Usage: 8bs <command> [options]

Implemented:
  build --target <t> [--size]
    [--program <name>] [entry]
                               Compile for a target.
  build --release              Every artifact this project declares.
  run <target> [--pal]
    [--no-open]                Build, then open the emulator.
    [--screenshot <file.png>] Instead of a window, one screenshot.
  boot <target>                Opens the emulator and loads nothing.
  lsp [--stdio]                Start the language server

Planned, not implemented:
  dev

The compiler covers the first-milestone subset.
`;

test('wantsHelp: --help and -h anywhere in the arguments, nothing else', () => {
  assert.equal(wantsHelp(['--help']), true);
  assert.equal(wantsHelp(['pet', '-h']), true);
  assert.equal(wantsHelp(['pet', '--screenshot', 'a.png']), false);
  assert.equal(wantsHelp([]), false);
});

test('usageFor: only the named command\'s block, with its option lines and its description', () => {
  const run = usageFor('run', SAMPLE);
  assert.match(run, /^Usage: 8bs run\n/);
  assert.match(run, /run <target> \[--pal\]/);
  assert.match(run, /\[--no-open\]/);
  assert.match(run, /\[--screenshot <file\.png>\] Instead of a window/, 'an option line indented four spaces stays in the block');
  assert.doesNotMatch(run, /boot <target>/);
  assert.doesNotMatch(run, /Planned/);
  assert.doesNotMatch(run, /first-milestone/);
});

test('usageFor: a command with two blocks (build) gets both', () => {
  const build = usageFor('build', SAMPLE);
  assert.match(build, /build --target <t>/);
  assert.match(build, /build --release/);
  assert.doesNotMatch(build, /run <target>/);
});

test('usageFor: a command with no block is null', () => {
  assert.equal(usageFor('nope', SAMPLE), null);
});

test('helpFor: help text only when help was asked for, and never for a flag or a missing command', () => {
  assert.match(helpFor('run', ['pet', '--help'], SAMPLE), /run <target>/);
  assert.match(helpFor('lsp', ['-h'], SAMPLE), /lsp \[--stdio\]/);
  assert.equal(helpFor('run', ['pet'], SAMPLE), null, 'no help flag, the command runs');
  assert.equal(helpFor(undefined, ['--help'], SAMPLE), null);
  assert.equal(helpFor('--version', ['--help'], SAMPLE), null);
  assert.equal(helpFor('ghost', ['--help'], SAMPLE), SAMPLE, 'a command with no block of its own gets the whole usage');
});

function runCli(args, { cwd, timeoutMs = 20_000 }) {
  return new Promise((resolvePromise) => {
    // PATH is empty: nothing the command might try to launch can be found.
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd, env: { ...process.env, PATH: cwd }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

const COMMANDS = ['check', 'lsp', 'doctor', 'build', 'run', 'boot', 'setup', 'targets', 'controller'];

for (const command of COMMANDS) {
  for (const flag of ['--help', '-h']) {
    test(`8bs ${command} ${flag}: that command's usage on stdout, exit 0, nothing launched`, async () => {
      const scratch = mkdtempSync(join(tmpdir(), '8bs-help-'));
      try {
        const args = ['run', 'boot', 'setup'].includes(command) ? [command, 'pet', flag] : [command, flag];
        const { code, stdout, stderr } = await runCli(args, { cwd: scratch });
        assert.equal(code, 0, `exit code ${code}\n${stdout}${stderr}`);
        assert.match(stdout, new RegExp(`^Usage: 8bs ${command}\\n`));
        assert.match(stdout, new RegExp(`^ {2}${command}\\b`, 'm'), 'the command\'s own line is there');
        // Only its own block: no other command's heading line.
        for (const other of COMMANDS.filter((c) => c !== command)) {
          assert.doesNotMatch(stdout, new RegExp(`^ {2}${other}\\b`, 'm'), `no '${other}' block in ${command}'s help`);
        }
        assert.doesNotMatch(stdout, /Planned, not implemented/);
        assert.equal(stderr, '');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
}

test('8bs build --help shows both the compile and the --release block', async () => {
  const scratch = mkdtempSync(join(tmpdir(), '8bs-help-'));
  try {
    const { code, stdout } = await runCli(['build', '--help'], { cwd: scratch });
    assert.equal(code, 0);
    assert.match(stdout, /build --target <t>/);
    assert.match(stdout, /build --release/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('an unknown command with --help is still an unknown command', async () => {
  const scratch = mkdtempSync(join(tmpdir(), '8bs-help-'));
  try {
    const { code, stderr } = await runCli(['frobnicate', '--help'], { cwd: scratch });
    assert.equal(code, 1);
    assert.match(stderr, /unknown command 'frobnicate'/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
