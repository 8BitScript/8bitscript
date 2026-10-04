// @8bitscript/graphics on the web, end to end: real PNGs and a real .8bg
// compiled by the native web backend (packages/web/media/index.cjs lowers
// each picture to eight row bytes per step, packages/graphics/src/index.web.8bs
// writes them into the glyph table and plays them through the glyph layer),
// then rasterized by the headless
// --screenshot path (captureScreenshot, the call `8bs run web --screenshot`
// makes). The pictures must land on the cells their stage pixels name, an
// animated one must step through its frames in order at its `every`, the
// grid's last cell must draw, a position past the grid must draw nothing and
// write nothing, and a CHARSET band over the pictures' rows must leave the
// block codes alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { BLOCK_CODE_BASE, glyphRows } from '../src/font8x8.mjs';
import { encodePNG, pixelAt } from '../src/png.mjs';
import { BORDER_PX, layoutFromHardware } from '../src/web-layout.mjs';
import { rgbPalette } from '../src/web-scanline.mjs';
import web from '../../web/media/index.cjs';

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

// ---- the pictures -------------------------------------------------------

// Quadrant bits, the order font8x8.mjs indexes the blocks by.
const TL = 8;
const TR = 4;
const BL = 2;
const BR = 1;

/** A w×h opaque-white image with only the named quadrants of its size opaque. */
function quadrantImage(w, h, quadrants) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const bit = y < h / 2 ? (x < w / 2 ? TL : TR) : (x < w / 2 ? BL : BR);
      if (quadrants & bit) rgba.set([255, 255, 255, 255], (y * w + x) * 4);
    }
  }
  return rgba;
}

/** A 32×32 sheet of four 16×16 frames, left to right then down, one quadrant each. */
function walkSheet(order) {
  const w = 32;
  const rgba = new Uint8Array(w * w * 4);
  order.forEach((quadrant, i) => {
    const frame = quadrantImage(16, 16, quadrant);
    const ox = (i % 2) * 16;
    const oy = Math.floor(i / 2) * 16;
    for (let y = 0; y < 16; y += 1) {
      rgba.set(frame.subarray(y * 16 * 4, (y + 1) * 16 * 4), ((oy + y) * w + ox) * 4);
    }
  });
  return encodePNG(w, w, rgba);
}

const WALK_ORDER = [TL, TR, BR, BL];
const BAR = TL | BL;

const ART = [
  'sprite bar {',
  '  source "./bar.png"',
  '  size 16x16',
  '  transparent auto',
  '}',
  'sprite walk {',
  '  source "./walk.png"',
  '  size 16x16',
  '  transparent auto',
  '  animation go {',
  '    frames 0, 1, 2, 3',
  '    every 2',
  '  }',
  '}',
  'sprite dot {',
  '  source "./dot.png"',
  '  size 8x8',
  '  transparent auto',
  '}',
  'sprite ghost {',
  '  source "./dot.png"',
  '  size 8x8',
  '  transparent auto',
  '}',
  '',
].join('\n');

// bar at stage (24, 16): cell column 3, row 2. walk at (96, 40): column 12,
// row 5. dot on the grid's last cell, ghost one column past the grid's right
// edge (its cell number would wrap onto the next row). "abc" on
// cell row 8, with the alternate set over picture lines 16-47 (cell rows
// 2-5), which is where the pictures are.
const PROGRAM = [
  'import { graphics } from "@8bitscript/graphics";',
  'import { raster, Slot } from "@8bitscript/raster";',
  'import { sprites } from "@8bitscript/sprites";',
  'import { text } from "@8bitscript/text";',
  'import { bar, walk, dot, ghost } from "./art.8bg";',
  '',
  'export function main(): void {',
  '    let row: usmallint = text.columns();',
  '    text.print(row * 8, "abc");',
  '    graphics.place(bar, 24, 16);',
  '    graphics.place(walk, 96, 40);',
  '    graphics.place(dot, sprites.right(), sprites.bottom());',
  '    graphics.place(ghost, sprites.right() + 8, 0);',
  '    raster.clear();',
  '    if (raster.CHARSET) {',
  '        raster.at(16, Slot.CHARSET, 1);',
  '        raster.at(48, Slot.CHARSET, 0);',
  '    }',
  '    raster.enable();',
  '    while (true) {',
  '        waitFrame();',
  '        graphics.update();',
  '    }',
  '}',
  '',
].join('\n');

/** The 8×8 picture pixels of cell (col, cellRow) as row-bytes, bit 0 leftmost, against `ink`. */
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

const blockRows = (quadrants) => [...glyphRows(BLOCK_CODE_BASE + quadrants)];
const BLANK = new Array(8).fill(0);

async function build(machine) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-graphics-'));
  await writeFile(join(dir, 'bar.png'), encodePNG(16, 16, quadrantImage(16, 16, BAR)));
  await writeFile(join(dir, 'walk.png'), walkSheet(WALK_ORDER));
  await writeFile(join(dir, 'dot.png'), encodePNG(8, 8, quadrantImage(8, 8, TL | TR | BL | BR)));
  await writeFile(join(dir, 'art.8bg'), ART);
  await writeFile(join(dir, 'main.8bs'), PROGRAM);
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

for (const machine of [undefined, 'pet-2001']) {
  test(`graphics pictures land on their cells and animate (${machine ?? 'Modern host'})`, async () => {
    const built = await build(machine);
    try {
      const layout = layoutFromHardware(built.result.hardware);
      const ink = rgbPalette(layout.palette)[1];
      const lastCol = layout.cols - 1;
      const lastRow = layout.rows - 1;
      const stepOf = (png) => {
        const bits = cellBits(png, 12, 5, ink);
        const found = WALK_ORDER.findIndex((q) => bits.every((b, i) => b === blockRows(q)[i]));
        assert.notEqual(found, -1, `column 12 row 5 is one of the walk frames, got ${bits.join(',')}`);
        return found;
      };

      const seen = [];
      for (let frames = 2; frames <= 11; frames += 1) {
        const png = await shoot(built, frames);
        seen.push(stepOf(png));
        // The still picture, the grid's last cell, and the cells that stay blank.
        assert.deepEqual(cellBits(png, 3, 2, ink), blockRows(BAR), `bar on column 3 row 2 at frame ${frames}`);
        assert.deepEqual(cellBits(png, lastCol, lastRow, ink), blockRows(15), `dot on the last cell at frame ${frames}`);
        assert.deepEqual(cellBits(png, 4, 2, ink), BLANK, 'the cell beside the bar is empty');
        // A picture placed one column past the grid draws nothing: its cell
        // number is the grid width, which would wrap onto row 1, column 0.
        assert.deepEqual(cellBits(png, 0, 1, ink), BLANK, 'nothing wrapped onto the next row');
        assert.deepEqual(cellBits(png, lastCol, 0, ink), BLANK, 'nothing drawn at the right edge of row 0');
        // The text under no band is the boot set: "abc" on row 8 in lower case.
        assert.deepEqual(cellBits(png, 0, 8, ink), [...glyphRows(97, layout.font)], 'row 8 col 0 is lower case');
      }

      // Every two frames the picture moves on by exactly one frame, in the order
      // the sheet lists them, and wraps; between those it holds.
      for (let i = 0; i + 2 < seen.length; i += 1) {
        assert.equal(seen[i + 2], (seen[i] + 1) % WALK_ORDER.length, `frame ${i + 2} is one step past frame ${i}: ${seen.join(',')}`);
        assert.ok([seen[i], (seen[i] + 1) % WALK_ORDER.length].includes(seen[i + 1]), `no skipped step: ${seen.join(',')}`);
      }
      assert.equal(new Set(seen).size, WALK_ORDER.length, `all four frames show: ${seen.join(',')}`);
    } finally {
      await rm(built.dir, { recursive: true, force: true });
    }
  });
}

test('a picture in the CHARSET band keeps its block code (the alternate set only remaps 97-122)', async () => {
  const built = await build(undefined);
  try {
    const layout = layoutFromHardware(built.result.hardware);
    const ink = rgbPalette(layout.palette)[1];
    const png = await shoot(built, 3);
    // cell rows 2-5 are inside the band: the bar is there and is unchanged.
    assert.deepEqual(cellBits(png, 3, 2, ink), blockRows(BAR));
  } finally {
    await rm(built.dir, { recursive: true, force: true });
  }
});

// ---- the lowering, in isolation -----------------------------------------

const wrap = (code, message, file, start, length, severity) => ({ code, message, file, start, length, severity });
const frameOf = (w, h, quadrants) => ({ rgba: quadrantImage(w, h, quadrants), width: w, height: h });
const sprite = (animations) => ({ name: 'p', width: 16, height: 16, animations, start: 0, length: 1 });
const opaque = (w, h, on) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (on(x, y)) rgba.set([255, 255, 255, 255], (y * w + x) * 4);
    }
  }
  return { rgba, width: w, height: h };
};

test('web lowering: a quadrant-shaped 16×16 picture lowers to exactly the pixels of its block glyph', () => {
  for (let q = 1; q < 16; q += 1) {
    const out = web.lowerGraphics(sprite([]), [frameOf(16, 16, q)], {}, 't.8bg', wrap);
    assert.deepEqual(out.data, blockRows(q), `quadrants ${q}`);
    assert.equal(out.frames, 1);
    assert.equal(out.width, 8);
    assert.equal(out.height, 8);
  }
});

test('web lowering: an 8×8 source is carried pixel for pixel, bit 0 the leftmost pixel, with nothing said about it', () => {
  // A diagonal from the top-left: row r has only pixel r lit.
  const diagonal = opaque(8, 8, (x, y) => x === y);
  const out = web.lowerGraphics(sprite([]), [diagonal], {}, 't.8bg', wrap);
  assert.deepEqual(out.data, [1, 2, 4, 8, 16, 32, 64, 128]);
  assert.deepEqual(out.diagnostics, [], 'a one-ink 8×8 picture loses nothing, so says nothing');
  // The same shape through the renderer's own bit order: pixel x of a row is bit x.
  const left = web.lowerGraphics(sprite([]), [opaque(8, 8, (x) => x === 0)], {}, 't.8bg', wrap);
  assert.deepEqual(left.data, new Array(8).fill(1));
  const right = web.lowerGraphics(sprite([]), [opaque(8, 8, (x) => x === 7)], {}, 't.8bg', wrap);
  assert.deepEqual(right.data, new Array(8).fill(128));
});

test('web lowering: a larger source is reduced by area — a glyph pixel is lit at half its source pixels or more', () => {
  // 16×16: the glyph pixel at (1, 1) covers source x 2-3, y 2-3. One of four
  // lit is a quarter, below the share; two of four is half, at it.
  const quarter = opaque(16, 16, (x, y) => x === 2 && y === 2);
  const half = opaque(16, 16, (x, y) => x >= 2 && x <= 3 && y === 2);
  // A lone quarter is the picture's inkiest glyph pixel, so it is still lit
  // (a thin picture does not vanish); the half is lit on its own merits.
  assert.deepEqual(web.lowerGraphics(sprite([]), [quarter], {}, 't.8bg', wrap).data, [0, 2, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(web.lowerGraphics(sprite([]), [half], {}, 't.8bg', wrap).data, [0, 2, 0, 0, 0, 0, 0, 0]);
  // With a half somewhere else in the frame, the quarter no longer reaches
  // the threshold and goes dark: the share is 0.5, not "the inkiest".
  const both = opaque(16, 16, (x, y) => (x === 2 && y === 2) || (x >= 8 && x <= 9 && y === 8));
  assert.deepEqual(web.lowerGraphics(sprite([]), [both], {}, 't.8bg', wrap).data, [0, 0, 0, 0, 16, 0, 0, 0]);
  // A 10×12 block centred in a 16×16 frame (x 3-12, y 2-13): glyph columns
  // 1-6 reach half in every row from 1 to 6, and rows 0 and 7 are empty.
  const block = opaque(16, 16, (x, y) => x >= 3 && x <= 12 && y >= 2 && y <= 13);
  assert.deepEqual(web.lowerGraphics(sprite([]), [block], {}, 't.8bg', wrap).data, [0, 126, 126, 126, 126, 126, 126, 0]);
  // A size that is not a multiple of eight still covers every source pixel once.
  const wide = opaque(24, 21, () => true);
  assert.deepEqual(web.lowerGraphics(sprite([]), [wide], {}, 't.8bg', wrap).data, new Array(8).fill(255));
});

test('web lowering: a thin picture does not vanish, and an empty frame is eight zero bytes', () => {
  const rgba = new Uint8Array(16 * 16 * 4);
  rgba.set([255, 255, 255, 255], (3 * 16 + 3) * 4); // one pixel in the top-left quadrant
  const thin = web.lowerGraphics(sprite([]), [{ rgba, width: 16, height: 16 }], {}, 't.8bg', wrap);
  assert.deepEqual(thin.data, [0, 2, 0, 0, 0, 0, 0, 0], 'the glyph pixel that covers it is lit');
  const empty = web.lowerGraphics(sprite([]), [{ rgba: new Uint8Array(16 * 16 * 4), width: 16, height: 16 }], {}, 't.8bg', wrap);
  assert.deepEqual(empty.data, new Array(8).fill(0));
});

test('web lowering: an animation keeps its steps in order, repeats included, up to eight, eight bytes each', () => {
  const frames = [frameOf(16, 16, TL), frameOf(16, 16, TR), frameOf(16, 16, BL)];
  const out = web.lowerGraphics(sprite([{ frames: [2, 0, 0, 1], every: 5 }]), frames, {}, 't.8bg', wrap);
  assert.deepEqual(out.data, [BL, TL, TL, TR].flatMap((q) => blockRows(q)));
  assert.equal(out.frames, 4);
  assert.equal(out.every, 5);
  assert.ok(out.diagnostics.some((d) => d.code === '8BS2111' && /4 animation steps kept/.test(d.message)));

  const long = web.lowerGraphics(sprite([{ frames: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1], every: 1 }]), frames, {}, 't.8bg', wrap);
  assert.equal(long.data.length, web.MAX_STEPS * 8);
  assert.ok(long.diagnostics.some((d) => /steps past 8 dropped/.test(d.message)));
});

test('web lowering: more than one ink is dropped to the cell\'s one, and the build says so', () => {
  const two = opaque(8, 8, () => true);
  for (let i = 0; i < 8 * 8; i += 1) {
    two.rgba.set(i % 8 < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
  }
  const out = web.lowerGraphics(sprite([]), [two], {}, 't.8bg', wrap);
  assert.deepEqual(out.data, new Array(8).fill(255));
  assert.ok(out.diagnostics.some((d) => d.code === '8BS2111' && /colours dropped/.test(d.message)));
});

test('web lowering: a missing source falls back to a solid 8×8 cell, never PETSCII', () => {
  const out = web.lowerGraphics(sprite([]), [], {}, 't.8bg', wrap);
  assert.deepEqual(out.data, new Array(8).fill(255));
  assert.equal(out.frames, 1);
});
