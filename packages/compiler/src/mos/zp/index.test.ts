import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allocate } from './index.ts';
import type { IrGlobal } from './index.ts';

const scalar = (name: string, type: string): IrGlobal => ({ name, type, address: null });
const pinned = (name: string, type: string, address: number): IrGlobal => ({ name, type, address });

const BUDGET = { zpOrigin: 0x8e, zpCeiling: 0x100 }; // the PET's own real free range: see mos/index.ts's PET_ZP_BUDGET

test('scalars get sequential zp addresses, in declaration order, with no gaps', () => {
  const result = allocate([scalar('currentColor', 'utinyint'), scalar('currentReverse', 'bool')], BUDGET);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.globals, [
    { name: 'currentColor', address: 0x8e, storage: 'zp', size: 1 },
    { name: 'currentReverse', address: 0x8f, storage: 'zp', size: 1 },
  ]);
  assert.equal(result.zpUsed, 2);
});

test('allocation is a pure function of the input: run twice, same addresses both times', () => {
  const globals = [scalar('a', 'utinyint'), scalar('b', 'usmallint'), scalar('c', 'utinyint')];
  assert.deepEqual(allocate(globals, BUDGET), allocate(globals, BUDGET));
});

test('a wider type takes more zp bytes: usmallint is 2, utinyint is 1', () => {
  const result = allocate([scalar('wide', 'usmallint'), scalar('narrow', 'utinyint')], BUDGET);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.globals, [
    { name: 'wide', address: 0x8e, storage: 'zp', size: 2 },
    { name: 'narrow', address: 0x90, storage: 'zp', size: 1 },
  ]);
});

test('a global already pinned by @address(...) is left alone: no zp budget spent, its own address kept', () => {
  const result = allocate([pinned('VIC_COLOR', 'utinyint', 0x900f), scalar('after', 'utinyint')], BUDGET);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.globals, [
    { name: 'VIC_COLOR', address: 0x900f, storage: 'pinned', size: 0 },
    { name: 'after', address: 0x8e, storage: 'zp', size: 1 },
  ]);
  assert.equal(result.zpUsed, 1, 'the pinned global never touched the zp budget');
});

test('exceeding the zp budget is a build error naming the variable and the exact bytes left', () => {
  // 0x8e..0xff is 114 bytes. 113 one-byte globals fill it to exactly one
  // byte free ($00FF); the 114th, needing two bytes, cannot fit.
  const globals = [
    ...Array.from({ length: 113 }, (_, i) => scalar(`g${i}`, 'utinyint')),
    scalar('tooWide', 'usmallint'),
  ];
  const result = allocate(globals, BUDGET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /^global 'tooWide' needs 2 byte\(s\) of zero page but only 1 byte\(s\) remain \(\$00FF\.\.\$00FF\)$/);
});

test('a mutable array global is refused, naming it — only a const array is placed today', () => {
  const result = allocate([{ name: 'table', type: 'utinyint', address: null, array: 16, constant: false }], BUDGET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /^global 'table': a mutable array\/string<N> isn't allocated yet — only a const array is placed today$/);
});

test('a const array global is skipped entirely: no zp spent, no address assigned, later scalars unaffected', () => {
  const result = allocate([
    { name: 'DIGIT_PLACES', type: 'usmallint', address: null, array: 5, constant: true },
    scalar('after', 'utinyint'),
  ], BUDGET);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.globals, [{ name: 'after', address: 0x8e, storage: 'zp', size: 1 }]);
  assert.equal(result.zpUsed, 1, 'the const array never touched the zp budget');
});

test('a string global is refused, naming it', () => {
  const result = allocate([scalar('label', 'string')], BUDGET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /^global 'label': a bare string global isn't allocated yet$/);
});

test('an unrecognized type is refused, naming it, rather than guessed at 0 or 1 byte', () => {
  const result = allocate([scalar('mystery', 'not_a_real_type')], BUDGET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /^global 'mystery': unknown type 'not_a_real_type', can't size it$/);
});

test('an empty globals list allocates nothing and spends no budget', () => {
  assert.deepEqual(allocate([], BUDGET), { ok: true, globals: [], zpUsed: 0 });
});

test('a hole is skipped rather than occupied, including a 2-byte slot that would straddle it', () => {
  const holes = [{ start: 0xc2, end: 0xda }];
  const budget = { zpOrigin: 0x8e, zpCeiling: 0x100, holes };
  const globals = [
    ...Array.from({ length: 0xc2 - 0x8e }, (_, i) => scalar(`g${i}`, 'utinyint')),
    scalar('afterHole', 'usmallint'),
  ];
  const result = allocate(globals, budget);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const after = result.globals.find((g) => g.name === 'afterHole');
  assert.equal(after?.address, 0xda, 'the usmallint must not put its high byte inside the hole');
  assert.ok(result.globals.every((g) => g.address + g.size <= 0xc2 || g.address >= 0xda));
});
