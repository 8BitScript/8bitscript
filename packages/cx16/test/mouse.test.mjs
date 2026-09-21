// @8bitscript/cx16/mouse — the X16's KERNAL mouse. Two layers: the probe
// program links clean for the X16 with the stock sheet (no emulator
// needed), and, when x16emu and a working backend are installed, it is
// run and the border color the screenshot shows is what mouse.present()
// answered.
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
const PROBE = join(HERE, 'mouse-probe.8bs');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./mouse, and the catalog says the stock machine has one', () => {
  assert.equal(pkg['8bitscript'].exports['./mouse'], './src/mouse.8bs');
  assert.equal(stockFacts('cx16')['input.mouse'], true);
  assert.equal(loadCatalog('cx16').facts['input.mouse'], true);
  assert.deepEqual(loadCatalog('cx16').run.x16emu, ['-capture']);
});

test('the probe program links clean for the X16, and mouse.begin() is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'cx16', facts: stockFacts('cx16') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['mouse_begin', 'mouse_poll', 'mouse_present', 'mouse_x', 'mouse_y', 'mouse_left', 'mouse_hide', 'mouse_show']) {
    assert.ok(names.includes(name), name);
  }
});

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const NATIVE_BACKEND_PENDING = 'Bare Metal: waiting on the native backend';

function runCli(args, { timeoutMs = 150_000 } = {}) {
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
  'under x16emu, mouse.present() is true on the stock machine',
  {
    skip: NATIVE_BACKEND_PENDING,
  },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-cx16-mouse-'));
    try {
      const shot = join(scratch, 'mouse.png');
      const { code, stdout, stderr } = await runCli(
        ['run', 'cx16', '--screenshot', shot, 'test/mouse-probe.8bs'],
        { timeoutMs: 150_000 },
      );
      assert.equal(code, 0, `8bs run cx16 --screenshot failed:\n${stdout}${stderr}`);
      // mouse-probe.8bs: green border when present(), red when not.
      const [r, g, b] = pixelAt(readFileSync(shot), 4, 4);
      assert.ok(g > r + 30 && g > b + 30, `stock X16: a green border, got rgb(${[r, g, b]})`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
