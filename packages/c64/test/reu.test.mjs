// @8bitscript/c64/reu — the first run-time hardware probe. Two layers:
// the probe program links clean for the C64 with the stock sheet (no
// emulator needed), and, when x64sc and the SDK are installed, it is run
// under VICE with no REU and with a 512 KiB one, and the border colour
// each screenshot shows is what reu.detect() found. The border encodes the
// answer (see reu-probe.8bs) so the test reads one pixel, not text.
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
const PROBE = join(HERE, 'reu-probe.8bs');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./reu, and the catalog says the REU is found at run time by it', () => {
  assert.equal(pkg['8bitscript'].exports['./reu'], './src/reu.8bs');
  assert.ok(existsSync(join(ROOT, 'src', 'reu.8bs')));
  const { options } = loadCatalog('c64');
  assert.equal(options.ram.detect, '@8bitscript/c64/reu');
  assert.equal(options.sid.detect, undefined, 'the SID model has no probe yet');
});

test('the probe program links clean for the C64, and reu.detect() is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'c64', facts: stockFacts('c64') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['reu_detect', 'reu_present', 'reu_banks']) assert.ok(names.includes(name), name);
});

// --- Under VICE ---------------------------------------------------------

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const HAS_SDK = Boolean(process.env.LLVM_MOS_HOME);

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

test(
  'under VICE, reu.detect() finds no REU on the stock machine and 512 KiB on one fitted with it',
  { skip: (!HAS_SDK && 'LLVM_MOS_HOME not set') || (!onPath('x64sc') && 'x64sc not on PATH') },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-reu-test-'));
    try {
      const shots = {};
      for (const [name, hardware] of [['none', []], ['reu512', ['--hardware', 'ram=reu512']]]) {
        const shot = join(scratch, `${name}.png`);
        const { code, stdout, stderr } = await runCli(['run', 'c64', ...hardware, '--screenshot', shot, 'test/reu-probe.8bs'], { timeoutMs: 90_000 });
        assert.equal(code, 0, `8bs run c64 ${hardware.join(' ')} --screenshot failed:\n${stdout}${stderr}`);
        shots[name] = pixelAt(readFileSync(shot), 4, 4); // well inside the border
      }
      // reu-probe.8bs: red for no REU (VICE's red is a dark red, R well
      // above G and B), blue for 512 KiB (B well above R and G).
      const [nr, ng, nb] = shots.none;
      assert.ok(nr > ng + 40 && nr > nb + 40, `no REU: a red border, got rgb(${shots.none})`);
      const [r, g, b] = shots.reu512;
      assert.ok(b > r + 40 && b > g + 40, `512 KiB: a blue border, got rgb(${shots.reu512})`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

// --- the 1351 mouse ------------------------------------------------------
//
// @8bitscript/c64/mouse is a probe and a driver at once: a 1351 says
// nothing about itself except through the lines its movement arrives on.
// What can be checked without a hand on the mouse is presence — measured
// under VICE at all four settings of the port, at rest — and that is what
// this covers. Movement decoding is not exercised: nothing in a headless
// run moves the host pointer VICE reads.
const MOUSE_PROBE = join(HERE, 'mouse-probe.8bs');

test('the package exports ./mouse, and a 1351 in a port is the value found at run time by it', () => {
  assert.equal(pkg['8bitscript'].exports['./mouse'], './src/mouse.8bs');
  const { options } = loadCatalog('c64');
  for (const port of ['port1', 'port2']) {
    assert.equal(options[port].values.mouse1351.detect, '@8bitscript/c64/mouse', port);
    assert.equal(options[port].values.joystick.detect, undefined, `${port}: a joystick is invisible at rest`);
    assert.equal(options[port].detect, undefined, `${port}: not the whole option`);
  }
});

test('the mouse probe links clean for the C64, and its parts are real functions in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(MOUSE_PROBE, 'utf8'), MOUSE_PROBE, { machine: 'c64', facts: stockFacts('c64') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['mouse_select', 'mouse_poll', 'mouse_present', 'mouse_step', 'mouse_x', 'mouse_left']) {
    assert.ok(names.includes(name), name);
  }
});

test(
  'under VICE, mouse.present() is true only with a 1351 in the port',
  { skip: (!HAS_SDK && 'LLVM_MOS_HOME not set') || (!onPath('x64sc') && 'x64sc not on PATH') },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-mouse-test-'));
    try {
      for (const [device, expected] of [['mouse1351', true], ['joystick', false], ['none', false], ['paddles', false]]) {
        const shot = join(scratch, `${device}.png`);
        const { code, stdout, stderr } = await runCli(
          ['run', 'c64', '--hardware', `port1=${device}`, '--screenshot', shot, 'test/mouse-probe.8bs'],
          { timeoutMs: 90_000 },
        );
        assert.equal(code, 0, `8bs run c64 --hardware port1=${device} --screenshot failed:\n${stdout}${stderr}`);
        // mouse-probe.8bs: green border when present(), red when not.
        const [r, g, b] = pixelAt(readFileSync(shot), 4, 4);
        const green = g > r + 30 && g > b + 30;
        const red = r > g + 30 && r > b + 30;
        assert.equal(green, expected, `${device}: expected ${expected ? 'a mouse' : 'no mouse'}, got rgb(${[r, g, b]})`);
        assert.equal(red, !expected, `${device}: the other colour, got rgb(${[r, g, b]})`);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
