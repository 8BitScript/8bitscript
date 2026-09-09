import { test } from 'node:test';
import assert from 'node:assert/strict';

import { glyphRows } from '../src/font8x8.mjs';

test('glyphRows returns eight row-bytes for ASCII 32-95 and null outside that range', () => {
  const space = glyphRows(32);
  assert.ok(space);
  assert.equal(space.length, 8);
  assert.deepEqual([...space], [0, 0, 0, 0, 0, 0, 0, 0]);

  const a = glyphRows(65); // 'A'
  assert.ok(a);
  assert.equal(a.length, 8);
  assert.ok(a.some((row) => row !== 0), 'A is not a blank cell');

  const underscore = glyphRows(95);
  assert.ok(underscore);
  assert.equal(underscore.length, 8);

  assert.equal(glyphRows(31), null);
  assert.equal(glyphRows(96), null);
  assert.equal(glyphRows(0), null);
});
