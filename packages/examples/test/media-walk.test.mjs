// Pixel screenshots of media-walk on the four stress machines, skip-if-missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(HERE, '..', '..', 'cli', 'bin', '8bs.mjs');
const ENTRY = join(HERE, '..', 'media-walk', 'src', 'media-walk.8bs');
const CWD = join(HERE, '..', 'media-walk');

function onPath(name) {
  const binary = process.platform === 'win32' ? `${name}.exe` : name;
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, binary)));
}

function isPng(path) {
  const buf = readFileSync(path);
  return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function runCli(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

for (const [target, emulator] of [['c64', 'x64sc'], ['pet', 'xpet'], ['nes', 'fceux'], ['atari8', 'atari800']]) {
  test(`media-walk ${target}: --screenshot produces a PNG via ${emulator}`, async (t) => {
    if (!onPath(emulator)) { t.skip(`${emulator} not on PATH`); return; }
    if (target === 'atari8' && process.platform !== 'darwin') {
      t.skip('atari8 screenshot is macOS window capture');
      return;
    }
    const scratch = await mkdtemp(join(tmpdir(), '8bs-media-shot-'));
    try {
      const shot = join(scratch, 'out.png');
      const { code, stdout, stderr } = await runCli(['run', target, ENTRY, '--screenshot', shot, '--frames', '40']);
      assert.equal(code, 0, `8bs run ${target} --screenshot failed:\n${stdout}${stderr}`);
      assert.ok(existsSync(shot), `no screenshot written:\n${stdout}${stderr}`);
      assert.ok(isPng(shot), 'output is not a valid PNG');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
