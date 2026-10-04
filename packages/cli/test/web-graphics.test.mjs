// @8bitscript/graphics on the web, end to end: real PNGs and a real .8bg
// compiled by the native web backend (packages/web/media/index.cjs lowers
// each picture to quadrant-block codes, packages/graphics/src/index.web.8bs
// plays them through the glyph layer), then rasterized by the headless
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

test('web lowering: each quadrant of the picture is one bit of the block code', () => {
  for (let q = 1; q < 16; q += 1) {
    const out = web.lowerGraphics(sprite([]), [frameOf(16, 16, q)], {}, 't.8bg', wrap);
    assert.deepEqual(out.data, [BLOCK_CODE_BASE + q], `quadrants ${q}`);
    assert.equal(out.frames, 1);
  }
});

test('web lowering: a thin picture does not vanish, and an empty frame is the empty block', () => {
  const rgba = new Uint8Array(16 * 16 * 4);
  rgba.set([255, 255, 255, 255], (3 * 16 + 3) * 4); // one pixel in the top-left quadrant
  const thin = web.lowerGraphics(sprite([]), [{ rgba, width: 16, height: 16 }], {}, 't.8bg', wrap);
  assert.deepEqual(thin.data, [BLOCK_CODE_BASE + TL]);
  const empty = web.lowerGraphics(sprite([]), [{ rgba: new Uint8Array(16 * 16 * 4), width: 16, height: 16 }], {}, 't.8bg', wrap);
  assert.deepEqual(empty.data, [BLOCK_CODE_BASE]);
});

test('web lowering: an animation keeps its steps in order, repeats included, up to eight', () => {
  const frames = [frameOf(16, 16, TL), frameOf(16, 16, TR), frameOf(16, 16, BL)];
  const out = web.lowerGraphics(sprite([{ frames: [2, 0, 0, 1], every: 5 }]), frames, {}, 't.8bg', wrap);
  assert.deepEqual(out.data, [BL, TL, TL, TR].map((q) => BLOCK_CODE_BASE + q));
  assert.equal(out.frames, 4);
  assert.equal(out.every, 5);
  assert.ok(out.diagnostics.some((d) => d.code === '8BS2111' && /4 animation steps kept/.test(d.message)));

  const long = web.lowerGraphics(sprite([{ frames: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1], every: 1 }]), frames, {}, 't.8bg', wrap);
  assert.equal(long.data.length, web.MAX_STEPS);
  assert.ok(long.diagnostics.some((d) => /steps past 8 dropped/.test(d.message)));
});

test('web lowering: a missing source falls back to a drawable solid block, never PETSCII', () => {
  const out = web.lowerGraphics(sprite([]), [], {}, 't.8bg', wrap);
  assert.deepEqual(out.data, [BLOCK_CODE_BASE + 15]);
  assert.ok(out.data.every((c) => c >= BLOCK_CODE_BASE && c < BLOCK_CODE_BASE + 16));
});
