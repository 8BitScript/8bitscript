import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LocalAllocator, ZpBudgetError } from './allocator.ts';

test('allocates upward from the origin, one byte at a time', () => {
  const a = new LocalAllocator(0x90, 0x100);
  assert.equal(a.alloc('x'), 0x90);
  assert.equal(a.alloc('y'), 0x91);
  assert.equal(a.used, 2);
});

test('release(mark) frees everything allocated since the mark, for reuse', () => {
  const a = new LocalAllocator(0x90, 0x100);
  const mark = a.mark();
  a.alloc('temp1');
  a.alloc('temp2');
  a.release(mark);
  assert.equal(a.alloc('temp3'), 0x90); // reused, not 0x92
});

test('`used` reports the high-water mark, not what is live at the end', () => {
  const a = new LocalAllocator(0x90, 0x100);
  const mark = a.mark();
  a.alloc('a');
  a.alloc('b');
  a.release(mark);
  a.alloc('c');
  assert.equal(a.used, 2); // two were live at once, even though only one is now
});

test('marks nest: an inner release only frees back to its own mark, not past an outer one', () => {
  const a = new LocalAllocator(0x90, 0x100);
  a.alloc('outer');
  const innerMark = a.mark();
  a.alloc('inner');
  a.release(innerMark);
  assert.equal(a.alloc('sibling'), innerMark); // inner's slot is reused; outer's is not
});

test('exhausting the budget throws ZpBudgetError naming what did not fit and what is left', () => {
  const a = new LocalAllocator(0xff, 0x100); // exactly one byte of room
  a.alloc("local 'a'");
  assert.throws(() => a.alloc("local 'b'"), (error: unknown) => {
    assert.ok(error instanceof ZpBudgetError);
    assert.match((error as Error).message, /local 'b' needs 1 byte of zero page but only 0 byte\(s\) remain/);
    return true;
  });
});

test('alloc16 hands out two adjacent bytes, low then high', () => {
  const a = new LocalAllocator(0x90, 0x100);
  assert.equal(a.alloc16('pair'), 0x90); // pair occupies $90 (lo) and $91 (hi)
  assert.equal(a.used, 2);
  assert.equal(a.alloc('next'), 0x92); // the bump cursor moved past both bytes
});

test('alloc16 refuses when only one byte remains, naming the 2-byte need', () => {
  const a = new LocalAllocator(0xff, 0x100); // exactly one byte of room
  assert.throws(() => a.alloc16("local 'cell'"), (error: unknown) => {
    assert.ok(error instanceof ZpBudgetError);
    assert.match((error as Error).message, /local 'cell' needs 2 byte\(s\) of zero page but only 1 byte\(s\) remain/);
    return true;
  });
});

test('alloc16 participates in mark/release like alloc does', () => {
  const a = new LocalAllocator(0x90, 0x100);
  const mark = a.mark();
  a.alloc16('pair');
  a.release(mark);
  assert.equal(a.alloc16('reused'), 0x90);
});
