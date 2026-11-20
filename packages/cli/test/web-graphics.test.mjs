// @8bitscript/graphics on the web, end to end: real PNGs and a real .8bg
// compiled by the native web backend (packages/web/media/index.cjs lowers
// each picture to a palette and 4bpp frames, packages/graphics/src/index.web.8bs
// writes them into the page's sprite region), then rasterized by the headless
// --screenshot path (captureScreenshot, the call `8bs run web --screenshot`
// makes). The pictures must land on the pixels their stage position names, an
// animated one must step through its frames in order at its `every`, the
// grid's last cell must draw, a position past the grid must draw nothing, and
// a CHARSET band over the pictures' rows must leave them alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { encodePNG, pixelAt } from '../src/png.mjs';
import { BORDER_PX, layoutFromHardware } from '../src/web-layout.mjs';
import { rgbPalette } from '../src/web-scanline.mjs';
import web from '../../web/media/index.cjs';
import cx16 from '../../cx16/media/index.cjs';

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
  'use @8bitscript::graphics::graphics;',
  'use @8bitscript::raster::{raster, Slot};',
  'use @8bitscript::sprites::sprites;',
  'use @8bitscript::text::text;',
  'use self::art::{bar, walk, dot, ghost};',
  '',
  'pub fn main() {',
  '    let row: usmallint = text::columns();',
  '    text::print(row * 8, "abc");',
  '    graphics::place(bar, 24, 16);',
  '    graphics::place(walk, 96, 40);',
  '    graphics::place(dot, sprites::right(), sprites::bottom());',
  '    graphics::place(ghost, sprites::right() + 8, 0);',
  '    raster::clear();',
  '    if raster::CHARSET {',
  '        raster::at(16, Slot::CHARSET, 1);',
  '        raster::at(48, Slot::CHARSET, 0);',
  '    }',
  '    raster::enable();',
  '    loop {',
  '        waitFrame();',
  '        graphics::update();',
  '    }',
  '}',
].join('\n');

/**
 * The w×h sprite box at stage pixel (x, y) as rows of 0/1: 1 where the pixel
 * is exactly `color`.
 */
function spriteBits(png, x, y, w, h, color) {
  const rows = [];
  for (let gy = 0; gy < h; gy += 1) {
    const row = [];
    for (let gx = 0; gx < w; gx += 1) {
      const px = pixelAt(png, BORDER_PX + x + gx, BORDER_PX + y + gy);
      row.push(px.every((v, i) => v === color[i]) ? 1 : 0);
    }
    rows.push(row);
  }
  return rows;
}

/** The pixels a quadrant picture of w×h has lit, as rows of 0/1. */
function quadrantBits(w, h, quadrants) {
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(Array.from({ length: w }, (_, x) => {
      const bit = y < h / 2 ? (x < w / 2 ? TL : TR) : (x < w / 2 ? BL : BR);
      return quadrants & bit ? 1 : 0;
    }));
  }
  return rows;
}

const blank = (w, h) => Array.from({ length: h }, () => new Array(w).fill(0));

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
  test(`graphics pictures land on their pixels and animate (${machine ?? 'Modern host'})`, async () => {
    const built = await build(machine);
    try {
      const layout = layoutFromHardware(built.result.hardware);
      // A picture shows its own colours (white here); a two-colour skin shows ink.
      const color = machine === 'pet-2001' ? rgbPalette(layout.palette)[1] : [255, 255, 255];
      const ink = rgbPalette(layout.palette)[1];
      const lastX = (layout.cols - 1) * 8;
      const lastY = (layout.rows - 1) * 8;
      const stepOf = (png) => {
        const bits = spriteBits(png, 96, 40, 16, 16, color);
        const found = WALK_ORDER.findIndex((q) => JSON.stringify(bits) === JSON.stringify(quadrantBits(16, 16, q)));
        assert.notEqual(found, -1, 'the pixels at (96, 40) are one of the walk frames');
        return found;
      };

      const seen = [];
      for (let frames = 2; frames <= 11; frames += 1) {
        const png = await shoot(built, frames);
        seen.push(stepOf(png));
        // The still picture, the grid's last cell, and the pixels that stay blank.
        assert.deepEqual(spriteBits(png, 24, 16, 16, 16, color), quadrantBits(16, 16, BAR), `bar at (24, 16) at frame ${frames}`);
        assert.deepEqual(spriteBits(png, lastX, lastY, 8, 8, color), quadrantBits(8, 8, 15), `dot on the last cell at frame ${frames}`);
        assert.deepEqual(spriteBits(png, 40, 16, 8, 16, color), blank(8, 16), 'the pixels beside the bar are empty');
        // A picture placed at the grid's right edge draws nothing, and nothing wraps.
        assert.deepEqual(spriteBits(png, 0, 8, 8, 8, color), blank(8, 8), 'nothing wrapped onto the next row');
        assert.deepEqual(spriteBits(png, lastX, 0, 8, 8, color), blank(8, 8), 'nothing drawn at the right edge of row 0');
        // The text under no band is the boot set: "abc" on row 8 in lower case.
        assert.deepEqual(spriteBits(png, 0, 64, 8, 8, ink).flat().some(Boolean), true, 'row 8 has text');
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

test('a picture in the CHARSET band is unchanged (a sprite is drawn over the cells, not by them)', async () => {
  const built = await build(undefined);
  try {
    const png = await shoot(built, 3);
    // picture lines 16-47 are inside the band: the bar is there and is unchanged.
    assert.deepEqual(spriteBits(png, 24, 16, 16, 16, [255, 255, 255]), quadrantBits(16, 16, BAR));
  } finally {
    await rm(built.dir, { recursive: true, force: true });
  }
});

// ---- the lowering, in isolation -----------------------------------------

const wrap = (code, message, file, start, length, severity) => ({ code, message, file, start, length, severity });
const FACTS = { 'video.sprites': 16, 'video.spriteWidth': 64, 'video.spriteHeight': 64, 'video.spriteKib': 16 };
const sprite = (animations, name = 'p') => ({ name, width: 16, height: 16, animations, start: 0, length: 1 });
const frameOf = (w, h, quadrants, rgb = [255, 255, 255]) => {
  const rgba = quadrantImage(w, h, quadrants);
  for (let i = 0; i < w * h; i += 1) if (rgba[i * 4 + 3]) rgba.set(rgb, i * 4);
  return { rgba, width: w, height: h };
};
const messages = (out) => out.diagnostics.map((d) => d.message);

test('web lowering: bytes 2.. are the cx16 lowering byte for byte, for 8x8, 16x16 and 64x64 sources', () => {
  const cases = [
    { frames: [frameOf(8, 8, TL | BR, [200, 40, 40])], anim: [] },
    { frames: [frameOf(16, 16, TL, [10, 200, 30]), frameOf(16, 16, BR, [30, 30, 220])], anim: [{ frames: [0, 1], every: 3 }] },
    { frames: [frameOf(64, 64, TL), frameOf(64, 64, TR, [250, 250, 0]), frameOf(64, 64, BL, [0, 250, 250])], anim: [{ frames: [0, 1, 2], every: 4 }] },
  ];
  for (const { frames, anim } of cases) {
    const w = web.lowerGraphics(sprite(anim), frames, FACTS, 't.8bg', wrap, { graphics: 1 });
    const c = cx16.lowerGraphics(sprite(anim), frames, {}, 't.8bg', wrap);
    assert.deepEqual(w.data.slice(2), c.data, `${frames[0].width}x${frames[0].width}`);
    assert.deepEqual(w.data.slice(0, 2), [0, 0], 'the first picture starts at pool offset 0');
    assert.equal(w.kind, 6);
    assert.equal(w.frames, c.frames);
    assert.equal(w.every, c.every);
    assert.equal(w.width, c.width);
    assert.equal(w.height, c.height);
  }
});

test('web lowering: the pool offset is where the build has counted to, and frames add up', () => {
  const tally = { graphics: 1 };
  const first = web.lowerGraphics(sprite([]), [frameOf(16, 16, TL)], FACTS, 't.8bg', wrap, tally);
  assert.equal(tally.webSpriteBytes, 128, 'a 16x16 frame is 128 bytes');
  tally.graphics = 2;
  const second = web.lowerGraphics(sprite([]), [frameOf(16, 16, TR)], FACTS, 't.8bg', wrap, tally);
  assert.deepEqual(first.data.slice(0, 2), [0, 0]);
  assert.deepEqual(second.data.slice(0, 2), [128, 0]);
  assert.equal(tally.webSpriteBytes, 256);
});

test('web lowering: a picture past the pool keeps the frames that fit and says so; none left is allowed', () => {
  const facts = { ...FACTS, 'video.spriteKib': 4 };
  const frames = [frameOf(64, 64, TL), frameOf(64, 64, TR)];
  const tally = { graphics: 1 };
  const both = web.lowerGraphics(sprite([{ frames: [0, 1], every: 1 }], 'a'), frames, facts, 't.8bg', wrap, tally);
  assert.equal(both.frames, 2);
  assert.equal(tally.webSpriteBytes, 4096);
  tally.graphics = 2;
  const none = web.lowerGraphics(sprite([{ frames: [0, 1], every: 1 }], 'b'), frames, facts, 't.8bg', wrap, tally);
  assert.equal(none.frames, 0);
  assert.equal(none.data.length, 34, 'a pool offset and a palette, no frames');
  assert.ok(messages(none).includes("sprite 'b': the 4096-byte sprite pool has 0 bytes left; 0 of 2 frames kept"), messages(none).join('|'));
  const small = { ...FACTS, 'video.spriteKib': 3 };
  const t2 = { graphics: 1 };
  const one = web.lowerGraphics(sprite([{ frames: [0, 1], every: 1 }], 'c'), frames, small, 't.8bg', wrap, t2);
  assert.equal(one.frames, 1);
  assert.ok(messages(one).includes("sprite 'c': the 3072-byte sprite pool has 3072 bytes left; 1 of 2 frames kept"), messages(one).join('|'));
  assert.equal(t2.webSpriteBytes, 2048);
});

test('web lowering: a slot at or past video.sprites is never drawn and says so', () => {
  const facts = { ...FACTS, 'video.sprites': 2 };
  const out = web.lowerGraphics(sprite([], 'late'), [frameOf(16, 16, TL)], facts, 't.8bg', wrap, { graphics: 3 });
  assert.deepEqual(out.data, []);
  assert.equal(out.frames, 0);
  assert.deepEqual(messages(out), ["sprite 'late' is slot 2; this build has 2 sprites, so it is never drawn"]);
  const tally = { graphics: 3 };
  web.lowerGraphics(sprite([], 'late'), [frameOf(16, 16, TL)], facts, 't.8bg', wrap, tally);
  assert.equal(tally.webSpriteBytes, undefined, 'a slot never drawn takes no pool');
  const none = web.lowerGraphics(sprite([], 'x'), [frameOf(16, 16, TL)], { ...FACTS, 'video.sprites': 0 }, 't.8bg', wrap, { graphics: 1 });
  assert.equal(none.frames, 0);
});

test('web lowering: a missing source is one 8x8 white block, and a thin 8x8 loses nothing', () => {
  const out = web.lowerGraphics(sprite([]), [], FACTS, 't.8bg', wrap, { graphics: 1 });
  assert.equal(out.frames, 1);
  assert.equal(out.width, 8);
  assert.deepEqual(out.data.slice(0, 2), [0, 0]);
  assert.deepEqual(out.data.slice(2, 6), [0, 0, 0xFF, 0x0F], 'entry 1 is white');
  assert.deepEqual(out.data.slice(34), new Array(32).fill(0x11), 'every pixel is index 1');
  assert.deepEqual(out.diagnostics, []);
});

test('web lowering: a source over 64 and more than fifteen colours are named, a VERA note is not', () => {
  const big = frameOf(80, 80, 15);
  const out = web.lowerGraphics(sprite([]), [big], FACTS, 't.8bg', wrap, { graphics: 1 });
  assert.ok(messages(out).some((m) => /a web sprite is at most 64x64/.test(m)), messages(out).join('|'));
  assert.ok(!messages(out).some((m) => /VERA/.test(m)));
  const many = frameOf(16, 16, 15);
  for (let i = 0; i < 256; i += 1) many.rgba.set([i, 255 - i, (i * 7) & 255, 255], i * 4);
  const out2 = web.lowerGraphics(sprite([]), [many], FACTS, 't.8bg', wrap, { graphics: 1 });
  assert.ok(out2.diagnostics.some((d) => d.code === '8BS2110' && /a web sprite holds 15 plus transparent/.test(d.message)));
});
