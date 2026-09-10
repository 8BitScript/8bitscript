import { test } from 'node:test';
import assert from 'node:assert/strict';

import { arrayLabel, buildDataSection, stringLabel } from './data.ts';
import type { ConstArrayGlobal, IrString } from './data.ts';
import { assemble } from './asm/assemble.ts';

test('stringLabel and arrayLabel are deterministic and distinct from each other', () => {
  assert.equal(stringLabel(0), stringLabel(0));
  assert.notEqual(stringLabel(0), stringLabel(1));
  assert.notEqual(stringLabel(0), arrayLabel('0'));
});

test('a string lays out as its length byte, then its own bytes, under its own label', () => {
  const strings: IrString[] = [{ text: 'HI', bytes: [72, 73] }];
  const section = buildDataSection(strings, []);
  assert.deepEqual(section, [
    { kind: 'label', name: stringLabel(0) },
    { kind: 'byte', values: [2, 72, 73] },
  ]);
});

test('every string gets its own label, in ir.strings order — index 0, 1, 2, ...', () => {
  const strings: IrString[] = [{ text: 'A', bytes: [65] }, { text: 'B', bytes: [66] }];
  const section = buildDataSection(strings, []);
  assert.deepEqual(section.filter((d) => d.kind === 'label').map((d) => (d as { name: string }).name), [stringLabel(0), stringLabel(1)]);
});

// The checker's own STRING_TOO_LONG rule refuses anything longer before a
// backend ever sees it, so 255 is the real ceiling this format can express
// (one length byte) — not lowered as a special case, just laid out exactly
// like any other string.
test('a 255-byte string lowers to exactly 256 bytes: the length, then every character', () => {
  const text = 'x'.repeat(255);
  const strings: IrString[] = [{ text, bytes: Array.from({ length: 255 }, () => 'x'.charCodeAt(0)) }];
  const section = buildDataSection(strings, []);
  const bytes = section.find((d) => d.kind === 'byte') as { values: number[] };
  assert.equal(bytes.values.length, 256);
  assert.equal(bytes.values[0], 255);
  assert.ok(bytes.values.slice(1).every((b) => b === 120));
});

test('a 1-byte-element const array lays out its elements verbatim, under its own label', () => {
  const arrays: ConstArrayGlobal[] = [{ name: 'TABLE', type: 'utinyint', array: 3, init: [10, 20, 30] }];
  const section = buildDataSection([], arrays);
  assert.deepEqual(section, [
    { kind: 'label', name: arrayLabel('TABLE') },
    { kind: 'byte', values: [10, 20, 30] },
  ]);
});

// DIGIT_PLACES itself (packages/pet/src/text.8bs): const DIGIT_PLACES: array<usmallint, 5> = [10000, 1000, 100, 10, 1];
test('a 2-byte-element const array lays out each element little-endian, low byte first', () => {
  const arrays: ConstArrayGlobal[] = [{ name: 'DIGIT_PLACES', type: 'usmallint', array: 5, init: [10000, 1000, 100, 10, 1] }];
  const section = buildDataSection([], arrays);
  const bytes = section.find((d) => d.kind === 'byte') as { values: number[] };
  assert.deepEqual(bytes.values, [
    10000 & 0xff, (10000 >> 8) & 0xff,
    1000 & 0xff, (1000 >> 8) & 0xff,
    100 & 0xff, 0,
    10 & 0xff, 0,
    1, 0,
  ]);
});

test('strings come before const arrays, in ir.strings/globals order — a deterministic layout, same input every time', () => {
  const strings: IrString[] = [{ text: 'HI', bytes: [72, 73] }];
  const arrays: ConstArrayGlobal[] = [{ name: 'TABLE', type: 'utinyint', array: 1, init: [1] }];
  const a = buildDataSection(strings, arrays);
  const b = buildDataSection(strings, arrays);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((d) => d.kind === 'label' ? d.name : null).filter(Boolean), [stringLabel(0), arrayLabel('TABLE')]);
});

test('the whole section assembles: every label lands where its own preceding byte count says it should', () => {
  const strings: IrString[] = [{ text: 'HI', bytes: [72, 73] }, { text: 'A', bytes: [65] }];
  const arrays: ConstArrayGlobal[] = [{ name: 'PAIR', type: 'usmallint', array: 1, init: [300] }];
  const section = buildDataSection(strings, arrays);
  const result = assemble(section, 0x2000);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  // str0 (3 bytes) at $2000, str1 (2 bytes) at $2003, PAIR (2 bytes) at $2005.
  assert.equal(result.labels.get(stringLabel(0)), 0x2000);
  assert.equal(result.labels.get(stringLabel(1)), 0x2003);
  assert.equal(result.labels.get(arrayLabel('PAIR')), 0x2005);
  assert.deepEqual([...result.bytes], [2, 72, 73, 1, 65, 300 & 0xff, (300 >> 8) & 0xff]);
});

test('no strings and no const arrays lays out to nothing', () => {
  assert.deepEqual(buildDataSection([], []), []);
});
