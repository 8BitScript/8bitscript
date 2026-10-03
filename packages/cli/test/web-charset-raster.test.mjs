// Slot.CHARSET on the web, end to end: a real .8bs program, compiled by the
// native web backend, builds a raster list through @8bitscript/raster
// (packages/web/src/rasterline.8bs) and the headless --screenshot path
// (captureScreenshot, the same call `8bs run web --screenshot` makes)
// rasterizes it. The program prints the same lower-case letters on three
// cell rows and switches to the alternate set for the middle one only; the
// picture must draw capitals there and lower case above and below — the
// split exactly at its line, not a row early or late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { glyphRows } from '../src/font8x8.mjs';
import { pixelAt } from '../src/png.mjs';
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

// Cell rows 0, 2 and 4 hold "abc"; the alternate set covers picture lines
// 16-31 (cell rows 2-3) only. `raster.CHARSET` is a folded constant: on a
// machine that answered false the whole list would fold away.
const PROGRAM = [
  'import { raster, Slot } from "@8bitscript/raster";',
  'import { text } from "@8bitscript/text";',
  '',
  'export function main(): void {',
  '    let row: usmallint = text.columns();',
  '    text.print(0, "abc");',
  '    text.print(row * 2, "abc");',
  '    text.print(row * 4, "abc");',
  '    raster.clear();',
  '    if (raster.CHARSET) {',
  '        raster.at(16, Slot.CHARSET, 1);',
  '        raster.at(32, Slot.CHARSET, 0);',
  '    }',
  '    raster.enable();',
  '    while (true) {',
  '        waitFrame();',
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

async function shoot(machine) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-charset-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), PROGRAM);
    process.chdir(dir);
    const result = await silently(() => compile('web', join(dir, 'main.8bs'), {
      checkout: REPO, hardware: machine ? { machine } : {},
    }));
    assert.equal(result.ok, true, `builds for ${machine ?? 'the Modern host'}`);
    const shot = join(dir, 'out.png');
    await captureScreenshot('web', result.outFile, shot, { frames: 2, hardware: result.hardware });
    return { png: await readFile(shot), layout: layoutFromHardware(result.hardware) };
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
}

for (const machine of [undefined, 'pet-2001']) {
  test(`a CHARSET band draws capitals on its rows only (${machine ?? 'Modern host'})`, async () => {
    const { png, layout } = await shoot(machine);
    // White text on every skin: the C64 palette's 1, or the PET's fixed
    // per-cell foreground (palette[1], its green).
    const ink = rgbPalette(layout.palette)[1];
    for (const [i, lower] of [97, 98, 99].entries()) {
      const upper = lower - 32;
      assert.deepEqual(cellBits(png, i, 0, ink), [...glyphRows(lower)], `row 0 col ${i}: boot set above the split`);
      assert.deepEqual(cellBits(png, i, 2, ink), [...glyphRows(upper)], `row 2 col ${i}: alternate set inside the band`);
      assert.deepEqual(cellBits(png, i, 4, ink), [...glyphRows(lower)], `row 4 col ${i}: boot set again below it`);
    }
  });
}
