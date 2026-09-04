// One test per target for `8bs run <target> --screenshot <file>` — the
// real CLI path (not screenshot.mjs's internals directly), against a real
// build of examples/borders, confirming an actual PNG lands on disk. See
// docs/setup/verify.md#screenshots for what this feature is and why each
// target's mechanism differs; see emulator-smoke.test.mjs for the same
// "skip rather than fail when the tool isn't installed" convention this
// file follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(HERE, '..', 'bin', '8bs.mjs');
const BORDERS_DIR = join(HERE, '..', '..', '..', 'examples', 'borders');

function onPath(name) {
  const binary = process.platform === 'win32' ? `${name}.exe` : name;
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, binary)));
}

const HAS_SDK = Boolean(process.env.LLVM_MOS_HOME);

function runCli(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: BORDERS_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

function isPng(path) {
  const buf = readFileSync(path);
  return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

const VICE_EMULATOR = { vic20: 'xvic', c64: 'x64sc', pet: 'xpet', c128: 'x128' };

for (const [target, emulator] of Object.entries(VICE_EMULATOR)) {
  test(`${target}: --screenshot produces a PNG via ${emulator}`, { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async (t) => {
    if (!onPath(emulator)) { t.skip(`${emulator} not on PATH`); return; }
    const scratch = await mkdtemp(join(tmpdir(), '8bs-shot-test-'));
    try {
      const shot = join(scratch, 'out.png');
      const { code, stdout, stderr } = await runCli(['run', target, '--screenshot', shot]);
      assert.equal(code, 0, `8bs run ${target} --screenshot failed:\n${stdout}${stderr}`);
      assert.ok(existsSync(shot), `no screenshot written:\n${stdout}${stderr}`);
      assert.ok(isPng(shot), 'output is not a valid PNG');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

test('nes: --screenshot produces a PNG via fceux', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async (t) => {
  if (!onPath('fceux')) { t.skip('fceux not on PATH'); return; }
  const scratch = await mkdtemp(join(tmpdir(), '8bs-shot-test-'));
  try {
    const shot = join(scratch, 'out.png');
    const { code, stdout, stderr } = await runCli(['run', 'nes', '--screenshot', shot]);
    assert.equal(code, 0, `8bs run nes --screenshot failed:\n${stdout}${stderr}`);
    assert.ok(isPng(shot), 'output is not a valid PNG');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('cx16: --screenshot produces a PNG via x16emu + ffmpeg', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async (t) => {
  if (!onPath('x16emu')) { t.skip('x16emu not on PATH'); return; }
  if (!onPath('ffmpeg')) { t.skip('ffmpeg not on PATH'); return; }
  const scratch = await mkdtemp(join(tmpdir(), '8bs-shot-test-'));
  try {
    const shot = join(scratch, 'out.png');
    const { code, stdout, stderr } = await runCli(['run', 'cx16', '--screenshot', shot], { timeoutMs: 30_000 });
    assert.equal(code, 0, `8bs run cx16 --screenshot failed:\n${stdout}${stderr}`);
    assert.ok(isPng(shot), 'output is not a valid PNG');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('mega65: --screenshot produces a PNG via xmega65', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async (t) => {
  if (!onPath('xmega65')) { t.skip('xmega65 not on PATH'); return; }
  const scratch = await mkdtemp(join(tmpdir(), '8bs-shot-test-'));
  try {
    const shot = join(scratch, 'out.png');
    const { code, stdout, stderr } = await runCli(['run', 'mega65', '--screenshot', shot], { timeoutMs: 30_000 });
    assert.equal(code, 0, `8bs run mega65 --screenshot failed:\n${stdout}${stderr}`);
    assert.ok(isPng(shot), 'output is not a valid PNG');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test(
  'atari8: --screenshot produces a PNG via macOS window capture',
  { skip: (!HAS_SDK && 'LLVM_MOS_HOME not set') || (process.platform !== 'darwin' && 'macOS only') },
  async (t) => {
    if (!onPath('atari800')) { t.skip('atari800 not on PATH'); return; }
    const scratch = await mkdtemp(join(tmpdir(), '8bs-shot-test-'));
    try {
      const shot = join(scratch, 'out.png');
      const { code, stdout, stderr } = await runCli(['run', 'atari8', '--screenshot', shot], { timeoutMs: 30_000 });
      assert.equal(code, 0, `8bs run atari8 --screenshot failed:\n${stdout}${stderr}`);
      assert.ok(isPng(shot), 'output is not a valid PNG');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test('web: --screenshot produces a PNG with no emulator at all', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-shot-test-'));
  try {
    const shot = join(scratch, 'out.png');
    const { code, stdout, stderr } = await runCli(['run', 'web', '--screenshot', shot]);
    assert.equal(code, 0, `8bs run web --screenshot failed:\n${stdout}${stderr}`);
    assert.ok(isPng(shot), 'output is not a valid PNG');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
