// The redefinable glyph table and .8bg art on the web, end to end: real
// programs compiled by the native web backend and rasterized by the headless
// --screenshot path (captureScreenshot, the call `8bs run web --screenshot`
// makes). Two halves:
//
//  - a program writing the table through @8bitscript/web/charset: the glyph
//    lands on the cell, bit 0 the leftmost pixel, in the cell's colour; a code
//    below the table, or one the font owns (the corner masks), is refused and
//    left as it was; the program's own data above the table is not touched.
//  - .8bg pictures arriving as the art they are: asymmetric 8x8 patterns, a
//    16x16 one reduced exactly, an eight-frame animation stepping in order, a
//    paused one holding, a recoloured one, a hidden one gone, a moved one
//    leaving no copy behind, the grid's last cell, and a CHARSET band over the
//    pictures leaving them alone. Patterns are asymmetric on purpose: a
//    flipped bit order, a flipped row order or a transposed glyph is a
//    different picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { glyphRows } from '../src/font8x8.mjs';
import { encodePNG, pixelAt } from '../src/png.mjs';
import { BORDER_PX, layoutFromHardware } from '../src/web-layout.mjs';
import { rgbPalette } from '../src/web-scanline.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

const CLI_LINE = /^(built |memory: |size breakdown|web bundle: |8bs build: )/;
function silently(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : out(chunk, ...rest));
  process.stderr.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : err(chunk, ...rest));
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  });
}

/** The 8x8 pixels of cell (col, row) as row bytes, bit 0 leftmost, a pixel set when it is `ink`. */
function cellBits(png, col, cellRow, ink) {
  const rows = [];
  for (let gy = 0; gy < 8; gy += 1) {
    let bits = 0;
    for (let gx = 0; gx < 8; gx += 1) {
      const px = pixelAt(png, BORDER_PX + col * 8 + gx, BORDER_PX + cellRow * 8 + gy);
      if (px.every((v, i) => v === ink[i])) bits |= 1 << gx;
    }
    rows.push(bits);
  }
  return rows;
}

const BLANK = new Array(8).fill(0);

async function buildProgram(files, machine) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-glyph-'));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const result = await silently(() => compile('web', join(dir, 'main.8bs'), {
      checkout: REPO, hardware: machine ? { machine } : {},
    }));
    assert.equal(result.ok, true, `builds for ${machine ?? 'the Modern host'}`);
    return { dir, result };
  } finally {
    process.chdir(prev);
  }
}

async function shoot({ dir, result }, frames) {
  const shot = join(dir, `out-${frames}.png`);
  await captureScreenshot('web', result.outFile, shot, { frames, hardware: result.hardware });
  return readFile(shot);
}

// ---- charset.define ------------------------------------------------------

const RING = [0x3c, 0x42, 0x81, 0x81, 0x81, 0x81, 0x42, 0x3c];
const DIAGONAL = [1, 2, 4, 8, 16, 32, 64, 128];
const SOLID = new Array(8).fill(255);

const CHARSET_PROGRAM = [
  'import { charset } from "@8bitscript/web/charset";',
  'import { text } from "@8bitscript/text";',
  '',
  'export function main(): void {',
  '    charset.define(176, 0x3c, 0x42, 0x81, 0x81, 0x81, 0x81, 0x42, 0x3c);',
  '    charset.define(255, 1, 2, 4, 8, 16, 32, 64, 128);',
  '    charset.define(175, 255, 255, 255, 255, 255, 255, 255, 255);', // below the table
  '    charset.define(144, 255, 255, 255, 255, 255, 255, 255, 255);', // the font\'s corner mask
  '    charset.setRow(200, 8, 255);', // a ninth row: refused
  '    text.putChar(0, 176);',
  '    text.putColor(0, 5);',
  '    text.putChar(1, 255);',
  '    text.putColor(1, 2);',
  '    text.putChar(2, 177);', // in range, never defined: blank
  '    text.putColor(2, 1);',
  '    text.putChar(3, 144);', // the corner mask, untouched
  '    text.putColor(3, 1);',
  '    text.putChar(4, 175);', // below the table: nothing
  '    text.putColor(4, 1);',
  '    text.putChar(5, 200);', // the refused ninth row defined nothing
  '    text.putColor(5, 1);',
  '    let row: usmallint = text.columns();',
  '    text.print(row, "AB");', // the program\'s data, above the table, still its own
  '    while (true) {',
  '        waitFrame();',
  '    }',
  '}',
  '',
].join('\n');

for (const machine of [undefined, 'pet-2001']) {
  test(`charset.define puts a glyph on a cell and refuses what is not the table's (${machine ?? 'Modern host'})`, async () => {
    const built = await buildProgram({ 'main.8bs': CHARSET_PROGRAM }, machine);
    try {
      const layout = layoutFromHardware(built.result.hardware);
      const palette = rgbPalette(layout.palette);
      const colorOf = (n) => (layout.colorPerCell ? palette[n] : palette[1]);
      const png = await shoot(built, 3);
      assert.deepEqual(cellBits(png, 0, 0, colorOf(5)), RING, 'the first glyph, in colour 5');
      assert.deepEqual(cellBits(png, 1, 0, colorOf(2)), DIAGONAL, 'the last glyph, bit 0 the leftmost pixel');
      assert.deepEqual(cellBits(png, 2, 0, colorOf(1)), BLANK, 'a code in range that was never defined draws blank');
      assert.deepEqual(cellBits(png, 3, 0, colorOf(1)), [...glyphRows(144)], 'the corner mask is still the font\'s');
      assert.deepEqual(cellBits(png, 4, 0, colorOf(1)), BLANK, 'a code below the table did not define it');
      assert.deepEqual(cellBits(png, 5, 0, colorOf(1)), BLANK, 'a ninth row was refused, so glyph 200 stayed undefined');
      assert.notDeepEqual(cellBits(png, 3, 0, colorOf(1)), SOLID, 'the refused solid write did not reach the corner mask');
      // The program's own data sits above the table: "AB" printed from it.
      assert.deepEqual(cellBits(png, 0, 1, colorOf(1)), [...glyphRows(65, layout.font)], 'A, from the data section');
      assert.deepEqual(cellBits(png, 1, 1, colorOf(1)), [...glyphRows(66, layout.font)], 'B, from the data section');
    } finally {
      await rm(built.dir, { recursive: true, force: true });
    }
  });
}

// ---- .8bg pictures as art --------------------------------------------------

const STAIRS = [0x01, 0x03, 0x07, 0x0f, 0x1f, 0x3f, 0x7f, 0xff];
const FLAG = [0xf0, 0x88, 0x84, 0x82, 0x81, 0x80, 0x80, 0xff];
const DIAMOND = [0x18, 0x24, 0x42, 0x81, 0x42, 0x24, 0x18, 0x00];
const CHECKER = [0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55];
const BIG = [0x3c, 0x7e, 0xff, 0xe7, 0xc3, 0xc3, 0x81, 0x01];
// Step k of the animation: a diagonal rotated k pixels, so every step differs from every other.
const SPIN = Array.from({ length: 8 }, (_, k) => Array.from({ length: 8 }, (_, r) => 1 << ((r + k) & 7)));
// Four frames for the one that holds: row k filled, the rest empty.
const HOLD = Array.from({ length: 4 }, (_, k) => Array.from({ length: 8 }, (_, r) => (r === k ? 0xff : 0x01)));

/** One PNG of `frames` (each 8 row bytes, bit x = pixel x) side by side, every pixel drawn `scale` times. */
function sheet(frames, scale = 1) {
  const fw = 8 * scale;
  const w = fw * frames.length;
  const h = 8 * scale;
  const rgba = new Uint8Array(w * h * 4);
  frames.forEach((rows, f) => {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < fw; x += 1) {
        if ((rows[Math.floor(y / scale)] >> Math.floor(x / scale)) & 1) rgba.set([255, 255, 255, 255], (y * w + f * fw + x) * 4);
      }
    }
  });
  return encodePNG(w, h, rgba);
}

const ART = [
  'sprite stairs { source "./stairs.png" size 8x8 transparent auto }',
  'sprite flag { source "./flag.png" size 8x8 transparent auto }',
  'sprite diamond { source "./diamond.png" size 8x8 transparent auto }',
  'sprite checker { source "./checker.png" size 8x8 transparent auto }',
  'sprite big { source "./big.png" size 16x16 transparent auto }',
  'sprite spin {',
  '  source "./spin.png"',
  '  size 8x8',
  '  transparent auto',
  '  animation go {',
  '    frames 0, 1, 2, 3, 4, 5, 6, 7',
  '    every 1',
  '  }',
  '}',
  'sprite hold {',
  '  source "./hold.png"',
  '  size 8x8',
  '  transparent auto',
  '  animation go {',
  '    frames 0, 1, 2, 3',
  '    every 1',
  '  }',
  '}',
  '',
].join('\n');

// stairs at the top-left cell; flag on the grid's last cell; diamond at stage
// (40, 24) = column 5, row 3, tinted red; checker placed then hidden (its
// cell, column 10 row 3, ends blank); big placed at column 12 and moved to
// column 14 (row 8: the old cell ends blank); spin at column 25 row 10 stepping
// every frame; hold at column 25 row 13 set to frame 3 and paused. The
// alternate set is on over picture lines 56-103 (cell rows 7-12) — where big
// and spin are.
const ART_PROGRAM = [
  'import { graphics } from "@8bitscript/graphics";',
  'import { raster, Slot } from "@8bitscript/raster";',
  'import { sprites } from "@8bitscript/sprites";',
  'import { stairs, flag, diamond, checker, big, spin, hold } from "./art.8bg";',
  '',
  'export function main(): void {',
  '    graphics.place(stairs, 0, 0);',
  '    graphics.place(flag, sprites.right(), sprites.bottom());',
  '    graphics.place(diamond, 40, 24);',
  '    graphics.color(diamond, 2);',
  '    graphics.place(checker, 80, 24);',
  '    graphics.place(big, 96, 64);',
  '    graphics.place(spin, 200, 80);',
  '    graphics.place(hold, 200, 104);',
  '    graphics.setFrame(hold, 3);',
  '    graphics.animate(hold, false);',
  '    graphics.update();',
  '    waitFrame();',
  '    graphics.hide(checker);',
  '    graphics.place(big, 112, 64);',
  '    raster.clear();',
  '    if (raster.CHARSET) {',
  '        raster.at(56, Slot.CHARSET, 1);',
  '        raster.at(104, Slot.CHARSET, 0);',
  '    }',
  '    raster.enable();',
  '    while (true) {',
  '        waitFrame();',
  '        graphics.update();',
  '    }',
  '}',
  '',
].join('\n');

async function buildArt(machine) {
  return buildProgram({
    'main.8bs': ART_PROGRAM,
    'art.8bg': ART,
    'stairs.png': sheet([STAIRS]),
    'flag.png': sheet([FLAG]),
    'diamond.png': sheet([DIAMOND]),
    'checker.png': sheet([CHECKER]),
    'big.png': sheet([BIG], 2),
    'spin.png': sheet(SPIN),
    'hold.png': sheet(HOLD),
  }, machine);
}

for (const machine of [undefined, 'pet-2001']) {
  test(`.8bg pictures arrive as their own art: placed, recoloured, hidden, moved, animated, held (${machine ?? 'Modern host'})`, async () => {
    const built = await buildArt(machine);
    try {
      const layout = layoutFromHardware(built.result.hardware);
      const palette = rgbPalette(layout.palette);
      const white = palette[1];
      const red = layout.colorPerCell ? palette[2] : palette[1];
      const lastCol = layout.cols - 1;
      const lastRow = layout.rows - 1;

      const spinStep = (png) => {
        const bits = cellBits(png, 25, 10, white);
        const found = SPIN.findIndex((rows) => rows.every((b, i) => b === bits[i]));
        assert.notEqual(found, -1, `column 25 row 10 is one of the eight spin frames, got ${bits.join(',')}`);
        return found;
      };

      const seen = [];
      for (let frames = 3; frames <= 14; frames += 1) {
        const png = await shoot(built, frames);
        assert.deepEqual(cellBits(png, 0, 0, white), STAIRS, `stairs on the first cell at frame ${frames}`);
        assert.deepEqual(cellBits(png, lastCol, lastRow, white), FLAG, `flag on the last cell at frame ${frames}`);
        assert.deepEqual(cellBits(png, 5, 3, red), DIAMOND, `diamond in its colour at frame ${frames}`);
        assert.deepEqual(cellBits(png, 10, 3, white), BLANK, 'the hidden picture\'s cell is empty');
        assert.deepEqual(cellBits(png, 12, 8, white), BLANK, 'the moved picture left nothing behind');
        assert.deepEqual(cellBits(png, 14, 8, white), BIG, 'a 16x16 picture reduced to exactly the 8x8 it was drawn from, in the CHARSET band');
        assert.deepEqual(cellBits(png, 25, 13, white), HOLD[3], 'the paused picture holds its frame');
        seen.push(spinStep(png));
        assert.deepEqual(cellBits(png, 0, 1, white), BLANK, 'nothing wrapped onto the next row');
      }
      for (let i = 0; i + 1 < seen.length; i += 1) {
        assert.equal(seen[i + 1], (seen[i] + 1) % SPIN.length, `every frame is one step on: ${seen.join(',')}`);
      }
      assert.equal(new Set(seen).size, SPIN.length, `all eight frames show: ${seen.join(',')}`);
    } finally {
      await rm(built.dir, { recursive: true, force: true });
    }
  });
}

// ---- the edges of the operations, on real art ----------------------------
//
// hide() then place() shows the picture again where it was put; color() before
// the first place() is kept; setFrame() past the last step clamps to it; a
// paused animation resumes from where it stopped when animate(true) comes; a
// picture one row below the grid draws nothing and writes nothing (not onto
// the raster list or the glyph table above it, not onto another picture).
const EDGES_PROGRAM = [
  'import { graphics } from "@8bitscript/graphics";',
  'import { sprites } from "@8bitscript/sprites";',
  'import { stairs, diamond, spin } from "./art.8bg";',
  '',
  'export function main(): void {',
  '    graphics.color(stairs, 3);',
  '    graphics.place(stairs, 16, 0);',
  '    graphics.update();',
  '    waitFrame();',
  '    graphics.hide(stairs);',
  '    graphics.update();',
  '    waitFrame();',
  '    graphics.place(stairs, 16, 8);',
  '    graphics.place(diamond, 0, sprites.bottom() + 8);',
  '    graphics.setFrame(spin, 200);',
  '    graphics.animate(spin, false);',
  '    graphics.place(spin, 64, 32);',
  '    let n: utinyint = 0;',
  '    while (true) {',
  '        waitFrame();',
  '        n = n + 1;',
  '        if (n == 4) {',
  '            graphics.animate(spin, true);',
  '        }',
  '        graphics.update();',
  '    }',
  '}',
  '',
].join('\n');

for (const machine of [undefined, 'pet-2001']) {
  test(`operations at their edges, on real art (${machine ?? 'Modern host'})`, async () => {
    const built = await buildProgram({
      'main.8bs': EDGES_PROGRAM,
      'art.8bg': ART,
      'stairs.png': sheet([STAIRS]),
      'flag.png': sheet([FLAG]),
      'diamond.png': sheet([DIAMOND]),
      'checker.png': sheet([CHECKER]),
      'big.png': sheet([BIG], 2),
      'spin.png': sheet(SPIN),
      'hold.png': sheet(HOLD),
    }, machine);
    try {
      const layout = layoutFromHardware(built.result.hardware);
      const palette = rgbPalette(layout.palette);
      const white = palette[1];
      const cyan = layout.colorPerCell ? palette[3] : palette[1];
      const lastRow = layout.rows - 1;
      const spinAt = (png) => {
        const bits = cellBits(png, 8, 4, white);
        return SPIN.findIndex((rows) => rows.every((b, i) => b === bits[i]));
      };

      const early = await shoot(built, 3);
      assert.deepEqual(cellBits(early, 2, 1, cyan), STAIRS, 'hidden, then placed again: back on the cell it was put on, in the colour set before its first place');
      assert.deepEqual(cellBits(early, 2, 0, cyan), BLANK, 'and gone from where it was hidden');
      assert.equal(spinAt(early), SPIN.length - 1, 'setFrame past the last step clamps to the last, and the pause holds it');
      const held = await shoot(built, 4);
      assert.equal(spinAt(held), SPIN.length - 1, 'still held a frame later');

      // Below the grid: nothing drawn on the last row, and every other picture intact.
      for (const frames of [3, 8, 12]) {
        const png = await shoot(built, frames);
        assert.deepEqual(cellBits(png, 0, lastRow, white), BLANK, `nothing from the picture below the grid, frame ${frames}`);
        assert.deepEqual(cellBits(png, 2, 1, cyan), STAIRS, `the stairs untouched, frame ${frames}`);
        assert.deepEqual(cellBits(png, 0, 0, white), BLANK, `nothing wrapped onto the first cell, frame ${frames}`);
      }

      // animate(true) at frame 4 sets the pause flag clear: the picture then
      // steps, from the last step, one at a time.
      const later = [];
      for (let frames = 8; frames <= 12; frames += 1) later.push(spinAt(await shoot(built, frames)));
      assert.ok(later.every((step) => step >= 0), `every frame after the resume is a spin frame: ${later.join(',')}`);
      for (let i = 0; i + 1 < later.length; i += 1) {
        assert.equal(later[i + 1], (later[i] + 1) % SPIN.length, `one step a frame after the resume: ${later.join(',')}`);
      }
    } finally {
      await rm(built.dir, { recursive: true, force: true });
    }
  });
}
