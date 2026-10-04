// The portable graphics calls (packages/graphics/src/index.8bs, "the calls")
// on the web, end to end: a real .8bg compiled by the native web backend and
// rasterized by the headless --screenshot path, the way web-graphics.test.mjs
// proves placement. setFrame() shows the frame it names and clamps one past
// the last, animate(false) holds an animation where it is while others play,
// hide() takes a picture off until place() puts it back, and color() tints
// the cell. The same twin code (packages/graphics/src/index.web.8bs) is the
// pattern the generic twin (index.8bs) follows, which no emulator reaches.
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
  'import { graphics } from "@8bitscript/graphics";',
  'import { held, free, clamped, gone, back, tinted } from "./art.8bg";',
  '',
  'export function main(): void {',
  '    graphics.place(held, 16, 16);',
  '    graphics.setFrame(held, 2);',
  '    graphics.animate(held, false);',
  '    graphics.place(free, 48, 16);',
  '    graphics.place(clamped, 80, 16);',
  '    graphics.setFrame(clamped, 99);',
  '    graphics.animate(clamped, false);',
  '    graphics.place(gone, 112, 16);',
  '    graphics.hide(gone);',
  '    graphics.place(back, 128, 16);',
  '    graphics.hide(back);',
  '    graphics.place(back, 128, 16);',
  '    graphics.place(tinted, 144, 16);',
  '    graphics.color(tinted, 2);',
  '    while (true) {',
  '        waitFrame();',
  '        graphics.update();',
  '    }',
  '}',
  '',
].join('\n');

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
    const ink = palette[1];
    const tint = palette[2];
    assert.notDeepEqual(ink, tint, 'colours 1 and 2 differ, or the colour check proves nothing');

    const seenFree = [];
    for (const frames of [3, 5, 7, 9]) {
      const shot = join(dir, `out-${frames}.png`);
      await captureScreenshot('web', result.outFile, shot, { frames, hardware: result.hardware });
      const png = await readFile(shot);
      const hold = cellBits(png, 2, 2, ink);
      assert.deepEqual(hold, blockRows(ORDER[2]), `animate(false) holds setFrame(2) at frame ${frames}`);
      assert.deepEqual(cellBits(png, 10, 2, ink), blockRows(ORDER[3]), `setFrame(99) is the last frame at ${frames}`);
      assert.deepEqual(cellBits(png, 14, 2, ink), BLANK, `a hidden picture draws nothing at ${frames}`);
      assert.deepEqual(cellBits(png, 16, 2, ink), blockRows(15), `place() after hide() draws it again at ${frames}`);
      assert.deepEqual(cellBits(png, 18, 2, tint), blockRows(15), `color(2) tints the cell at ${frames}`);
      assert.deepEqual(cellBits(png, 18, 2, ink), BLANK, `and leaves none of it in colour 1 at ${frames}`);
      const bits = cellBits(png, 6, 2, ink);
      const step = ORDER.findIndex((q) => bits.every((b, i) => b === blockRows(q)[i]));
      assert.notEqual(step, -1, `the free picture is one of the frames at ${frames}`);
      seenFree.push(step);
    }
    assert.ok(new Set(seenFree).size > 1, `the picture that was not paused moves on: ${seenFree.join(',')}`);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});
