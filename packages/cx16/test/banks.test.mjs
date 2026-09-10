// @8bitscript/cx16/banks — the X16's banked-RAM probe. Two layers: the
// probe program links clean for the X16 with the stock sheet (no emulator
// needed), and, when x16emu and a working backend are installed, it is
// run on a 64 KiB machine and a 2 MiB one and the border color each
// screenshot shows is what banks.kib() found. The border encodes the
// answer (see banks-probe.8bs) so the test reads one pixel, not text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { loadCatalog, stockFacts } from '../../cli/src/hardware.mjs';
import { pixelAt } from '../../cli/src/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const PROBE = join(HERE, 'banks-probe.8bs');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./banks, and the catalog says the banked RAM is found at run time by it', () => {
  assert.equal(pkg['8bitscript'].exports['./banks'], './src/banks.8bs');
  assert.equal(loadCatalog('cx16').options.ram.detect, '@8bitscript/cx16/banks');
});

test('the probe program links clean for the X16, and banks.kib() is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'cx16', facts: stockFacts('cx16') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['banks_kib', 'banks_count', 'banks_mark', 'banks_shows', 'banks_backed']) {
    assert.ok(names.includes(name), name);
  }
});

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const NATIVE_BACKEND_PENDING = 'Bare Metal: waiting on the native backend';

function runCli(args, { timeoutMs = 120_000 } = {}) {
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

test(
  'under x16emu, banks.kib() finds 64 KiB on the smallest machine and 2 MiB on the largest',
  {
    skip: NATIVE_BACKEND_PENDING,
  },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-banks-test-'));
    try {
      const shots = {};
      for (const ram of ['64', '2048']) {
        const shot = join(scratch, `${ram}.png`);
        const { code, stdout, stderr } = await runCli(
          ['run', 'cx16', '--hardware', `ram=${ram}`, '--screenshot', shot, 'test/banks-probe.8bs'],
          { timeoutMs: 150_000 },
        );
        assert.equal(code, 0, `8bs run cx16 --hardware ram=${ram} --screenshot failed:\n${stdout}${stderr}`);
        shots[ram] = pixelAt(readFileSync(shot), 4, 4); // well inside the border
      }
      // banks-probe.8bs paints one color per size from 64 KiB up: the
      // smallest machine is red, the largest yellow.
      const [r64, g64, b64] = shots['64'];
      assert.ok(r64 > g64 + 60 && r64 > b64 + 60, `64 KiB: a red border, got rgb(${shots['64']})`);
      const [r2, g2, b2] = shots['2048'];
      assert.ok(r2 > 180 && g2 > 180 && b2 < r2 - 60, `2 MiB: a yellow border, got rgb(${shots['2048']})`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
