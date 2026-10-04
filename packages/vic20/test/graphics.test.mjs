// @8bitscript/graphics on the VIC-20, run for real under xvic and read by
// pixel. The twin (packages/graphics/src/index.vic20.8bs) draws an object
// as quadrant-block characters from the ROM — a cell holds a 2x2 pattern
// of half-cell blocks — so a capture can be read back without knowing
// which screen code was chosen: each cell is sampled at the middle of its
// four quadrants and the four lit/unlit reads are the cell's mask.
//
// Every scenario writes its own little project (PNGs, a .8bg, a program)
// into a scratch directory and runs it through `8bs run vic20
// --screenshot`, on the unexpanded machine and on 8K, because the two put
// the screen in different places and the 8K one puts the program right
// after it (packages/vic20/AGENTS.md, "Graphics").
//
// The capture's geometry and the reads are in gfx.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodePNG } from '../../cli/src/png.mjs';
import {
  MACHINES, COLUMNS, ROWS, assertObject, bitsOf, cellsOf, litCells, maskOf, picture, shootFiles, skip,
} from './gfx.mjs';

// --- the assets ------------------------------------------------------------

// A 16x16 object in 4x4-pixel blocks, so each cell is a 2x2 mask:
//   cell (0,0): lit TL, BR     cell (1,0): lit TR, BL
//   cell (0,1): lit TR, BL     cell (1,1): lit BR
const BIG = ['1001', '0110', '0100', '1001'];
const BIG_MASKS = [[0b1001, 0b0110], [0b0110, 0b0001]];
// An 8x8 object: one cell, three of its four quadrants.
const SMALL = ['10', '11'];
const SMALL_MASK = 0b1011;
// Two ink pixels in a 16x16: too little to survive as blocks.
const FAINT_PIXELS = [[3, 3], [12, 12]];
// Two frames side by side: the left column of cells, then the right.
const SPIN_A = ['1100', '1100', '1100', '1100'];
const SPIN_B = ['0011', '0011', '0011', '0011'];
const SPIN_MASKS = [
  [[0b1111, 0], [0b1111, 0]],
  [[0, 0b1111], [0, 0b1111]],
];

function faintPicture() {
  const rgba = Buffer.alloc(16 * 16 * 4);
  for (const [x, y] of FAINT_PIXELS) rgba.writeUInt32BE(0x000000ff, (y * 16 + x) * 4);
  return encodePNG(16, 16, rgba);
}

const SPRITES = `sprite big { source "./big.png" size 16x16 transparent auto }
sprite small { source "./small.png" size 8x8 transparent auto }
sprite faint { source "./faint.png" size 16x16 transparent auto }
sprite spin {
  source "./spin.png"
  size 16x16
  transparent auto
  animation go {
    frames 0, 1
    every 4
  }
}
`;
// A second .8bg module: its sprite must not share a slot with the first's.
const OTHER = `sprite other { source "./big.png" size 16x16 transparent auto }
`;

const IMPORTS = `import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
import { graphics } from "@8bitscript/graphics";
import { big, small, faint, spin } from "./g.8bg";
import { other } from "./h.8bg";
`;

const FILL = 'XXXXXXXXXXXXXXXXXXXXXX';

const STATIC = `${IMPORTS}
export function main(): void {
    screen.blank();
    text.print(66, "${FILL}");
    text.print(88, "${FILL}");
    graphics.place(small, 40, 24);
    graphics.place(faint, 96, 24);
    graphics.place(big, 80, 64);
    graphics.place(other, 8, 112);
    while (true) {
        waitFrame();
        graphics.update();
    }
}
`;

// Placed at the top-left, moved to the bottom-right corner (whose second
// column and second row are off the screen), then to the middle. Text is
// printed after the corner placement: on 8K the cell after the screen's
// last is where the program begins.
const MOVE = `${IMPORTS}
export function main(): void {
    let n: utinyint = 0;
    screen.blank();
    graphics.place(big, 0, 0);
    while (n < 20) {
        waitFrame();
        graphics.update();
        n = n + 1;
    }
    graphics.place(big, 168, 176);
    text.print(0, "OK");
    n = 0;
    while (n < 20) {
        waitFrame();
        graphics.update();
        n = n + 1;
    }
    graphics.place(big, 168, 40);
    n = 0;
    while (n < 20) {
        waitFrame();
        graphics.update();
        n = n + 1;
    }
    graphics.place(big, 80, 80);
    while (true) {
        waitFrame();
        graphics.update();
    }
}
`;

const ANIMATE = `${IMPORTS}
export function main(): void {
    screen.blank();
    graphics.place(spin, 80, 40);
    while (true) {
        waitFrame();
        graphics.update();
    }
}
`;

async function project(scratch, program) {
  await writeFile(join(scratch, 'big.png'), picture(BIG, 4));
  await writeFile(join(scratch, 'small.png'), picture(SMALL, 4));
  await writeFile(join(scratch, 'faint.png'), faintPicture());
  await writeFile(join(scratch, 'spin.png'), picture(SPIN_A.map((row, i) => row + SPIN_B[i]), 4));
  await writeFile(join(scratch, 'g.8bg'), SPRITES);
  await writeFile(join(scratch, 'h.8bg'), OTHER);
  const file = join(scratch, 'main.8bs');
  await writeFile(file, program);
  return file;
}

async function shoot(scratch, name, machine, frames, program) {
  await project(scratch, program);
  return shootFiles(scratch, name, machine, frames);
}

// --- the scenarios ----------------------------------------------------------

for (const machine of Object.keys(MACHINES)) {
  test(`under VICE (${machine}), objects land on their cells, an 8x8 one takes one cell, and nothing it does not cover is touched`, { skip }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-vic20-gfx-'));
    try {
      const pixel = await shoot(scratch, `static-${machine}`, machine, 300, STATIC);
      // The 8x8 object: one cell, three quadrants — and the text around it
      // still there, not blanked by the three cells it does not use.
      const x = bitsOf(pixel, 0, 3);
      assert.ok(x.includes('#'), 'the filler text is drawn');
      assert.equal(maskOf(pixel, 5, 3), SMALL_MASK, '8x8 object at (5, 3)');
      for (const [c, r] of [[4, 3], [6, 3], [5, 4], [6, 4]]) {
        assert.equal(bitsOf(pixel, c, r), x, `the filler at (${c}, ${r}) beside the 8x8 object is intact`);
      }
      // The faint one: too little ink for blocks, so one glyph in one cell.
      const glyph = bitsOf(pixel, 12, 3);
      assert.ok(glyph.includes('#') && glyph !== x, 'a single glyph, not filler');
      for (const [c, r] of [[11, 3], [13, 3], [12, 4], [13, 4]]) {
        assert.equal(bitsOf(pixel, c, r), x, `the filler at (${c}, ${r}) beside the glyph is intact`);
      }
      // The 16x16 ones, from two different .8bg files, both on screen.
      assertObject(pixel, 10, 8, BIG_MASKS, 'big');
      assertObject(pixel, 1, 14, BIG_MASKS, 'other (a second .8bg module)');
      // And nothing else anywhere.
      const wanted = new Set([
        ...Array.from({ length: COLUMNS }, (_, c) => `${c},3`),
        ...Array.from({ length: COLUMNS }, (_, c) => `${c},4`),
        ...cellsOf(10, 8, BIG_MASKS),
        ...cellsOf(1, 14, BIG_MASKS),
      ]);
      assert.deepEqual([...litCells(pixel)].sort(), [...wanted].sort());
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test(`under VICE (${machine}), a moved object leaves no trail, and one placed at the corner stays on the screen and leaves the program alone`, { skip }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-vic20-gfx-'));
    try {
      const pixel = await shoot(scratch, `move-${machine}`, machine, 400, MOVE);
      assertObject(pixel, 10, 10, BIG_MASKS, 'moved to the middle');
      // The program got past the corner placement (it printed OK there and
      // then moved the object on), and the corner and the top-left it left
      // are blank: the OK is the only thing at the top-left now.
      const wanted = new Set(['0,0', '1,0', ...cellsOf(10, 10, BIG_MASKS)]);
      assert.deepEqual([...litCells(pixel)].sort(), [...wanted].sort());
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

test('under VICE, an animated object steps through its frames every `every` updates, and the cells the frame leaves are blanked', { skip }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-vic20-gfx-'));
  try {
    const seen = [];
    for (const frames of [300, 304, 308, 312]) {
      const pixel = await shoot(scratch, `spin-${frames}`, '8k', frames, ANIMATE);
      const which = SPIN_MASKS.findIndex((masks) => masks.every((line, dy) => line.every((mask, dx) => maskOf(pixel, 10 + dx, 5 + dy) === mask)));
      assert.notEqual(which, -1, `frames ${frames}: the object shows one of its two frames`);
      assert.deepEqual([...litCells(pixel)].sort(), cellsOf(10, 5, SPIN_MASKS[which]).sort(), `frames ${frames}: only that frame's cells are lit`);
      seen.push(which);
    }
    // `every 4`: four frames on, the other frame shows.
    assert.notEqual(seen[0], seen[1]);
    assert.equal(seen[0], seen[2]);
    assert.equal(seen[1], seen[3]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
