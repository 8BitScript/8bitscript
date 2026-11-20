// The portable graphics calls (packages/graphics/src/index.8bs, "the calls")
// on the web, end to end: a real .8bg compiled by the native web backend and
// rasterized by the headless --screenshot path, the way web-graphics.test.mjs
// proves placement. setFrame() shows the frame it names and clamps one past
// the last, animate(false) holds an animation where it is while others play,
// hide() takes a picture off until place() puts it back, and color() tints
// the sprite. The same twin code (packages/graphics/src/index.web.8bs) is the
// pattern the generic twin (index.8bs) follows, which no emulator reaches.
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

const TL = 8;
const TR = 4;
const BL = 2;
const BR = 1;

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

const ORDER = [TL, TR, BR, BL];

const ART = [
  'sprite held {',
  '  source "./walk.png"',
  '  size 16x16',
  '  transparent auto',
  '  animation go {',
  '    frames 0, 1, 2, 3',
  '    every 2',
  '  }',
  '}',
  'sprite free {',
  '  source "./walk.png"',
  '  size 16x16',
  '  transparent auto',
  '  animation go {',
  '    frames 0, 1, 2, 3',
  '    every 2',
  '  }',
  '}',
  'sprite clamped {',
  '  source "./walk.png"',
  '  size 16x16',
  '  transparent auto',
  '  animation go {',
  '    frames 0, 1, 2, 3',
  '    every 2',
  '  }',
  '}',
  'sprite gone {',
  '  source "./dot.png"',
  '  size 8x8',
  '  transparent auto',
  '}',
  'sprite back {',
  '  source "./dot.png"',
  '  size 8x8',
  '  transparent auto',
  '}',
  'sprite tinted {',
  '  source "./dot.png"',
  '  size 8x8',
  '  transparent auto',
  '}',
  '',
].join('\n');

// held (column 2, row 2): setFrame(2) then animate(false) — frame 2 forever.
// free (column 6, row 2): plays on. clamped (column 10, row 2): setFrame(99)
// is the last frame. gone (column 14): placed, then hidden. back (column 16):
// placed, hidden, placed again. tinted (column 18): color(2).
const PROGRAM = [
  'use @8bitscript::graphics::graphics;',
  'use self::art::{held, free, clamped, gone, back, tinted};',
  '',
  'pub fn main() {',
  '    graphics::place(held, 16, 16);',
  '    graphics::setFrame(held, 2);',
  '    graphics::animate(held, false);',
  '    graphics::place(free, 48, 16);',
  '    graphics::place(clamped, 80, 16);',
  '    graphics::setFrame(clamped, 99);',
  '    graphics::animate(clamped, false);',
  '    graphics::place(gone, 112, 16);',
  '    graphics::hide(gone);',
  '    graphics::place(back, 128, 16);',
  '    graphics::hide(back);',
  '    graphics::place(back, 128, 16);',
  '    graphics::place(tinted, 144, 16);',
  '    graphics::color(tinted, 2);',
  '    loop {',
  '        waitFrame();',
  '        graphics::update();',
  '    }',
  '}',
].join('\n');

/** The w×h box at stage pixel (x, y) as rows of 0/1: 1 where the pixel is exactly `color`. */
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

function quadrantBits(w, h, quadrants) {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => {
    const bit = y < h / 2 ? (x < w / 2 ? TL : TR) : (x < w / 2 ? BL : BR);
    return quadrants & bit ? 1 : 0;
  }));
}

const blank = (w, h) => Array.from({ length: h }, () => new Array(w).fill(0));
const WHITE = [255, 255, 255];

test('graphics.setFrame, animate, hide, place-after-hide and color work on the web', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-graphics-ops-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'walk.png'), walkSheet(ORDER));
    await writeFile(join(dir, 'dot.png'), encodePNG(8, 8, quadrantImage(8, 8, TL | TR | BL | BR)));
    await writeFile(join(dir, 'art.8bg'), ART);
    await writeFile(join(dir, 'main.8bs'), PROGRAM);
    process.chdir(dir);
    const result = await silently(() => compile('web', join(dir, 'main.8bs'), { checkout: REPO, hardware: {} }));
    assert.equal(result.ok, true, 'builds');
    const layout = layoutFromHardware(result.hardware);
    const palette = rgbPalette(layout.palette);
    const tint = palette[2];
    assert.notDeepEqual(WHITE, tint, 'white and colour 2 differ, or the colour check proves nothing');

    const seenFree = [];
    for (const frames of [3, 5, 7, 9]) {
      const shot = join(dir, `out-${frames}.png`);
      await captureScreenshot('web', result.outFile, shot, { frames, hardware: result.hardware });
      const png = await readFile(shot);
      assert.deepEqual(spriteBits(png, 16, 16, 16, 16, WHITE), quadrantBits(16, 16, ORDER[2]), `animate(false) holds setFrame(2) at frame ${frames}`);
      assert.deepEqual(spriteBits(png, 80, 16, 16, 16, WHITE), quadrantBits(16, 16, ORDER[3]), `setFrame(99) is the last frame at ${frames}`);
      assert.deepEqual(spriteBits(png, 112, 16, 8, 8, WHITE), blank(8, 8), `a hidden picture draws nothing at ${frames}`);
      assert.deepEqual(spriteBits(png, 128, 16, 8, 8, WHITE), quadrantBits(8, 8, 15), `place() after hide() draws it again at ${frames}`);
      assert.deepEqual(spriteBits(png, 144, 16, 8, 8, tint), quadrantBits(8, 8, 15), `color(2) tints the sprite at ${frames}`);
      assert.deepEqual(spriteBits(png, 144, 16, 8, 8, WHITE), blank(8, 8), `and leaves none of it in its own colour at ${frames}`);
      const bits = spriteBits(png, 48, 16, 16, 16, WHITE);
      const step = ORDER.findIndex((q) => JSON.stringify(bits) === JSON.stringify(quadrantBits(16, 16, q)));
      assert.notEqual(step, -1, `the free picture is one of the frames at ${frames}`);
      seenFree.push(step);
    }
    assert.ok(new Set(seenFree).size > 1, `the picture that was not paused moves on: ${seenFree.join(',')}`);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});
