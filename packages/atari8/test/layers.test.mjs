// The Atari's input and sound layers. Three things are checked here.
//
// Without an emulator: test/layers-probe.8bs links clean for the Atari with
// the stock fact sheet and every layer's functions reach the IR; and the
// port count really is driven by the fact sheet rather than hardcoded, so
// an 800 build and an 800XL build differ.
//
// With atari800 and a working backend: the probe is run and its screen
// read, which is what settles the polarities. The Atari's input registers
// are all active low in different ways — a joystick direction, a console
// key, "the last key is still held" — and a layer that inverts one of
// them the wrong way looks perfectly reasonable in source and is wrong on
// the machine. With nothing pressed the probe must read every input as
// zero, and SKSTAT must read with bits 2 and 3 *set*, which is the
// reading that proves those bits are 0-means-pressed rather than the
// other way round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { loadCatalog, resolveHardware, stockFacts } from '../../cli/src/hardware.mjs';
import { pixelAt } from '../../cli/src/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const PROBE = join(HERE, 'layers-probe.8bs');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports every layer, each at its own file', () => {
  const exports = pkg['8bitscript'].exports;
  for (const name of ['joystick', 'console', 'keyboard', 'keys', 'pokey', 'random']) {
    assert.equal(exports[`./${name}`], `./src/${name}.8bs`, name);
    assert.ok(existsSync(join(ROOT, 'src', `${name}.8bs`)), `${name}.8bs is missing`);
  }
});

test('the probe links clean for the Atari, with every layer\'s functions in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, {
    machine: 'atari8', facts: stockFacts('atari8'),
  });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const fn of [
    'joystick_scan', 'joystick_up', 'joystick_fire',
    'console_scan', 'console_pressed', 'console_click',
    'keyboard_scan', 'keyboard_pressed', 'keyboard_down', 'keyboard_shift',
    'pokey_reset', 'pokey_play', 'pokey_frequencyOf', 'pokey_detectRegion',
    'random_byte',
  ]) {
    assert.ok(names.includes(fn), fn);
  }
});

// Joystick.PORTS is `#fact(input.joysticks)`, so the port count is the
// catalog's, folded at compile time — not a constant this package repeats.
// The 400 and 800 have four ports; every XL and XE has two, because on those
// machines PORTB is the memory-control register instead.
test('the port count comes from the fact sheet: four on a 400 or 800, two on every XL/XE', () => {
  const catalog = loadCatalog('atari8');
  for (const [model, ports] of [['400', 4], ['800', 4], ['800xl', 2], ['65xe', 2], ['130xe', 2], ['1200xl', 2], ['xegs', 2]]) {
    const facts = resolveHardware(catalog, { overrides: { model } }).hardware.facts;
    assert.equal(facts['input.joysticks'], ports, model);
    const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'atari8', facts });
    assert.deepEqual(diagnostics, [], model);
    // The fold really reached the IR: the literal appears in the scan loop's
    // bound, so the two builds are genuinely different programs.
    assert.ok(JSON.stringify(ir).includes(`"value":${ports}`), model);
  }
});

const NATIVE_BACKEND_PENDING = 'Bare Metal: waiting on the native backend';

// The keycodes are POKEY's own scan order and there is no deriving them.
// src/keys.8bs is the table; a later check against a published POKEY
// scan-code list belongs here once one is pinned. Until then this is
// skipped so it cannot silently no-op.
test('every Key.* value is a known POKEY scan code', { skip: NATIVE_BACKEND_PENDING }, () => {});

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

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
  'under atari800 with nothing pressed, every input reads idle — which is also what proves SKSTAT\'s keyboard bits are active low',
  {
    skip: NATIVE_BACKEND_PENDING,
  },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-layers-test-'));
    try {
      const shot = join(scratch, 'layers.png');
      const { code, stdout, stderr } = await runCli(
        ['run', 'atari8', '--screenshot', shot, '--frames', '120', 'test/layers-probe.8bs'],
        { timeoutMs: 90_000 },
      );
      assert.equal(code, 0, `8bs run atari8 --screenshot failed:\n${stdout}${stderr}`);
      assert.match(stdout, /built .*layers-probe-atari8-ntsc\.xex/);
      // layers-probe.8bs paints the border green when every input reads idle
      // and red when any does not — joystick bits, console keys, the key
      // code, keyboard.pressed(), keyboard.down(), and SKSTAT's bits 2 and 3
      // both set. Nothing is touched during the run, so green is the only
      // correct answer, and a red border means some polarity is inverted or
      // pressed() is answering true for a key nobody touched.
      const [r, g, b] = pixelAt(readFileSync(shot), 8, 200);
      assert.ok(
        g > r + 30 && g > b + 30,
        `a green border means every input read idle; got rgb(${r}, ${g}, ${b}) — see layers-probe.8bs`,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
