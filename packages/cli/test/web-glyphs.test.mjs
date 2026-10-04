// The web target's redefinable glyph table, in isolation: where the layout
// puts it, what userGlyph() reads out of it, what the headless rasterizer
// draws from it, and that packages/web/src/geometry*.8bs says the same
// numbers. The compiled-program half (a `.8bs` writing the table through
// @8bitscript/web/charset, a `.8bg` picture arriving as real art) is
// web-glyph-art.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BORDER_PX, DEFAULT_LAYOUT, GLYPH_BYTES, GLYPH_COUNT, GLYPH_FIRST, GLYPH_ROW_BYTES,
  MACHINE_HOST, RASTER_ENTRY_SIZE, RASTER_MAX_ENTRIES, agreementFor, layoutForRealMachine,
  layoutFromHardware, sidecarJson, userGlyph,
} from '../src/web-layout.mjs';
import { glyphRows, BLOCK_CODE_BASE, CORNER_CODE_BASE, COPYRIGHT_CODE } from '../src/font8x8.mjs';
import { Slot, renderFrame, rgbPalette } from '../src/web-scanline.mjs';

const WEB_SRC = resolve(import.meta.dirname, '..', '..', 'web', 'src');

test('the glyph codes sit in the gap the font leaves: past the blocks, the corner masks and the copyright sign', () => {
  assert.equal(GLYPH_FIRST, 176);
  assert.equal(GLYPH_COUNT, 80);
  assert.equal(GLYPH_ROW_BYTES, 8);
  assert.equal(GLYPH_BYTES, 640);
  assert.equal(GLYPH_FIRST + GLYPH_COUNT, 256, 'the table runs to the last byte code');
  for (let code = GLYPH_FIRST; code < GLYPH_FIRST + GLYPH_COUNT; code += 1) {
    assert.equal(glyphRows(code), null, `the font draws nothing at ${code}, so a table glyph shadows nothing`);
  }
  assert.ok(BLOCK_CODE_BASE + 16 <= CORNER_CODE_BASE && COPYRIGHT_CODE < GLYPH_FIRST);
});

test('agreementFor: a layout with a table puts it right after the raster list and reserves it; one without is exactly as before', () => {
  const without = agreementFor({ cols: 40, rows: 25 });
  assert.equal(without.glyphBase, -1);
  assert.equal(without.reservedEnd, without.rasterBase + RASTER_MAX_ENTRIES * RASTER_ENTRY_SIZE);
  for (const resizable of [false, true]) {
    const withTable = agreementFor({ cols: 40, rows: 25, resizable, userGlyphs: true });
    assert.equal(withTable.glyphBase, withTable.rasterBase + RASTER_MAX_ENTRIES * RASTER_ENTRY_SIZE);
    assert.equal(withTable.reservedEnd, withTable.glyphBase + GLYPH_BYTES);
    assert.equal(withTable.glyphFirst, GLYPH_FIRST);
    assert.equal(withTable.glyphCount, GLYPH_COUNT);
    assert.equal(withTable.rasterBase, agreementFor({ cols: 40, rows: 25, resizable }).rasterBase, 'nothing before the table moves');
  }
  // The Modern host's agreement ends at 8392 without a table and 9032 with one.
  assert.equal(agreementFor({ resizable: true }).reservedEnd, 8392);
  assert.equal(agreementFor({ resizable: true, userGlyphs: true }).reservedEnd, 9032);
});

test('every synthetic host carries the table; no real machine\'s own web build does', () => {
  assert.ok(DEFAULT_LAYOUT.glyphBase > 0);
  for (const machine of Object.keys(MACHINE_HOST)) {
    const layout = layoutFromHardware({ facts: {}, options: { machine } });
    assert.ok(layout.glyphBase > 0, `${machine} has a table`);
  }
  for (const target of ['pet', 'vic20', 'c64', 'cx16']) {
    const layout = layoutForRealMachine(target, { facts: {}, tags: [] });
    assert.equal(layout.glyphBase, -1, `${target} keeps its own ROM's codes`);
    assert.equal(layout.reservedEnd, layout.rasterBase + RASTER_MAX_ENTRIES * RASTER_ENTRY_SIZE, `${target}'s agreement is unchanged`);
  }
});

test('the sidecar and the page carry the table so the loader can find it', () => {
  const layout = layoutFromHardware({ facts: {}, options: { machine: 'c64' } });
  const side = sidecarJson(layout);
  assert.equal(side.glyphBase, layout.glyphBase);
  assert.equal(side.glyphFirst, GLYPH_FIRST);
  assert.equal(side.glyphCount, GLYPH_COUNT);
});

test('packages/web/src/geometry*.8bs say the same table the layout lays out, for every host', () => {
  const files = {
    hifi: 'geometry.8bs',
    'pet-2001': 'geometry.web.pet-2001.8bs',
    c64: 'geometry.web.c64.8bs',
    vic20: 'geometry.web.vic20.8bs',
  };
  for (const [machine, file] of Object.entries(files)) {
    const source = readFileSync(resolve(WEB_SRC, file), 'utf8');
    const number = (name) => Number(new RegExp(`const ${name}: [a-z]+ = (\\d+);`).exec(source)?.[1]);
    const layout = layoutFromHardware({ facts: machine === 'hifi' ? {} : { 'video.columns': number('COLUMNS'), 'video.rows': number('ROWS') }, options: { machine } });
    assert.equal(number('GLYPH_BASE'), layout.glyphBase, `${machine}: GLYPH_BASE`);
    assert.equal(number('GLYPH_FIRST'), GLYPH_FIRST, `${machine}: GLYPH_FIRST`);
    assert.equal(number('GLYPH_COUNT'), GLYPH_COUNT, `${machine}: GLYPH_COUNT`);
    assert.equal(number('RASTER_BASE') + RASTER_MAX_ENTRIES * RASTER_ENTRY_SIZE, number('GLYPH_BASE'), `${machine}: the table follows the raster list`);
  }
});

// ---- userGlyph ---------------------------------------------------------

function memoryWith(glyphBase, code, rows) {
  const mem = new Uint8Array(glyphBase + GLYPH_BYTES + 16);
  rows.forEach((value, i) => { mem[glyphBase + (code - GLYPH_FIRST) * 8 + i] = value; });
  return mem;
}

test('userGlyph: a defined glyph comes back row for row, an undefined or out-of-range one is null', () => {
  const base = 500;
  const rows = [1, 2, 4, 8, 16, 32, 64, 128];
  const mem = memoryWith(base, 200, rows);
  assert.deepEqual([...userGlyph(mem, base, 200)], rows);
  assert.equal(userGlyph(mem, base, 201), null, 'all zero rows: undefined');
  assert.equal(userGlyph(mem, base, GLYPH_FIRST - 1), null, 'below the table');
  assert.equal(userGlyph(mem, base, 255), null, 'the last code, undefined');
  assert.equal(userGlyph(mem, -1, 200), null, 'a host with no table');
  assert.equal(userGlyph(mem, base, 65), null, 'ASCII is never the table\'s');
  // One nonzero row anywhere is enough to define it.
  for (let row = 0; row < 8; row += 1) {
    const one = new Array(8).fill(0);
    one[row] = 0x10;
    assert.deepEqual([...userGlyph(memoryWith(base, GLYPH_FIRST, one), base, GLYPH_FIRST)], one, `only row ${row}`);
  }
  // The edges of the table: the first and last glyph read their own bytes.
  assert.deepEqual([...userGlyph(memoryWith(base, 255, rows), base, 255)], rows);
});

// ---- the rasterizer ------------------------------------------------------

function paintOne(layout, setup) {
  const mem = new Uint8Array(65536);
  setup(mem, layout);
  return renderFrame(mem, { ...layout, border: BORDER_PX }, rgbPalette(layout.palette));
}

const cellPixels = (frame, layout, col, row) => {
  const rows = [];
  const ink = (x, y) => {
    const i = (y * frame.width + x) * 4;
    return [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]];
  };
  const background = ink(BORDER_PX + layout.innerWidth - 1, BORDER_PX + layout.innerHeight - 1);
  for (let y = 0; y < 8; y += 1) {
    let bits = 0;
    for (let x = 0; x < 8; x += 1) {
      const px = ink(BORDER_PX + col * 8 + x, BORDER_PX + row * 8 + y);
      if (px.some((v, i) => v !== background[i])) bits |= 1 << x;
    }
    rows.push(bits);
  }
  return rows;
};

test('renderFrame draws a defined glyph, bit 0 leftmost, in the cell\'s own colour; an undefined one stays blank', () => {
  const layout = DEFAULT_LAYOUT;
  const rows = [0x81, 0x42, 0x24, 0x18, 0x01, 0x80, 0xff, 0x3c];
  const frame = paintOne(layout, (mem) => {
    mem[0] = 0;
    mem[1] = 0; // black border and background
    mem.set(rows, layout.glyphBase + (200 - GLYPH_FIRST) * 8);
    mem[layout.charBase + 0] = 200; // defined, colour 5 (green)
    mem[layout.colorBase + 0] = 5;
    mem[layout.charBase + 1] = 201; // in range, never defined
    mem[layout.colorBase + 1] = 5;
  });
  assert.deepEqual(cellPixels(frame, layout, 0, 0), rows);
  assert.deepEqual(cellPixels(frame, layout, 1, 0), new Array(8).fill(0), 'an undefined glyph draws blank');
  const palette = rgbPalette(layout.palette);
  const lit = (x, y) => {
    const i = (y * frame.width + x) * 4;
    return [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]];
  };
  assert.deepEqual(lit(BORDER_PX + 0, BORDER_PX + 0), palette[5], 'row 0 bit 0 is the leftmost pixel, in colour 5');
  assert.deepEqual(lit(BORDER_PX + 7, BORDER_PX + 0), palette[5], 'row 0 bit 7 is the rightmost');
  assert.deepEqual(lit(BORDER_PX + 1, BORDER_PX + 0), palette[0], 'row 0 bit 1 is dark');
});

test('a glyph is untouched by the alternate set and by a SCROLL_X band, and follows the scroll like any cell', () => {
  const layout = DEFAULT_LAYOUT;
  const rows = [0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55];
  const plain = paintOne(layout, (mem) => {
    mem.set(rows, layout.glyphBase);
    mem[layout.charBase + 3] = GLYPH_FIRST;
    mem[layout.colorBase + 3] = 1;
  });
  const banded = paintOne(layout, (mem) => {
    mem.set(rows, layout.glyphBase);
    mem[layout.charBase + 3] = GLYPH_FIRST;
    mem[layout.colorBase + 3] = 1;
    mem[layout.rasterBase] = 0;
    mem[layout.rasterBase + 1] = Slot.CHARSET;
    mem[layout.rasterBase + 2] = 1;
    mem[layout.rasterCountOffset] = 1;
    mem[layout.rasterControlOffset] = 1;
  });
  assert.deepEqual(cellPixels(banded, layout, 3, 0), rows, 'the alternate set remaps 97-122 only');
  assert.deepEqual(cellPixels(banded, layout, 3, 0), cellPixels(plain, layout, 3, 0));
  const scrolled = paintOne(layout, (mem) => {
    mem.set(rows, layout.glyphBase);
    mem[layout.charBase + 3] = GLYPH_FIRST;
    mem[layout.colorBase + 3] = 1;
    mem[layout.rasterBase] = 0;
    mem[layout.rasterBase + 1] = Slot.SCROLL_X;
    mem[layout.rasterBase + 2] = 2;
    mem[layout.rasterCountOffset] = 1;
    mem[layout.rasterControlOffset] = 1;
  });
  // Scrolled two pixels right, row 0 (0xAA: pixel 1 lit, pixel 0 dark) has its
  // pixel 1 at x = 3 * 8 + 1 + 2 and its pixel 0 at x = 3 * 8 + 2.
  const at = (frame, x) => {
    const i = (BORDER_PX * frame.width + BORDER_PX + x) * 4;
    return [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]];
  };
  assert.deepEqual(at(scrolled, 3 * 8 + 1 + 2), rgbPalette(layout.palette)[1]);
  assert.deepEqual(at(scrolled, 3 * 8 + 2), rgbPalette(layout.palette)[0]);
});

test('a real machine\'s layout has no table: bytes where one would be change nothing there', () => {
  const real = layoutForRealMachine('vic20', { facts: { 'video.columns': 22, 'video.rows': 23 }, tags: [] });
  const bytes = (set) => {
    const mem = new Uint8Array(65536);
    mem[real.charBase] = 200;
    mem[real.colorBase] = 1;
    if (set) mem.fill(0xff, real.rasterBase + 192, real.rasterBase + 192 + GLYPH_BYTES);
    return renderFrame(mem, { ...real, border: BORDER_PX }, rgbPalette(real.palette));
  };
  assert.ok(Buffer.from(bytes(false).rgba).equals(Buffer.from(bytes(true).rgba)));
});
