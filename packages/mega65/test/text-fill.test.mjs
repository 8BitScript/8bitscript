// text.fill must map colour RAM over the CIAs before it writes a cell past
// 1023. The probe fills 2048's bottom-left tile (cells 1388–1392), prints
// so HOTREG re-derives CHARPTR from `$D018`, and writes CHARPTR's high
// byte at cell 80: `024` (`$18`, mixed-case ROM, bank 0) or `152` (`$98`,
// bank 2, the CIA2-poke failure). xmega65's own PNG is 2-bit, so this
// reads dumpmem rather than a screenshot pixel. See fill-probe.8bs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const PROBE = join(HERE, 'fill-probe.8bs');

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

function runCli(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminate(child) {
  return new Promise((resolve) => {
    child.on('close', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000);
  });
}

test('the fill probe links clean for MEGA65', () => {
  const { diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'mega65', facts: stockFacts('mega65') });
  assert.deepEqual(diagnostics, []);
});

test('under xmega65, text.fill past cell 1023 leaves the mixed-case ROM charset mapped', async (t) => {
  if (!onPath('xmega65')) { t.skip('xmega65 not on PATH'); return; }
  const scratch = await mkdtemp(join(tmpdir(), '8bs-mega65-fill-'));
  try {
    const { code, stdout, stderr } = await runCli(['build', 'mega65', 'test/fill-probe.8bs'], { timeoutMs: 30_000 });
    assert.equal(code, 0, `8bs build mega65 failed:\n${stdout}${stderr}`);
    const built = stdout.match(/built (\S+\.prg)/);
    assert.ok(built, `build did not report a .prg:\n${stdout}${stderr}`);
    const dump = join(scratch, 'fill.mem');
    const child = spawn('xmega65', [
      '-besure', '-headless', '-dumpmem', dump, '-prg', built[1], '-videostd', '1',
    ], { stdio: 'ignore' });
    await sleep(9000);
    await terminate(child);
    assert.ok(existsSync(dump), 'xmega65 did not write dumpmem');
    const mem = readFileSync(dump);
    assert.deepEqual([...mem.subarray(0x0800, 0x0804)], [70, 73, 76, 76], 'cell 0 is FILL');
    assert.deepEqual([...mem.subarray(0x0850, 0x0853)], [48, 50, 52], 'CHARPTR high byte is $18');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
