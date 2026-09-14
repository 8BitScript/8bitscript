// @8bitscript/cx16 — the character set the X16 actually draws from.
//
// `@8bitscript/cx16/text` puts the screen in ISO mode, where VERA's tile
// index IS the character code (see src/index.8bs), and `putChar` writes the
// code straight to DATA0 with no translation table. So which glyphs this
// machine can show is a question about the KERNAL's ISO-8859-15 set, not
// about any code in this repository — and the honest way to answer it is to
// read the ROM `8bs setup cx16` installed rather than to quote a code chart.
//
// That is what this file does, for the one glyph the portable surface cannot
// spell in a string literal: © at 169. The web host's font carries it at the
// same code (packages/cli/src/font8x8.mjs) and so does the NES CHR-ROM
// (packages/nes/native/6502/font.s); this test is why the X16 needed no font
// change of its own to join them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Where `8bs setup cx16` puts the ROM, plus an override for an unusual install. */
function findRom() {
  const candidates = [
    process.env.X16_ROM,
    '/opt/commander-x16/rom.bin',
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, 'rom.bin')),
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

const GLYPH_BYTES = 8;
const SET_GLYPHS = 256;
const glyph = (rom, base, code) => [...rom.subarray(base + code * GLYPH_BYTES, base + (code + 1) * GLYPH_BYTES)];

// Three letters and a blank space, as this ROM draws them. They are the
// anchor that finds the ISO set without hard-coding an address a rebuilt ROM
// could move — and, asserted as artwork rather than as a hash, a failure here
// names what upstream redrew instead of reporting that some number changed.
// Read out of the rom.bin `8bs setup cx16` built on 2026-09-08.
const ANCHORS = [
  [32, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]], // space
  [48, [0x3c, 0x66, 0x6e, 0x76, 0x66, 0x66, 0x3c, 0x00]], // '0'
  [65, [0x18, 0x3c, 0x24, 0x66, 0x7e, 0x66, 0x66, 0x00]], // 'A'
  [90, [0x7e, 0x06, 0x0c, 0x18, 0x30, 0x60, 0x7e, 0x00]], // 'Z'
];

/**
 * The ISO set located by the glyphs it draws rather than by an offset: a
 * PETSCII screen-code set fails this at once, because there code 65 is not
 * 'A'. In the ROM read while writing this there is exactly one such set.
 */
function findIsoCharset(rom) {
  for (let base = 0; base + SET_GLYPHS * GLYPH_BYTES <= rom.length; base += GLYPH_BYTES) {
    if (ANCHORS.every(([code, rows]) => glyph(rom, base, code).every((row, i) => row === rows[i]))) return base;
  }
  return null;
}

const rom = findRom();
const SETUP_PENDING = 'no X16 rom.bin installed: run `8bs setup cx16`';

test('the KERNAL ISO charset is ASCII-indexed, and holds © at 169', { skip: rom ? false : SETUP_PENDING }, () => {
  const bytes = readFileSync(rom);
  const base = findIsoCharset(bytes);
  assert.ok(base !== null, 'no ASCII-indexed character set found in the ROM');

  // The load-bearing fact: something is drawn at 169, so `putChar(cell, 169)`
  // is not a blank cell on this machine...
  assert.ok(glyph(bytes, base, 0xa9).some((row) => row !== 0), '© at 169 has ink');

  // ...and what is drawn is the ring with a C in it that ISO-8859-15 puts
  // there, not some other symbol that happens to occupy the code.
  assert.deepEqual(glyph(bytes, base, 0xa9), [
    0b00011100, // ...###..
    0b00100010, // ..#...#.
    0b01011101, // .#.###.#
    0b01010001, // .#.#...#
    0b01011101, // .#.###.#
    0b00100010, // ..#...#.
    0b00011100, // ...###..
    0b00000000, // ........
  ]);
});
