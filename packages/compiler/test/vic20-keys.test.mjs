// @8bitscript/vic20's keyboard layer: keys.8bs's Key table is well formed
// and agrees with VICE's own positional keyboard map when it is installed.
// Mirrors packages/compiler/test/pet-keys.test.mjs's approach; the VIC-20
// has one matrix and no profile twin, so there is only one table to check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIC20_SRC = join(HERE, '..', '..', 'vic20', 'src');
const VICE_VIC20 = '/opt/homebrew/share/vice/VIC20';

const tableOf = (file) => {
  const text = readFileSync(join(VIC20_SRC, file), 'utf8');
  const body = text.slice(text.indexOf('export namespace Key'));
  return new Map([...body.matchAll(/const (\w+): utinyint = (\d+);/g)].map(([, name, v]) => [name, Number(v)]));
};
const KEY = tableOf('keys.8bs');

test('the table is a set of distinct keys inside the 8 x 8 matrix', () => {
  assert.ok(KEY.size >= 60, `${KEY.size} keys`);
  const values = [...KEY.values()];
  assert.equal(new Set(values).size, values.length, 'no two names share a key');
  for (const [name, v] of KEY) {
    assert.ok(v >= 0 && v < 64, `${name} = ${v} is column ${v >> 3}, row ${v & 7}`);
  }
});

// VICE's positional map: `keysym row column shiftflag` per line. VIC-20
// scan() indexes state[column] with row bits, so Key is `column * 8 + row`
// (VICE's second number * 8 + first). The C64 table uses file order because
// that machine's vkm writes the column first; doing the same here transposed
// every key.
const viceMap = (file) => {
  const path = join(VICE_VIC20, file);
  if (!existsSync(path)) return null;
  const map = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([^\s#!]\S*)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m && !map.has(m[1])) map.set(m[1], Number(m[3]) * 8 + Number(m[2]));
  }
  return map;
};

const LETTERS = Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c) => [c, c.toUpperCase()]));
const DIGITS = Object.fromEntries([...Array(10).keys()].map((d) => [String(d), `DIGIT_${d}`]));
const HOST = {
  ...LETTERS,
  ...DIGITS,
  space: 'SPACE', Return: 'RETURN', Home: 'HOME', Escape: 'RUN_STOP',
  Shift_L: 'SHIFT_LEFT', Shift_R: 'SHIFT_RIGHT', Control_L: 'COMMODORE', Tab: 'CTRL',
  Right: 'CURSOR_LEFT_RIGHT', Left: 'CURSOR_LEFT_RIGHT', Down: 'CURSOR_UP_DOWN', Up: 'CURSOR_UP_DOWN',
  Delete: 'DELETE', BackSpace: 'DELETE', Insert: 'DELETE',
  F1: 'F1', F3: 'F3', F5: 'F5', F7: 'F7',
  comma: 'COMMA', period: 'PERIOD', colon: 'COLON', braceleft: 'AT',
  sterling: 'POUND', bracketright: 'ASTERISK', apostrophe: 'SEMICOLON', question: 'SLASH',
  backslash: 'UP_ARROW', grave: 'LEFT_ARROW',
};

const vice = viceMap('gtk3_pos.vkm');
test('the table agrees with VICE\'s gtk3_pos.vkm', { skip: vice ? false : 'VICE VIC-20 keymap not installed' }, () => {
  let checked = 0;
  for (const [keysym, name] of Object.entries(HOST)) {
    assert.ok(vice.has(keysym), `gtk3_pos.vkm maps ${keysym}`);
    assert.equal(KEY.get(name), vice.get(keysym), `Key.${name} is where VICE puts ${keysym}`);
    checked++;
  }
  assert.ok(checked >= 40, `${checked} keys checked`);
});

test('the four directions and RETURN are the values @8bitscript/vic20/input relies on', () => {
  assert.equal(KEY.get('CURSOR_LEFT_RIGHT'), 23);
  assert.equal(KEY.get('CURSOR_UP_DOWN'), 31);
  assert.equal(KEY.get('SHIFT_LEFT'), 25);
  assert.equal(KEY.get('SHIFT_RIGHT'), 38);
  assert.equal(KEY.get('RETURN'), 15);
  assert.equal(KEY.get('RUN_STOP'), 24);
});

// The scan is VIA2 alone: port B (columns) written, then port A (rows)
// read, inverted once — and it runs before the joystick-right read so
// that borrowed bit 7 sees a keyboard scan already finished for the
// frame, not one still mid-column. Checked on the IR the way
// pet-keys.test.mjs checks PIA1's ports for the PET.
test('keyboard.scan() drives VIA2 port B then reads port A, and input.poll() runs it before reading joystick-right', () => {
  const src = [
    'import { input } from "./input.8bs";',
    'export function main(): void { while (true) { waitFrame(); input.poll(); if (input.left()) { memory.write(0x8000, 1); } } }',
  ].join('\n');
  const entry = join(VIC20_SRC, 'phantom-entry.8bs'); // does not exist: only its directory resolves the relative imports
  const { ir, diagnostics } = link(src, entry, { machine: 'vic20' });
  assert.deepEqual(diagnostics, []);
  const poll = ir.functions.find((f) => f.name === 'input_poll');
  assert.equal(poll.body[0].kind, 'call');
  assert.equal(poll.body[0].name, 'keyboard_scan');
  const dirAssign = poll.body.find((s) => s.kind === 'assign' && s.target === 'via2DirectionB');
  assert.equal(dirAssign.value.operator, '&');
  assert.deepEqual(dirAssign.value.right, { kind: 'const', value: 127 });
  const scan = ir.functions.find((f) => f.name === 'keyboard_scan');
  const loop = scan.body.find((s) => s.kind === 'for');
  assert.equal(loop.body[0].target, 'via2PortB');
  assert.equal(loop.body[0].value.array.name, 'COLUMN_SELECT');
  assert.equal(loop.body[1].kind, 'storeIndex');
  assert.equal(loop.body[1].value.operator, '^');
  assert.equal(loop.body[1].value.left.name, 'via2PortA');
});
