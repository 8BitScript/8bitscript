// @8bitscript/cx16/input — keyboard joystick + SNES pads behind the
// portable surface. waitFrame() holds sei, so poll() has to call
// joystick_scan / kbd_scan / joystick_get itself; the default IRQ never
// does. Bits are taken from the ROM this package was verified against
// (kernal/drivers/x16/joystick.s): Enter is START on joy0, which is why
// 2048's title screen can leave the title at all. `--screenshot` cannot
// press keys, so this file locks the KERNAL addresses and the bit table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROBE = join(HERE, 'input-probe.8bs');
const SOURCE = readFileSync(join(ROOT, 'src', 'input.8bs'), 'utf8');
const ROM_JOY = join(homedir(), '.cache/8bitscript/setup/x16-rom/kernal/drivers/x16/joystick.s');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const v of Object.values(node)) walk(v, visit);
};

test('the package exports ./input', () => {
  assert.equal(pkg['8bitscript'].exports['./input'], './src/input.8bs');
  assert.ok(existsSync(join(ROOT, 'src', 'input.8bs')));
});

test('the probe links clean for the X16, and every answer is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'cx16', facts: stockFacts('cx16') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['input_begin', 'input_poll', 'input_left', 'input_right', 'input_up', 'input_down', 'input_confirm', 'input_cancel']) {
    assert.ok(names.includes(name), name);
  }
});

test('poll() calls joystick_scan, kbd_scan and joystick_get, and or\'s START into confirm', () => {
  const body = SOURCE.slice(SOURCE.indexOf('function poll'), SOURCE.indexOf('function left'));
  assert.match(body, /jsr \$FF53/, 'joystick_scan — IRQ is off, so poll() must query the pads');
  assert.match(body, /jsr \$FF9F/, 'kbd_scan — joy0 only updates when the keyboard is scanned');
  assert.match(body, /jsr \$FF56/, 'joystick_get');
  assert.match(body, /lda #0/, 'joy0 is the keyboard joystick: Enter is START');
  assert.match(body, /lda #1/, 'joy1 is SNES port 1');
  assert.match(body, /lda #2/, 'joy2 is SNES port 2');
  assert.match(SOURCE, /held = held \| Edge\.CONFIRM/);
  assert.match(SOURCE, /const START: utinyint = 16;/);
  assert.doesNotMatch(SOURCE, /stay false/);
});

test('the IR of poll() actually emits those KERNAL calls', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'cx16', facts: stockFacts('cx16') });
  assert.deepEqual(diagnostics, []);
  const poll = ir.functions.find((f) => f.name === 'input_poll');
  const texts = [];
  walk(poll, (n) => {
    if (n.kind === 'asm' && typeof n.text === 'string') texts.push(n.text);
  });
  const blob = texts.join('\n');
  assert.match(blob, /\$FF53/);
  assert.match(blob, /\$FF9F/);
  assert.match(blob, /\$FF56/);
});

test('the SNES bits agree with the X16 ROM joystick driver', { skip: existsSync(ROM_JOY) ? false : 'x16-rom joystick.s not in the setup cache' }, () => {
  const rom = readFileSync(ROM_JOY, 'utf8');
  assert.match(rom, /C_RT = 1/);
  assert.match(rom, /C_LT = 2/);
  assert.match(rom, /C_DN = 4/);
  assert.match(rom, /C_UP = 8/);
  assert.match(rom, /C_ST = 16/);
  assert.match(rom, /C_SL = 32/);
  assert.match(rom, /C_B  = 128/);
  assert.match(rom, /C_A  = 128/);
  assert.match(rom, /KEYCODE_ENTER/);
  const snes = SOURCE.slice(SOURCE.indexOf('namespace Snes'), SOURCE.indexOf('namespace SnesHi'));
  assert.match(snes, /const RIGHT: utinyint = 1;/);
  assert.match(snes, /const LEFT: utinyint = 2;/);
  assert.match(snes, /const DOWN: utinyint = 4;/);
  assert.match(snes, /const UP: utinyint = 8;/);
  assert.match(snes, /const START: utinyint = 16;/);
  assert.match(snes, /const SELECT: utinyint = 32;/);
  assert.match(snes, /const B: utinyint = 128;/);
});
