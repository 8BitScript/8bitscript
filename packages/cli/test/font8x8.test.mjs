import { test } from 'node:test';
import assert from 'node:assert/strict';

import { glyphRows, glyphTableLiteral, BLOCK_CODE_BASE } from '../src/font8x8.mjs';

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

test('glyphRows 128-143 are the sixteen 2×2 quadrant patterns, 4×4 pixels each', () => {
  const empty = glyphRows(BLOCK_CODE_BASE);
  assert.ok(empty);
  assert.deepEqual([...empty], [0, 0, 0, 0, 0, 0, 0, 0]);

  const allOn = glyphRows(BLOCK_CODE_BASE + 15);
  assert.deepEqual([...allOn], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

  // index 1 = bottom-right only
  const br = glyphRows(BLOCK_CODE_BASE + 1);
  assert.deepEqual([...br], [0, 0, 0, 0, 0xf0, 0xf0, 0xf0, 0xf0]);

  // index 8 = top-left only
  const tl = glyphRows(BLOCK_CODE_BASE + 8);
  assert.deepEqual([...tl], [0x0f, 0x0f, 0x0f, 0x0f, 0, 0, 0, 0]);

  assert.equal(glyphRows(127), null);
  assert.equal(glyphRows(144), null);
});

test('glyphTableLiteral lists inked glyphs for the browser page, including blocks', () => {
  const table = glyphTableLiteral();
  assert.match(table, /^\{/);
  assert.match(table, /65:\[/); // 'A'
  assert.match(table, /143:\[255,255,255,255,255,255,255,255\]/);
  assert.doesNotMatch(table, /(^|{)32:\[/); // space is all-zero, omitted
  assert.doesNotMatch(table, /(^|{)128:\[/); // empty block, omitted
});

// PET blocks.8bs DIGIT_TILES remapped onto 128+QUAD-index, decoded back
// to the 4×6 pictures that file documents — so tile.web.8bs's table cannot
// drift from the font it stamps.
const PET_QUAD = [32, 108, 123, 98, 124, 225, 255, 254, 126, 127, 97, 252, 226, 251, 236, 160];
const PET_DIGIT_TILES = [
  236, 97, 97, 97, 252, 97,
  254, 32, 251, 32, 254, 123,
  226, 97, 98, 97, 252, 123,
  226, 97, 98, 97, 98, 97,
  97, 97, 252, 97, 32, 97,
  236, 126, 252, 123, 98, 97,
  236, 126, 252, 123, 252, 97,
  226, 97, 32, 97, 32, 97,
  236, 97, 252, 97, 252, 97,
  236, 97, 252, 97, 98, 97,
];
const DIGIT_FONT = {
  0: ['###.', '#.#.', '#.#.', '#.#.', '#.#.', '###.'],
  1: ['.#..', '##..', '##..', '.#..', '.#..', '###.'],
  2: ['###.', '..#.', '..#.', '###.', '#...', '###.'],
  3: ['###.', '..#.', '..#.', '###.', '..#.', '###.'],
  4: ['#.#.', '#.#.', '#.#.', '###.', '..#.', '..#.'],
  5: ['###.', '#...', '#...', '###.', '..#.', '###.'],
  6: ['###.', '#...', '#...', '###.', '#.#.', '###.'],
  7: ['###.', '..#.', '..#.', '..#.', '..#.', '..#.'],
  8: ['###.', '#.#.', '#.#.', '###.', '#.#.', '###.'],
  9: ['###.', '#.#.', '#.#.', '###.', '..#.', '###.'],
};

test('web block codes 128-143 decode PET digit tiles to the same 4×6 pictures', () => {
  const petToWeb = new Map(PET_QUAD.map((code, index) => [code, BLOCK_CODE_BASE + index]));
  for (let value = 0; value <= 9; value += 1) {
    const rows = ['', '', '', '', '', ''];
    for (let cellRow = 0; cellRow < 3; cellRow += 1) {
      for (let cellCol = 0; cellCol < 2; cellCol += 1) {
        const pet = PET_DIGIT_TILES[value * 6 + cellRow * 2 + cellCol];
        const web = petToWeb.get(pet);
        assert.ok(web !== undefined, `PET code ${pet} is a QUAD pattern`);
        const index = web - BLOCK_CODE_BASE;
        const tl = (index >> 3) & 1, tr = (index >> 2) & 1;
        const bl = (index >> 1) & 1, br = index & 1;
        rows[cellRow * 2] += (tl ? '#' : '.') + (tr ? '#' : '.');
        rows[cellRow * 2 + 1] += (bl ? '#' : '.') + (br ? '#' : '.');
      }
    }
    assert.deepEqual(rows, DIGIT_FONT[value], `digit ${value}`);
  }
});
