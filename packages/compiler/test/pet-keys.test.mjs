// @8bitscript/pet's keyboard layer: the two Key tables (graphics keyboard
// in keys.8bs, business keyboard in keys.pet.8032.8bs) are well formed,
// share the names a program can rely on, agree with VICE's own positional
// keyboard maps when those are installed, and the build's profile picks
// the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PET_SRC = join(HERE, '..', '..', 'pet', 'src');
const VICE_PET = '/opt/homebrew/share/vice/PET';

const tableOf = (file) => {
  const text = readFileSync(join(PET_SRC, file), 'utf8');
  const body = text.slice(text.indexOf('export namespace Key'));
  return new Map([...body.matchAll(/const (\w+): utinyint = (\d+);/g)].map(([, name, v]) => [name, Number(v)]));
};
const GRAPHICS = tableOf('keys.8bs');
const BUSINESS = tableOf('keys.pet.8032.8bs');

// What a program may name on any PET: present in both tables.
const SHARED = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...[...Array(10).keys()].map((d) => `DIGIT_${d}`),
  'SPACE', 'RETURN', 'STOP', 'HOME', 'DELETE', 'CURSOR_RIGHT', 'CURSOR_DOWN',
  'SHIFT_LEFT', 'SHIFT_RIGHT', 'REVERSE', 'LEFT_ARROW', 'UP_ARROW',
  'COMMA', 'PERIOD', 'COLON', 'SEMICOLON', 'SLASH', 'MINUS', 'AT',
  'BRACKET_LEFT', 'BRACKET_RIGHT', 'BACKSLASH',
];

test('each table is a set of distinct keys inside the 10 x 8 matrix', () => {
  for (const [label, table] of [['graphics', GRAPHICS], ['business', BUSINESS]]) {
    assert.ok(table.size >= 60, `${label}: ${table.size} keys`);
    const values = [...table.values()];
    assert.equal(new Set(values).size, values.length, `${label}: no two names share a key`);
    for (const [name, v] of table) {
      assert.ok(v >= 0 && v < 80, `${label}.${name} = ${v} is row ${v >> 3}, column ${v & 7}`);
    }
  }
});

test('the names a program can use on every PET exist in both tables; STOP is row 9 column 4 on both', () => {
  for (const name of SHARED) {
    assert.ok(GRAPHICS.has(name), `graphics has ${name}`);
    assert.ok(BUSINESS.has(name), `business has ${name}`);
  }
  assert.equal(GRAPHICS.get('STOP'), 9 * 8 + 4);
  assert.equal(BUSINESS.get('STOP'), 9 * 8 + 4);
  // The two keyboards are different matrices, not the same one renamed.
  assert.notEqual(GRAPHICS.get('A'), BUSINESS.get('A'));
  for (const name of ['EXCLAMATION', 'PLUS', 'EQUALS']) assert.ok(!BUSINESS.has(name), `${name} is a graphics-keyboard key`);
  for (const name of ['KEYPAD_0', 'TAB', 'ESCAPE', 'REPEAT']) assert.ok(!GRAPHICS.has(name), `${name} is a business-keyboard key`);
});

// VICE's positional maps: `keysym row column shiftflag` per line. The host
// key at a position maps to the PET key at that position, so a host keysym
// names a PET key; these are the pairs whose PET key is unambiguous.
const viceMap = (file) => {
  const path = join(VICE_PET, file);
  if (!existsSync(path)) return null;
  const map = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([^\s#!]\S*)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m && !map.has(m[1])) map.set(m[1], Number(m[2]) * 8 + Number(m[3]));
  }
  return map;
};
const LETTERS = Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c) => [c, c.toUpperCase()]));
const COMMON = {
  ...LETTERS, space: 'SPACE', Return: 'RETURN', Home: 'HOME', Right: 'CURSOR_RIGHT', Down: 'CURSOR_DOWN',
  Delete: 'DELETE', Shift_L: 'SHIFT_LEFT', Shift_R: 'SHIFT_RIGHT', Escape: 'STOP', comma: 'COMMA',
};
const GRAPHICS_HOST = {
  ...COMMON, Tab: 'REVERSE', KP_Decimal: 'PERIOD', KP_Enter: 'EQUALS', KP_Add: 'PLUS',
  semicolon: 'COLON', period: 'SEMICOLON', slash: 'QUESTION', 1: 'EXCLAMATION', 3: 'HASH', 5: 'PERCENT',
  7: 'AMPERSAND', 9: 'PAREN_LEFT', minus: 'LEFT_ARROW', 2: 'QUOTE', 4: 'DOLLAR', 6: 'APOSTROPHE',
  8: 'PAREN_RIGHT', 0: 'BACKSLASH', bracketleft: 'UP_ARROW', grave: 'AT', BackSpace: 'BRACKET_RIGHT',
  backslash: 'GREATER', End: 'MINUS', equal: 'BRACKET_LEFT', bracketright: 'LESS', Page_Up: 'SLASH',
  Page_Down: 'ASTERISK', ...Object.fromEntries([...Array(10).keys()].map((d) => [`KP_${d}`, `DIGIT_${d}`])),
};
const BUSINESS_HOST = {
  ...COMMON, F1: 'ESCAPE', F2: 'REVERSE', Tab: 'TAB', Page_Down: 'REPEAT', KP_Decimal: 'KEYPAD_PERIOD',
  equal: 'MINUS', minus: 'COLON', semicolon: 'SEMICOLON', apostrophe: 'AT', period: 'PERIOD', slash: 'SLASH',
  bracketleft: 'BRACKET_LEFT', bracketright: 'BACKSLASH', End: 'BRACKET_RIGHT', BackSpace: 'UP_ARROW',
  grave: 'LEFT_ARROW',
  ...Object.fromEntries([...Array(10).keys()].map((d) => [`KP_${d}`, `KEYPAD_${d}`])),
  ...Object.fromEntries([...Array(10).keys()].map((d) => [String(d), `DIGIT_${d}`])),
};

for (const [label, file, table, host] of [
  ['graphics', 'gtk3_grus_pos.vkm', GRAPHICS, GRAPHICS_HOST],
  ['business', 'gtk3_buuk_pos.vkm', BUSINESS, BUSINESS_HOST],
]) {
  const vice = viceMap(file);
  test(`the ${label} table agrees with VICE's ${file}`, { skip: vice ? false : 'VICE PET keymaps not installed' }, () => {
    let checked = 0;
    for (const [keysym, name] of Object.entries(host)) {
      assert.ok(vice.has(keysym), `${file} maps ${keysym}`);
      assert.equal(table.get(name), vice.get(keysym), `${label}.${name} is where VICE puts ${keysym}`);
      checked++;
    }
    assert.ok(checked >= 60, `${checked} keys checked`);
  });
}

test('the build\'s profile picks the table: Key.SPACE is 74 on a 3032 and 66 on an 8032', () => {
  const src = [
    'import { keyboard } from "./keyboard.8bs";',
    'import { Key } from "./keys.8bs";',
    'export function main(): void { while (true) { waitFrame(); keyboard.scan(); if (keyboard.pressed(Key.SPACE)) { memory.write(0x8000, 1); } } }',
  ].join('\n');
  const entry = join(PET_SRC, 'phantom-entry.8bs'); // does not exist: only its directory resolves the relative imports
  const pressedSpace = (profile) => {
    const { ir, diagnostics } = link(src, entry, { machine: 'pet', profile });
    assert.deepEqual(diagnostics, [], profile);
    const call = ir.functions.find((f) => f.name === 'main').body[0].body[2].test;
    return call.args[0].value;
  };
  assert.equal(pressedSpace(undefined), 74);
  assert.equal(pressedSpace('3032'), 74);
  assert.equal(pressedSpace('8032'), 66);
  const { ir } = link(src, entry, { machine: 'pet', profile: '3032' });
  const scan = ir.functions.find((f) => f.name === 'keyboard_scan');
  assert.equal(scan.body[0].body[0].target, 'pia1PortA');
  assert.equal(scan.body[0].body[1].value.operator, '^');
  assert.equal(scan.body[0].body[1].value.left.name, 'pia1PortB');
  assert.deepEqual(scan.body[0].body[1].value.right, { kind: 'const', value: 255, type: 'utinyint' });
});

test('a graphics-only key name is a link error on the 8032, not a silent wrong key', () => {
  const src = [
    'import { Key } from "./keys.8bs";',
    'export function main(): void { memory.write(0x8000, Key.EXCLAMATION); }',
  ].join('\n');
  const entry = join(PET_SRC, 'phantom-entry.8bs');
  assert.deepEqual(link(src, entry, { machine: 'pet', profile: '3032' }).diagnostics, []);
  const { diagnostics } = link(src, entry, { machine: 'pet', profile: '8032' });
  assert.ok(diagnostics.length > 0);
  assert.match(diagnostics.map((d) => d.message).join('\n'), /EXCLAMATION/);
});
