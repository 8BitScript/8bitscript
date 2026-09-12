// `bin/8bs.mjs` is a thin dispatcher: each branch just imports a src/
// module and forwards argv to its own exported function, which is what the
// rest of this package's tests exercise directly (check.test.mjs,
// build-entry.test.mjs, run-model.test.mjs, targets.test.mjs,
// setup-dispatch.test.mjs, doctor.test.mjs, and the language server's own
// tests). Those never touch bin/8bs.mjs itself — the dispatch lines
// (argv parsing, --help/--version, the unknown-command path, and each
// `await import(...)` branch) only run when the file is actually invoked
// as a script, so this file does that, once per branch, with arguments
// chosen to return fast rather than re-testing what the branch delegates to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(HERE, '..', 'bin', '8bs.mjs');
const PKG_VERSION = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;

function runCli(args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

test('no command: usage on stdout, exit 1', async () => {
  const { code, stdout } = await runCli([]);
  assert.equal(code, 1);
  assert.match(stdout, /^Usage: 8bs <command> \[options\]/);
  assert.match(stdout, /Planned, not implemented:\n {2}dev/);
  assert.match(stdout, /\[--size\]/, 'run --size is documented on the main usage');
});

test('--help and -h: the same usage, exit 0', async () => {
  for (const flag of ['--help', '-h']) {
    const { code, stdout } = await runCli([flag]);
    assert.equal(code, 0, flag);
    assert.match(stdout, /^Usage: 8bs <command> \[options\]/, flag);
  }
});

test('--version and -v: the package.json version, exit 0', async () => {
  for (const flag of ['--version', '-v']) {
    const { code, stdout } = await runCli([flag]);
    assert.equal(code, 0, flag);
    assert.equal(stdout, `8bs ${PKG_VERSION}\n`);
  }
});

test('an unknown command: the error and usage on stderr, exit 1', async () => {
  const { code, stdout, stderr } = await runCli(['bogus']);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^8bs: unknown command 'bogus'/);
  assert.match(stderr, /Usage: 8bs <command> \[options\]/);
});

test('a planned-not-implemented command (dev): its own message, exit 1', async () => {
  const { code, stdout, stderr } = await runCli(['dev']);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^8bs dev: not implemented yet\./);
  assert.match(stderr, /nothing to dev/);
});

test('doctor: dispatches to src/doctor.mjs', async () => {
  // The real toolchain checks (already covered against fakes in
  // doctor.test.mjs) — this just proves the dispatch line runs them and
  // forwards the pass/fail exit code, so a generous timeout rather than a
  // specific outcome: whether every toolchain is installed here or not,
  // doctor() always terminates with 0 or 1.
  const { code } = await runCli(['doctor'], { timeoutMs: 60_000 });
  assert.ok(code === 0 || code === 1, `expected doctor to exit 0 or 1, got ${code}`);
});

test('check: dispatches to src/check.mjs', async () => {
  const { code, stderr } = await runCli(['check']);
  // check.mjs's own usage exit code (2) for no files — proves the dispatch
  // line imported and called it rather than falling through to "unknown".
  assert.equal(code, 2);
  assert.match(stderr, /8bs check: no files given/);
});

test('build: dispatches to src/build.mjs', async () => {
  const { code, stderr } = await runCli(['build']);
  assert.equal(code, 2);
  assert.match(stderr, /^Usage: 8bs build --target <pet\|web>/);
});

test('run: dispatches to src/run.mjs', async () => {
  const { code, stderr } = await runCli(['run']);
  assert.equal(code, 2);
  assert.match(stderr, /^Usage: 8bs run <pet\|web>/);
});

test('boot: dispatches to src/run.mjs\'s boot()', async () => {
  const { code, stderr } = await runCli(['boot']);
  assert.equal(code, 2);
  assert.match(stderr, /^Usage: 8bs boot <pet>/);
});

test('targets: dispatches to src/targets.mjs', async () => {
  const { code, stdout } = await runCli(['targets', '--json']);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed.targets) && parsed.targets.length > 0);
});

test('a command that prints more than a pipe holds is not cut off at 64KB', async () => {
  // `process.exit()` abandons a pending write, and a pipe stops accepting
  // at 65536 bytes. The catalogs grew past that, so `8bs targets --json`
  // started handing its readers — the editor among them — JSON that ended
  // mid-string, with an exit code of 0 to say all was well. bin/8bs.mjs
  // drains stdout before it exits; this is the assertion that it still
  // does, and it is written against the size rather than against targets
  // because any command that outgrows a pipe has the same problem.
  const { code, stdout } = await runCli(['targets', '--json']);
  assert.equal(code, 0);
  assert.ok(stdout.length > 65536, `the output is only ${stdout.length} bytes; this no longer tests a truncation`);
  assert.doesNotThrow(() => JSON.parse(stdout), 'stdout was cut short');
});

test('controller: dispatches to src/controller.mjs', async () => {
  // --list is the branch that touches no port and opens no browser.
  const { code, stdout } = await runCli(['controller', '--list']);
  assert.equal(code, 0);
  assert.match(stdout, /nothing here can see a pad/);
});

test('setup: dispatches to src/setup.mjs', async () => {
  const { code, stderr } = await runCli(['setup']);
  assert.equal(code, 2);
  assert.match(stderr, /^Usage: 8bs setup <mega65\|cx16>/);
});

test('lsp --stdio: dispatches to the language server and exits when stdin closes', async () => {
  const child = spawn(process.execPath, [CLI_BIN, 'lsp', '--stdio'], { cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const closed = new Promise((resolvePromise) => child.on('close', (code) => resolvePromise(code)));
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const code = await closed;
  clearTimeout(timer);
  assert.equal(stderr, '');
  assert.notEqual(code, null, 'lsp --stdio should exit once stdin closes, not hang');
});
