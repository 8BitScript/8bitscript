// The VIC-II model the C64's wasm page paints with (src/web-vic.mjs): the list
// of register writes raster.8bs leaves in memory, and the eight hardware
// sprites. Pure functions of a memory image, so each rule is tested on a
// hand-built one with the pixel it must produce written out, not derived.
//
// The coordinates are the machine's: a sprite at (X, Y) has its first pixel at
// picture column X - 24 and its first row on picture row Y - 50 (raster line
// Y + 1; the picture's first line is 51), and a list entry at raster line L
// changes what is drawn from line L + 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vicReadWrites, vicRowBase, vicSprites, vicSource } from '../src/web-vic.mjs';
import { layoutForRealMachine } from '../src/web-layout.mjs';

const W = 320;
const H = 200;
const vic = layoutForRealMachine('c64', { facts: { 'video.columns': 40, 'video.rows': 25 } }).vic;
const BLOCK = 144; // the first shape block a program owns: $E400

/** A fresh memory image and output buffers. */
function machine() {
  return { mem: new Uint8Array(65536), out: { color: new Int8Array(W * H), behind: new Uint8Array(W * H) } };
}

/** Fill shape block `block` from a function (row, byteIndex) -> byte. */
function shape(mem, block, byteAt) {
  for (let row = 0; row < 21; row += 1) {
    for (let b = 0; b < 3; b += 1) mem[vic.spriteBank + block * 64 + row * 3 + b] = byteAt(row, b);
  }
}

/** Sprite `n` at (x, y), enabled, pointing at `block`, own colour `color`. */
function place(mem, n, x, y, block, color) {
  mem[vic.spriteRegs + n * 2] = x & 0xff;
  mem[vic.spriteRegs + n * 2 + 1] = y;
  mem[vic.spriteRegs + 0x10] = (mem[vic.spriteRegs + 0x10] & ~(1 << n)) | (x > 255 ? 1 << n : 0);
  mem[vic.spriteRegs + 0x15] |= 1 << n;
  mem[vic.spriteRegs + 0x27 + n] = color;
  mem[vic.spritePointers + n] = block;
}

const run = ({ mem, out }, writes = []) => vicSprites(mem, vic, writes, W, H, out);
const at = (out, x, y) => out.color[y * W + x];

test('a hires sprite draws its 24x21 pixels with the first at column X - 24, row Y - 50', () => {
  const m = machine();
  shape(m.mem, BLOCK, () => 0xff);
  place(m.mem, 0, 100, 100, BLOCK, 5);
  assert.equal(run(m), true);
  assert.equal(at(m.out, 76, 50), 5, 'the top-left pixel');
  assert.equal(at(m.out, 99, 70), 5, 'the bottom-right pixel');
  assert.equal(at(m.out, 75, 50), -1, 'left of it');
  assert.equal(at(m.out, 100, 50), -1, 'right of it');
  assert.equal(at(m.out, 76, 49), -1, 'above it');
  assert.equal(at(m.out, 76, 71), -1, 'below it');
});

test('bit 7 of a shape byte is its leftmost pixel', () => {
  const m = machine();
  shape(m.mem, BLOCK, (row, b) => (row === 0 && b === 0 ? 0b10100000 : 0));
  place(m.mem, 0, 24, 50, BLOCK, 7);
  run(m);
  assert.deepEqual([0, 1, 2, 3].map((x) => at(m.out, x, 0)), [7, -1, 7, -1]);
});

test('X is nine bits: $D010 bit n is bit 8 of sprite n\'s X, and the picture clips at 320', () => {
  const m = machine();
  shape(m.mem, BLOCK, () => 0xff);
  place(m.mem, 3, 300, 60, BLOCK, 2);
  assert.equal(m.mem[vic.spriteRegs + 6], 300 - 256, 'the low byte');
  assert.equal(m.mem[vic.spriteRegs + 0x10], 8, 'bit 3 of $D010');
  run(m);
  assert.equal(at(m.out, 275, 10), -1, 'left of column 276');
  assert.equal(at(m.out, 276, 10), 2, 'X 300 is column 276');
  assert.equal(at(m.out, 299, 10), 2);
  assert.equal(at(m.out, 300, 10), -1);
  // Past the right edge a sprite is clipped, not wrapped.
  const edge = machine();
  shape(edge.mem, BLOCK, () => 0xff);
  place(edge.mem, 0, 330, 60, BLOCK, 4);
  run(edge);
  assert.equal(at(edge.out, 306, 10), 4);
  assert.equal(at(edge.out, 319, 10), 4);
  assert.equal(at(edge.out, 0, 10), -1, 'it does not wrap round to the left edge');
});

test('expansion doubles the pixels: X to 48 wide, Y to 42 tall, and each at its own register bit', () => {
  const m = machine();
  shape(m.mem, BLOCK, () => 0xff);
  place(m.mem, 0, 100, 100, BLOCK, 5);
  m.mem[vic.spriteRegs + 0x1d] = 1; // expand X
  run(m);
  assert.equal(at(m.out, 123, 50), 5, 'column 76 + 47');
  assert.equal(at(m.out, 124, 50), -1);
  assert.equal(at(m.out, 76, 71), -1, 'X expansion alone leaves it 21 rows tall');
  const tall = machine();
  shape(tall.mem, BLOCK, () => 0xff);
  place(tall.mem, 0, 100, 100, BLOCK, 5);
  tall.mem[vic.spriteRegs + 0x17] = 1; // expand Y
  run(tall);
  assert.equal(at(tall.out, 76, 91), 5, 'row 50 + 41');
  assert.equal(at(tall.out, 76, 92), -1);
  assert.equal(at(tall.out, 100, 50), -1, 'Y expansion alone leaves it 24 wide');
});

test('multicolour: %01 the first shared colour, %10 the sprite\'s own, %11 the second, %00 clear; pairs are two pixels wide', () => {
  const m = machine();
  shape(m.mem, BLOCK, (row, b) => (row === 0 && b === 0 ? 0b01101100 : 0));
  place(m.mem, 0, 24, 50, BLOCK, 5);
  m.mem[vic.spriteRegs + 0x1c] = 1; // multicolour
  m.mem[vic.spriteRegs + 0x25] = 9; // shared 0
  m.mem[vic.spriteRegs + 0x26] = 12; // shared 1
  run(m);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((x) => at(m.out, x, 0)), [9, 9, 5, 5, 12, 12, -1, -1]);
  // ...and with X expanded each pair is four pixels wide.
  m.mem[vic.spriteRegs + 0x1d] = 1;
  run(m);
  assert.deepEqual([0, 3, 4, 7, 8, 11, 12, 15].map((x) => at(m.out, x, 0)), [9, 9, 5, 5, 12, 12, -1, -1]);
});

test('among sprites the lowest number is in front, and a clear pixel shows the one behind it', () => {
  const m = machine();
  shape(m.mem, BLOCK, (row, b) => (b === 0 ? 0xf0 : 0)); // the left four pixels
  shape(m.mem, BLOCK + 1, () => 0xff);
  place(m.mem, 1, 24, 50, BLOCK + 1, 3); // the back one: a solid block
  place(m.mem, 0, 24, 50, BLOCK, 2); // the front one: only the left four
  run(m);
  assert.equal(at(m.out, 0, 0), 2, 'where both draw, sprite 0');
  assert.equal(at(m.out, 3, 0), 2);
  assert.equal(at(m.out, 4, 0), 3, 'where sprite 0 is clear, sprite 1 shows through');
});

test('a sprite with its priority bit set is marked to hide behind the background\'s foreground pixels', () => {
  const m = machine();
  shape(m.mem, BLOCK, () => 0xff);
  place(m.mem, 0, 24, 50, BLOCK, 2);
  place(m.mem, 1, 24 + 40, 50, BLOCK, 2);
  m.mem[vic.spriteRegs + 0x1b] = 2; // sprite 1 behind
  run(m);
  assert.equal(m.out.behind[0 * W + 0], 0, 'sprite 0 in front');
  assert.equal(m.out.behind[0 * W + 40], 1, 'sprite 1 behind');
});

test('a sprite that is not enabled draws nothing, and nothing is drawn when none is', () => {
  const m = machine();
  shape(m.mem, BLOCK, () => 0xff);
  place(m.mem, 0, 100, 100, BLOCK, 5);
  m.mem[vic.spriteRegs + 0x15] = 0;
  assert.equal(run(m), false);
});

test('a sprite whose Y names a line draws from the NEXT line, for 21 lines, and not again', () => {
  const m = machine();
  shape(m.mem, BLOCK, () => 0xff);
  place(m.mem, 0, 24, 60, BLOCK, 5);
  run(m);
  const rows = [];
  for (let y = 0; y < H; y += 1) if (at(m.out, 0, y) === 5) rows.push(y);
  assert.deepEqual([rows[0], rows[rows.length - 1], rows.length], [10, 30, 21], 'rows 10-30: raster lines 61-81');
});

test('a list entry at line L takes effect from line L + 1: the sprite is reused below, with a new Y, X, pointer and colour', () => {
  const m = machine();
  shape(m.mem, BLOCK, () => 0xff);
  shape(m.mem, BLOCK + 1, (row, b) => (b === 0 ? 0xf0 : 0));
  place(m.mem, 0, 24, 60, BLOCK, 5);
  // At line 81, the line of the first use's last row (the multiplexer's rule:
  // the previous Y + 21), give it Y 120, X 124, another shape and colour. They
  // take effect from line 82, so that last row is still drawn as it was.
  const writes = [
    { line: 81, address: vic.spriteRegs + 1, value: 120 },
    { line: 81, address: vic.spritePointers, value: BLOCK + 1 },
    { line: 81, address: vic.spriteRegs, value: 124 },
    { line: 81, address: vic.spriteRegs + 0x27, value: 2 },
  ];
  run(m, writes);
  assert.equal(at(m.out, 0, 10), 5, 'the first use');
  assert.equal(at(m.out, 0, 30), 5, '...through its last row, still at its old X');
  assert.equal(at(m.out, 100, 30), -1, 'the new X is not used until the next line');
  assert.equal(at(m.out, 100, 69), -1, 'nothing before the second use');
  assert.equal(at(m.out, 100, 70), 2, 'the second use: Y 120 draws from line 121, row 70, at X 124 (column 100), in colour 2');
  assert.equal(at(m.out, 103, 70), 2, 'from the left-four-pixels shape');
  assert.equal(at(m.out, 104, 70), -1);
  assert.equal(at(m.out, 100, 90), 2, '21 rows');
  assert.equal(at(m.out, 100, 91), -1);
});

test('a Y written while the sprite is still drawing starts nothing: the compare only runs when its DMA is off', () => {
  const m = machine();
  shape(m.mem, BLOCK, () => 0xff);
  place(m.mem, 0, 24, 60, BLOCK, 5);
  run(m, [{ line: 70, address: vic.spriteRegs + 1, value: 75 }]);
  let drawn = 0;
  for (let y = 0; y < H; y += 1) if (at(m.out, 0, y) === 5) drawn += 1;
  assert.equal(drawn, 21, 'one use of 21 rows; Y 75 was already past by the time the DMA ended');
});

test('a sprite can start again on the very line its last row ends, so reuse is back to back', () => {
  const m = machine();
  shape(m.mem, BLOCK, () => 0xff);
  place(m.mem, 0, 24, 60, BLOCK, 5);
  // Y 81 compares at line 81, the line of the first use's 21st row.
  run(m, [{ line: 79, address: vic.spriteRegs + 1, value: 81 }]);
  const rows = [];
  for (let y = 0; y < H; y += 1) if (at(m.out, 0, y) === 5) rows.push(y);
  assert.deepEqual([rows[0], rows[rows.length - 1], rows.length], [10, 51, 42], 'rows 10-30 then 31-51 with no gap');
});

test('Y is compared as a byte: 255 names a line only the border shows', () => {
  const m = machine();
  shape(m.mem, BLOCK, () => 0xff);
  place(m.mem, 0, 100, 255, BLOCK, 5);
  assert.equal(run(m), false);
});

test('the list is read from the live page: $0200 or $0300 by the byte at $02FF, its end from $02FC', () => {
  const mem = new Uint8Array(65536);
  assert.deepEqual(vicReadWrites(mem, vic), [], 'no live page: no writes');
  mem[0x0300] = 80; mem[0x0301] = 0x20; mem[0x0302] = 0xd0; mem[0x0303] = 6; // line 80: $D020 = 6
  mem[0x0304] = 90; mem[0x0305] = 0x21; mem[0x0306] = 0xd0; mem[0x0307] = 2; // line 90: $D021 = 2
  mem[vic.listLivePage] = 3;
  mem[vic.listEnd] = 8;
  assert.deepEqual(vicReadWrites(mem, vic), [
    { line: 80, address: 0xd020, value: 6 },
    { line: 90, address: 0xd021, value: 2 },
  ]);
  mem[vic.listEnd] = 4;
  assert.equal(vicReadWrites(mem, vic).length, 1, 'only the entries before the end byte');
  mem[vic.listLivePage] = 2;
  mem[vic.listEnd] = 0;
  assert.deepEqual(vicReadWrites(mem, vic), [], 'an empty list');
});

test('border, background, scroll and character set follow the list, from the row after the entry\'s line', () => {
  const base = { border: 14, background: 6, scrollX: 0, charset: 0 };
  const writes = [
    { line: 100, address: vic.borderRegister, value: 2 },
    { line: 100, address: vic.backgroundRegister, value: 5 },
    { line: 150, address: vic.scrollRegister, value: 0xc8 | 3 },
    { line: 150, address: vic.selectRegister, value: 0x86 },
  ];
  // Line 100's entry lands in line 100's right border: line 101 (row 50) is the first it colours.
  assert.deepEqual(vicRowBase(base, writes, 49, vic), base);
  assert.deepEqual(vicRowBase(base, writes, 50, vic), { border: 2, background: 5, scrollX: 0, charset: 0 });
  assert.deepEqual(vicRowBase(base, writes, 99, vic), { border: 2, background: 5, scrollX: 0, charset: 0 });
  assert.deepEqual(vicRowBase(base, writes, 100, vic), { border: 2, background: 5, scrollX: 3, charset: 1 });
});

test('the source the browser loader embeds runs the same as the module', () => {
  const embedded = new Function(`${vicSource()}; return { vicReadWrites, vicRowBase, vicSprites };`)();
  const m = machine();
  shape(m.mem, BLOCK, (row, b) => (row % 2 === 0 ? 0xa5 : 0x5a) ^ b);
  place(m.mem, 0, 100, 100, BLOCK, 5);
  place(m.mem, 5, 300, 130, BLOCK, 9);
  m.mem[vic.spriteRegs + 0x1c] = 32;
  m.mem[vic.spriteRegs + 0x17] = 1;
  const writes = [{ line: 120, address: vic.spriteRegs + 1, value: 150 }];
  const other = machine();
  other.mem.set(m.mem);
  vicSprites(m.mem, vic, writes, W, H, m.out);
  embedded.vicSprites(other.mem, vic, writes, W, H, other.out);
  assert.ok(Buffer.from(m.out.color).equals(Buffer.from(other.out.color)));
  assert.ok(Buffer.from(m.out.behind).equals(Buffer.from(other.out.behind)));
});
