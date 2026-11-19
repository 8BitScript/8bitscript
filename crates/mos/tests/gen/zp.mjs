// Regenerates fixtures/zp.json: `placeZp` and `allocate` results from the JS.
// Run from the repo root: node crates/mos/tests/gen/zp.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { placeZp, allocate } from '../../../../packages/compiler/src/mos/zp/index.ts';

const rows = [];
const holes = [{ start: 0xc2, end: 0xda }];
const multi = [{ start: 4, end: 6 }, { start: 7, end: 9 }, { start: 20, end: 22 }];
const placeCases = [
  [0x80, 1, 0x100, []],
  [0x80, 2, 0x100, []],
  [0xff, 1, 0x100, []],
  [0xff, 2, 0x100, []],
  [0x100, 1, 0x100, []],
  [0x120, 1, 0x100, []],
  [0xc1, 2, 0x100, holes],
  [0xc1, 1, 0x100, holes],
  [0xc2, 1, 0x100, holes],
  [0xd9, 1, 0x100, holes],
  [0xda, 1, 0x100, holes],
  [0xb0, 4, 0xd0, holes],
  [0xc0, 4, 0xd0, holes],
  [0xc0, 2, 0xc2, holes],
  [3, 2, 40, multi],
  [3, 3, 40, multi],
  [6, 1, 40, multi],
  [6, 2, 40, multi],
  [19, 2, 22, multi],
  [0, 2, 0, []],
  [5, 1, 3, []],
  [0x90, 4, 0xa0, undefined],
];
for (const [cursor, size, ceiling, h] of placeCases) {
  const args = h === undefined ? [cursor, size, ceiling] : [cursor, size, ceiling, h];
  rows.push({ fn: 'placeZp', args, result: placeZp(...args) });
}

const g = (name, type, extra = {}) => ({ name, type, volatile: false, address: null, init: 0, exported: false, ...extra });
const budgets = [
  { zpOrigin: 0x02, zpCeiling: 0x100 },
  { zpOrigin: 0x80, zpCeiling: 0x84 },
  { zpOrigin: 0xc0, zpCeiling: 0x100, holes },
  { zpOrigin: 0x90, zpCeiling: 0x90 },
  { zpOrigin: 0x00, zpCeiling: 0x00 },
];
const globalSets = [
  [],
  [g('a', 'utinyint'), g('b', 'usmallint'), g('c', 'bool')],
  [g('p', 'u8', { address: 0xd020 }), g('q', 'u16'), g('r', 'umediumint', { init: null })],
  [g('arr', 'utinyint', { array: 8, init: [1, 2, 3] }), g('k', 'u8', { constant: true, array: 3, init: [9, 8, 7] }), g('x', 'i16')],
  [g('s', 'string')],
  [g('x', 'u8'), g('u', 'float')],
  [g('a', 'i32'), g('b', 'i32'), g('c', 'i32'), g('d', 'i32')],
  [g('w', 'u8'), g('z', 'u32'), g('y', 'u8')],
  [g('a', 'u16'), g('b', 'u16'), g('c', 'u16'), g('d', 'u16'), g('e', 'u16'), g('f', 'u16'), g('g', 'u16'), g('h', 'u16'), g('i', 'u16'), g('j', 'u16'), g('k', 'u16'), g('l', 'u16')],
  [g('pin', 'u8', { address: 0 })],
  [g('bad', 'nope', { init: undefined })],
];
for (const globals of globalSets) {
  for (const budget of budgets) {
    rows.push({ fn: 'allocate', args: [globals, budget], result: allocate(globals, budget) });
  }
}

const out = fileURLToPath(new URL('../fixtures/zp.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('../fixtures', import.meta.url)), { recursive: true });
writeFileSync(out, `${JSON.stringify(rows)}\n`);
