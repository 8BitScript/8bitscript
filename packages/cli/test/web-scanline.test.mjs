// The per-scanline compositor (packages/cli/src/web-scanline.mjs) against
// the contract packages/web/src/rasterline.8bs writes to: the raster region
// round-trips, a row resolves the entries at or before it, and — the load-
// bearing promise — a frame with the list disabled or empty is pixel-
// identical to the plain cell-major picture both renderers drew before the
// raster region existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Slot, readRasterEntries, renderFrame, rgbPalette, rowState,
} from '../src/web-scanline.mjs';
import {
  BORDER_PX, DEFAULT_LAYOUT, agreementFor, layoutFromHardware,
} from '../src/web-layout.mjs';
import { glyphRows } from '../src/font8x8.mjs';

const LAYOUT = { ...DEFAULT_LAYOUT, border: BORDER_PX };
const RGB = rgbPalette(LAYOUT.palette);

/** A 64 KB page with border/background set and a few cells written. */
function memFixture() {
  const mem = new Uint8Array(65536);
  mem[0] = 2; // border: red
  mem[1] = 3; // background: cyan
  // 'A' at cell 0 in white, 'z' at cell 49 in yellow, a reverse-video blank
  // at cell 96 (row 2, col 0) in white, and a quadrant block at cell 100.
  mem[LAYOUT.charBase + 0] = 65;
  mem[LAYOUT.colorBase + 0] = 1;
  mem[LAYOUT.charBase + 49] = 122;
  mem[LAYOUT.colorBase + 49] = 7;
  mem[LAYOUT.charBase + 96] = 0;
  mem[LAYOUT.colorBase + 96] = 0x81;
  mem[LAYOUT.charBase + 100] = 130;
  mem[LAYOUT.colorBase + 100] = 5;
  return mem;
}

/**
 * Append a 3-byte entry the way rasterline.8bs's at() does: the line's low
 * byte, then the slot with the line's ninth bit packed into bit 7.
 */
function appendEntry(mem, line, slot, value, layout = LAYOUT) {
  const count = mem[layout.rasterCountOffset];
  const at = layout.rasterBase + count * 3;
  mem[at] = line % 256;
  mem[at + 1] = slot | (Math.floor(line / 256) << 7);
  mem[at + 2] = value;
  mem[layout.rasterCountOffset] = count + 1;
}

// The picture the two renderers drew before the raster region existed:
// border fill, background fill, then a cell-major glyph walk. Kept here as
// the reference the scanline compositor must collapse to when the list is
// off.
function cellMajorReference(mem, layout, palette) {
  const cols = layout.cols;
  const rows = layout.rows;
  const innerW = cols * 8;
  const innerH = rows * 8;
  const width = innerW + BORDER_PX * 2;
  const height = innerH + BORDER_PX * 2;
  const rgba = new Uint8Array(width * height * 4);
  const colorPerCell = layout.colorPerCell !== false;
  const setPixel = (x, y, [r, g, b]) => {
    const i = (y * width + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  };
  const fillRect = (x0, y0, w, h, color) => {
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) setPixel(x, y, color);
    }
  };
  const borderInk = colorPerCell ? palette[mem[0] & 15] : palette[0];
  const background = colorPerCell ? palette[mem[1] & 15] : palette[0];
  fillRect(0, 0, width, height, borderInk);
  fillRect(BORDER_PX, BORDER_PX, innerW, innerH, background);
  for (let cell = 0; cell < cols * rows; cell += 1) {
    const code = mem[layout.charBase + cell];
    const colorByte = mem[layout.colorBase + cell];
    const reverse = (colorByte & 128) !== 0;
    const glyph = glyphRows(code);
    if (glyph === null && !reverse) continue;
    const col = cell % cols;
    const row = (cell - col) / cols;
    const color = colorPerCell ? palette[colorByte & 15] : palette[1];
    const x0 = BORDER_PX + col * 8;
    const y0 = BORDER_PX + row * 8;
    if (reverse) fillRect(x0, y0, 8, 8, color);
    if (glyph !== null) {
      const ink = reverse ? background : color;
      for (let gy = 0; gy < 8; gy += 1) {
        for (let gx = 0; gx < 8; gx += 1) {
          if ((glyph[gy] >> gx) & 1) setPixel(x0 + gx, y0 + gy, ink);
        }
      }
    }
  }
  return { width, height, rgba };
}

function pixel(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]];
}

test('readRasterEntries round-trips what at()/setValue() write, in stored order', () => {
  const mem = memFixture();
  appendEntry(mem, 10, Slot.BORDER, 5);
  appendEntry(mem, 10, Slot.BACKGROUND, 6);
  appendEntry(mem, 40, Slot.SCROLL_X, 4);
  mem[LAYOUT.rasterControlOffset] = 1;
  const { enabled, entries } = readRasterEntries(mem, LAYOUT);
  assert.equal(enabled, true);
  assert.deepEqual(entries, [
    { line: 10, slot: Slot.BORDER, value: 5 },
    { line: 10, slot: Slot.BACKGROUND, value: 6 },
    { line: 40, slot: Slot.SCROLL_X, value: 4 },
  ]);
  // setValue() rewrites only the value byte at entry offset + 2.
  mem[LAYOUT.rasterBase + 1 * 3 + 2] = 9;
  assert.equal(readRasterEntries(mem, LAYOUT).entries[1].value, 9);
  // disable() zeroes the control byte; the list is kept, the flag is off.
  mem[LAYOUT.rasterControlOffset] = 0;
  const off = readRasterEntries(mem, LAYOUT);
  assert.equal(off.enabled, false);
  assert.equal(off.entries.length, 3);
});

test('a count byte past the capacity is clamped, not walked into the free page', () => {
  const mem = memFixture();
  mem[LAYOUT.rasterControlOffset] = 1;
  mem[LAYOUT.rasterCountOffset] = 255;
  assert.equal(readRasterEntries(mem, LAYOUT).entries.length, LAYOUT.rasterMaxEntries);
});

test('rowState holds each slot from its line down, from the base state up', () => {
  const entries = [
    { line: 10, slot: Slot.BORDER, value: 5 },
    { line: 10, slot: Slot.BACKGROUND, value: 6 },
    { line: 20, slot: Slot.SCROLL_X, value: 3 },
  ];
  const base = { border: 2, background: 3 };
  // Before the first line: the frame's base state, scroll 0.
  assert.deepEqual(rowState(entries, 9, base), { border: 2, background: 3, scrollX: 0 });
  // At an entry's line it applies; later slots have not yet.
  assert.deepEqual(rowState(entries, 10, base), { border: 5, background: 6, scrollX: 0 });
  // Past every line, everything holds.
  assert.deepEqual(rowState(entries, 200, base), { border: 5, background: 6, scrollX: 3 });
  // Values are masked the way the renderer paints them: color & 15, scroll & 7.
  assert.equal(rowState([{ line: 0, slot: Slot.SCROLL_X, value: 12 }], 0, base).scrollX, 4);
});

test('with the list disabled or empty, renderFrame is pixel-identical to the cell-major picture', () => {
  const reference = cellMajorReference(memFixture(), LAYOUT, RGB);
  // No region written at all.
  const plain = renderFrame(memFixture(), LAYOUT, RGB);
  assert.equal(plain.width, reference.width);
  assert.equal(plain.height, reference.height);
  assert.ok(Buffer.from(plain.rgba).equals(Buffer.from(reference.rgba)),
    'a memory image with no raster region must render exactly as before');
  // A kept list with the control byte off — disable() — is the same picture.
  const disabledMem = memFixture();
  appendEntry(disabledMem, 10, Slot.BORDER, 5);
  const disabled = renderFrame(disabledMem, LAYOUT, RGB);
  assert.ok(Buffer.from(disabled.rgba).equals(Buffer.from(reference.rgba)),
    'a disabled list must render exactly as before');
  // Enabled but empty is also the plain picture.
  const emptyMem = memFixture();
  emptyMem[LAYOUT.rasterControlOffset] = 1;
  const empty = renderFrame(emptyMem, LAYOUT, RGB);
  assert.ok(Buffer.from(empty.rgba).equals(Buffer.from(reference.rgba)),
    'an enabled, empty list must render exactly as before');
});

test('a border/background split changes the picture exactly at its line', () => {
  const mem = memFixture();
  appendEntry(mem, 100, Slot.BORDER, 5);
  appendEntry(mem, 100, Slot.BACKGROUND, 6);
  mem[LAYOUT.rasterControlOffset] = 1;
  const frame = renderFrame(mem, LAYOUT, RGB);
  // Above the split: the base border and background.
  assert.deepEqual(pixel(frame, 0, BORDER_PX + 99), RGB[2]);
  assert.deepEqual(pixel(frame, BORDER_PX + 200, BORDER_PX + 99), RGB[3]);
  // At and below it: the entry's colors.
  assert.deepEqual(pixel(frame, 0, BORDER_PX + 100), RGB[5]);
  assert.deepEqual(pixel(frame, BORDER_PX + 200, BORDER_PX + 100), RGB[6]);
  // The top and bottom border rows, outside the picture, stay the frame's
  // base border color — there is no raster line out there to change them.
  assert.deepEqual(pixel(frame, 0, 0), RGB[2]);
  assert.deepEqual(pixel(frame, 0, frame.height - 1), RGB[2]);
});

test('a SCROLL_X band shifts its rows and fills the vacated columns with that row\'s background', () => {
  const mem = memFixture();
  appendEntry(mem, 8, Slot.SCROLL_X, 5);
  mem[LAYOUT.rasterControlOffset] = 1;
  const frame = renderFrame(mem, LAYOUT, RGB);
  const reference = renderFrame(memFixture(), LAYOUT, RGB);
  // Row 0 (picture rows 0-7) is above the band: untouched.
  for (let x = 0; x < 8; x += 1) {
    assert.deepEqual(pixel(frame, BORDER_PX + x, BORDER_PX + 2), pixel(reference, BORDER_PX + x, BORDER_PX + 2));
  }
  // Inside the band every pixel comes from 5 columns to the left...
  const y = BORDER_PX + 16 + 2; // cell row 2, where the reverse block at col 0 is
  for (let x = 5; x < 13; x += 1) {
    assert.deepEqual(pixel(frame, BORDER_PX + x, y), pixel(reference, BORDER_PX + x - 5, y));
  }
  // ...and the vacated columns 0-4 are the row's background, not stale cells.
  for (let x = 0; x < 5; x += 1) {
    assert.deepEqual(pixel(frame, BORDER_PX + x, y), RGB[3]);
  }
  // The reverse block at cell row 2, col 0 is white from source column 0: at
  // destination x 0-4 it must NOT be white (that's the vacated strip).
  assert.deepEqual(pixel(frame, BORDER_PX + 5, y), RGB[1]);
});

// The PET skin has no per-cell color, but it still has a palette — black and
// green — and a raster split is exactly a way of saying something in it. All
// three slots apply there; only the per-cell foreground stays fixed.
test('the PET skin applies all three slots: black/green splits and a fine-scrolled band', () => {
  const layout = {
    ...layoutFromHardware({
      facts: { 'video.columns': 40, 'video.rows': 25, 'video.colorPerCell': false },
      options: { machine: 'pet-2001' },
    }),
    border: BORDER_PX,
  };
  const pet = rgbPalette(layout.palette);
  const BLACK = pet[0];
  const GREEN = pet[1];
  const mem = new Uint8Array(65536);
  // mem[0]/mem[1] are ignored on this skin: the base picture is black.
  mem[0] = 2;
  mem[1] = 3;
  // Reverse-video blanks at cell rows 12 and 13, col 0 — low nibble 0, so a
  // renderer that wrongly kept per-cell color would paint them black.
  mem[layout.colorBase + 12 * 40] = 0x80;
  mem[layout.colorBase + 13 * 40] = 0x80;
  appendEntry(mem, 100, Slot.BORDER, 5, layout);     // the border turns green
  appendEntry(mem, 104, Slot.SCROLL_X, 4, layout);   // a band scrolls 4 px
  appendEntry(mem, 120, Slot.BACKGROUND, 5, layout); // the playfield turns green
  mem[layout.rasterControlOffset] = 1;
  const frame = renderFrame(mem, layout, pet);
  // The border: black above the split, green at and below it.
  assert.deepEqual(pixel(frame, 0, BORDER_PX + 99), BLACK);
  assert.deepEqual(pixel(frame, 0, BORDER_PX + 100), GREEN);
  // The background: black above line 120, green from it down.
  assert.deepEqual(pixel(frame, BORDER_PX + 300, BORDER_PX + 119), BLACK);
  assert.deepEqual(pixel(frame, BORDER_PX + 300, BORDER_PX + 120), GREEN);
  // The row-12 block, above the band, fills with the fixed green foreground
  // from column 0; the row-13 block, inside it, is shifted 4 px right and the
  // vacated columns are that row's (still black) background.
  assert.deepEqual(pixel(frame, BORDER_PX + 0, BORDER_PX + 96), GREEN);
  assert.deepEqual(pixel(frame, BORDER_PX + 0, BORDER_PX + 104), BLACK);
  assert.deepEqual(pixel(frame, BORDER_PX + 4, BORDER_PX + 104), GREEN);
});

// A resizable portrait grid (27×48) is 384 picture lines tall: rows past 255
// exist and every one of them can be split. The line's ninth bit rides in the
// slot byte's bit 7, so the entry is still three bytes wide.
test('a tall resizable layout splits below the fold of line 255', () => {
  const layout = { ...agreementFor({ cols: 27, rows: 48, resizable: true }), border: BORDER_PX };
  const mem = new Uint8Array(65536);
  mem[0] = 2; // border: red
  mem[1] = 3; // background: cyan
  appendEntry(mem, 300, Slot.BORDER, 5, layout);
  appendEntry(mem, 300, Slot.BACKGROUND, 6, layout);
  mem[layout.rasterControlOffset] = 1;
  // The stored bytes: line 300 is low byte 44 with the ninth bit in the slot.
  assert.equal(mem[layout.rasterBase], 44);
  assert.equal(mem[layout.rasterBase + 1], Slot.BORDER | 128);
  const { entries } = readRasterEntries(mem, layout);
  assert.deepEqual(entries[0], { line: 300, slot: Slot.BORDER, value: 5 });
  assert.deepEqual(entries[1], { line: 300, slot: Slot.BACKGROUND, value: 6 });
  const frame = renderFrame(mem, layout, RGB);
  assert.equal(frame.height, 48 * 8 + BORDER_PX * 2);
  // Above line 300 the base colors; at and below it, the entry's.
  assert.deepEqual(pixel(frame, 0, BORDER_PX + 299), RGB[2]);
  assert.deepEqual(pixel(frame, 0, BORDER_PX + 300), RGB[5]);
  assert.deepEqual(pixel(frame, BORDER_PX + 100, BORDER_PX + 299), RGB[3]);
  assert.deepEqual(pixel(frame, BORDER_PX + 100, BORDER_PX + 300), RGB[6]);
});
