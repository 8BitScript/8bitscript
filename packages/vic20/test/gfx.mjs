// Shared by the VIC-20's graphics emulator tests (graphics.test.mjs and
// graphics-ops.test.mjs): the geometry of a capture, the picture files the
// scenarios draw from, and the reads that turn a capture into cells.
//
// The twin (packages/graphics/src/index.vic20.8bs) draws an object as
// quadrant-block characters from the ROM — a cell holds a 2x2 pattern of
// half-cell blocks — so a capture can be read back without knowing which
// screen code was chosen: each cell is sampled at the middle of its four
// quadrants and the four lit/unlit reads are the cell's mask.
//
// The capture's geometry is the raster test's: 520 x 234 (NTSC), the
// picture from x = 40 and picture line 0 on row 22, a character cell
// 16 pixels wide and 8 tall, 22 x 23 of them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePNG } from '../../cli/src/png.mjs';
import { decode, lit, onPath, runCli } from './capture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CHECKOUT = join(HERE, '..', '..', '..');

export const LEFT = 40;
export const TOP = 22;
export const CELL_W = 16;
export const CELL_H = 8;
export const COLUMNS = 22;
export const ROWS = 23;

// The program starts running about this many `--frames` into the boot (the
// KERNAL's start-up and the autostart come first), measured by printing one
// mark a second under xvic: a scenario that acts after its own n-th
// `waitFrame()` is captured with --frames boot(n).
export const BOOT_FRAMES = 190;
export const boot = (n) => BOOT_FRAMES + n;

export const MACHINES = {
  unexpanded: [],
  '8k': ['--hardware', 'ram=8k'],
};

export const skip = !onPath('xvic') && 'xvic is not on PATH';

/** A PNG whose opaque black pixels are the blocks of `rows` ('1' = ink),
 *  each `scale` pixels square, the rest transparent. */
export function picture(rows, scale) {
  const width = rows[0].length * scale;
  const height = rows.length * scale;
  const rgba = Buffer.alloc(width * height * 4);
  rows.forEach((row, ry) => {
    [...row].forEach((ch, rx) => {
      if (ch !== '1') return;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          rgba.writeUInt32BE(0x000000ff, ((ry * scale + y) * width + rx * scale + x) * 4);
        }
      }
    });
  });
  return encodePNG(width, height, rgba);
}

/** Run `main.8bs` in `scratch` under xvic for `frames` frames; the capture as pixel reads. */
export async function shootFiles(scratch, name, machine, frames) {
  const shot = join(scratch, `${name}.png`);
  const { code, stdout, stderr } = await runCli([
    'run', 'vic20', '--checkout', CHECKOUT, ...MACHINES[machine], '--frames', String(frames), '--screenshot', shot, join(scratch, 'main.8bs'),
  ]);
  assert.equal(code, 0, `8bs run vic20 (${machine}) failed:\n${stdout}${stderr}`);
  return decode(readFileSync(shot));
}

// --- reading a capture ------------------------------------------------------

export const cellX = (col) => LEFT + col * CELL_W;
export const cellY = (row) => TOP + row * CELL_H;

/** A pixel that is any color but the black background — a red or blue ink as well as a white one. */
export const anyInk = ([r, g, b]) => r + g + b > 60;

/** The cell's four quadrants as bits: TL 8, TR 4, BL 2, BR 1. `on` says which pixels count (bright ones by default). */
export function maskOf(pixel, col, row, on = lit) {
  const at = (qx, qy) => (on(pixel(cellX(col) + qx, cellY(row) + qy)) ? 1 : 0);
  return (at(4, 2) << 3) | (at(12, 2) << 2) | (at(4, 6) << 1) | at(12, 6);
}

/** The cell's pixels, '#' lit and '.' not, row by row. */
export function bitsOf(pixel, col, row) {
  let s = '';
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) s += lit(pixel(cellX(col) + x, cellY(row) + y)) ? '#' : '.';
    s += '/';
  }
  return s;
}

/** The color of a cell's ink: the first pixel in it that is not the black background, as 'r,g,b' (null if none). */
export function inkOf(pixel, col, row) {
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) {
      const p = pixel(cellX(col) + x, cellY(row) + y);
      if (p[0] + p[1] + p[2] > 60) return p.join(',');
    }
  }
  return null;
}

/** Every cell with a lit pixel in it, as 'col,row'. */
export function litCells(pixel) {
  const found = new Set();
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      if (bitsOf(pixel, col, row).includes('#')) found.add(`${col},${row}`);
    }
  }
  return found;
}

/** Every cell with anything but background in it (any color), as 'col,row'. */
export function inkedCells(pixel) {
  const found = new Set();
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      if (inkOf(pixel, col, row) !== null) found.add(`${col},${row}`);
    }
  }
  return found;
}

export function cellsOf(col, row, masks) {
  const out = [];
  masks.forEach((line, dy) => line.forEach((mask, dx) => {
    if (mask !== 0) out.push(`${col + dx},${row + dy}`);
  }));
  return out;
}

export function assertObject(pixel, col, row, masks, label, on = lit) {
  masks.forEach((line, dy) => line.forEach((mask, dx) => {
    const got = maskOf(pixel, col + dx, row + dy, on);
    assert.equal(got, mask, `${label}: cell (${col + dx}, ${row + dy}) is ${got.toString(2)}, wanted ${mask.toString(2)}`);
  }));
}
