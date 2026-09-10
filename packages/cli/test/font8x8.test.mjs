import { test } from 'node:test';
import assert from 'node:assert/strict';

import { glyphRows } from '../src/font8x8.mjs';

test('glyphRows returns eight row-bytes for ASCII 32-122 and null outside that range', () => {
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
  assert.equal(glyphRows(123), null);
  assert.equal(glyphRows(0), null);
});

test('glyphRows covers lower case too — the portable character set the checker allows, not just upper case', () => {
  const lowerA = glyphRows(97); // 'a'
  assert.ok(lowerA);
  assert.equal(lowerA.length, 8);
  assert.ok(lowerA.some((row) => row !== 0), 'a is not a blank cell');
  // 'A' and 'a' are genuinely different glyphs, not the same bitmap reused —
  // this is what would happen if a fix silently upper-cased instead of
  // actually adding the lower-case rows.
  assert.notDeepEqual([...lowerA], [...glyphRows(65)]);

  const lowerZ = glyphRows(122); // 'z', the last lower-case letter
  assert.ok(lowerZ);
  assert.equal(lowerZ.length, 8);
  assert.ok(lowerZ.some((row) => row !== 0), 'z is not a blank cell');
});
