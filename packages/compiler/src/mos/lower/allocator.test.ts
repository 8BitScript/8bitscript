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
