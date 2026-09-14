// @8bitscript/c128/input — CIA1 plus the dedicated cursor keys on $D02F.
//
// Two layers here: the probe links clean for the C128 with every answer
// reachable in the IR; and the source drives VIC-IIe K2 (`$D02F = $FB`)
// in the order the hardware requires, with bit numbers taken from VICE's
// own C128 positional map. x128 sends host arrows to those keys in C128
// mode (`Up 10 3` …), not to the C64 CRSR pair — a CIA1-only scan made
// the arrows do nothing. `--screenshot` cannot press keys, so the
// behavioral proof is a hand run under x128; this file locks the matrix
// against the keymap that run uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROBE = join(HERE, 'input-probe.8bs');
const SOURCE = readFileSync(join(ROOT, 'src', 'input.8bs'), 'utf8');
const VICE_C128 = '/opt/homebrew/share/vice/C128';

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

test('the probe links clean for the C128, and every answer is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'c128', facts: stockFacts('c128') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['input_begin', 'input_poll', 'input_left', 'input_right', 'input_up', 'input_down', 'input_confirm', 'input_cancel']) {
    assert.ok(names.includes(name), name);
  }
});

test('poll() isolates the C64 matrix, then reads K2, then restores $D02F before the sticks', () => {
  const body = SOURCE.slice(SOURCE.indexOf('function poll'), SOURCE.indexOf('function left'));
  const none1 = body.indexOf('extraKeyboardLines = EXTRA_NONE');
  const k2 = body.indexOf('extraKeyboardLines = EXTRA_K2');
  const none2 = body.indexOf('extraKeyboardLines = EXTRA_NONE', k2);
  const sticks = body.indexOf('sticks[0]');
  assert.ok(none1 !== -1 && none1 < k2, 'C64 scan runs with extra columns deselected');
  assert.ok(k2 !== -1 && k2 < none2, 'K2 is selected for the dedicated arrows');
  assert.ok(none2 !== -1 && none2 < sticks, '$D02F is restored before the joystick read: K2 bit 3/4 is joystick right/fire');
  assert.match(SOURCE, /const EXTRA_K2: utinyint = 0xFB;/);
  assert.match(SOURCE, /const EXTRA_NONE: utinyint = 0xFF;/);
});

test('poll() or\'s the dedicated arrows into held, and the IR writes $D02F', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'c128', facts: stockFacts('c128') });
  assert.deepEqual(diagnostics, []);
  const poll = ir.functions.find((f) => f.name === 'input_poll');
  const values = [];
  walk(poll, (n) => {
    if (n.kind === 'assign' && n.target === 'extraKeyboardLines' && n.value?.kind === 'const') {
      values.push(n.value.value);
    }
  });
  assert.deepEqual(values, [0xFF, 0xFB, 0xFF], 'none, K2, none — extra bits must not leak into the stick snapshot');
  const body = SOURCE.slice(SOURCE.indexOf('function poll'), SOURCE.indexOf('function left'));
  assert.match(body, /extra & Extra\.LEFT/);
  assert.match(body, /extra & Extra\.RIGHT/);
  assert.match(body, /extra & Extra\.UP/);
  assert.match(body, /extra & Extra\.DOWN/);
});

const viceArrows = () => {
  const path = join(VICE_C128, 'gtk3_pos.vkm');
  if (!existsSync(path)) return null;
  const map = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^(Up|Down|Left|Right)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    if (Number(m[4]) & 0x100) continue;
    map.set(m[1], { column: Number(m[2]), row: Number(m[3]) });
  }
  return map.size === 4 ? map : null;
};

const vice = viceArrows();
test('the K2 bits agree with VICE\'s C128-mode gtk3_pos.vkm', { skip: vice ? false : 'VICE C128 keymap not installed' }, () => {
  for (const name of ['Up', 'Down', 'Left', 'Right']) {
    assert.ok(vice.has(name), `gtk3_pos.vkm maps ${name} in C128 mode`);
    assert.equal(vice.get(name).column, 10, `${name} is extra column K2`);
  }
  const extraNs = SOURCE.slice(SOURCE.indexOf('namespace Extra'), SOURCE.indexOf('}', SOURCE.indexOf('namespace Extra')));
  const extra = Object.fromEntries([...extraNs.matchAll(/const (UP|DOWN|LEFT|RIGHT): utinyint = (\d+);/g)].map(([, n, v]) => [n, Number(v)]));
  assert.equal(extra.UP, 1 << vice.get('Up').row);
  assert.equal(extra.DOWN, 1 << vice.get('Down').row);
  assert.equal(extra.LEFT, 1 << vice.get('Left').row);
  assert.equal(extra.RIGHT, 1 << vice.get('Right').row);
  assert.equal(0xFF ^ (1 << (10 - 8)), 0xFB, 'column 10 is $D02F bit 2, driven by $FB');
});
