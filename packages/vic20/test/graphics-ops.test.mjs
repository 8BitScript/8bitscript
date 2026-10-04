// The portable graphics operations on the VIC-20 — hide, setFrame, animate,
// color — run for real under xvic and read by pixel, on the unexpanded
// machine and on 8K (packages/vic20/AGENTS.md, "Graphics").
//
// test/graphics.test.mjs shows where objects land; these show what the rest
// of the contract does to them. The same twin code is also run cell by cell,
// without an emulator, by packages/graphics/test/vic20-ops.test.mjs, which is
// the half CI can run; this is the half that proves the 6502 build and the
// real `.8bg` lowering agree with it.
//
// Every scenario's program counts its own frames and acts at fixed counts,
// and a capture is taken at `--frames boot(n)`, so one program is shot at
// several moments (gfx.mjs, BOOT_FRAMES). The moments sit at least 20 frames
// from any change, so the start-up's few frames of slack cannot move a shot
// across one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MACHINES, anyInk, assertObject, bitsOf, boot, cellsOf, inkOf, inkedCells, litCells, maskOf, picture, shootFiles, skip,
} from './gfx.mjs';

// --- the assets ------------------------------------------------------------

// A 16x16 object in 4x4-pixel blocks, so each cell is a 2x2 mask.
const BIG = ['1001', '0110', '0100', '1001'];
const BIG_MASKS = [[0b1001, 0b0110], [0b0110, 0b0001]];
// Two frames side by side: the left column of cells, then the right.
const SPIN = ['11000011', '11000011', '11000011', '11000011'];
const SPIN_MASKS = [
  [[0b1111, 0], [0b1111, 0]],
  [[0, 0b1111], [0, 0b1111]],
];
// Eight frames of BIG side by side: every frame draws the same thing, so a
// pool that is read wrongly shows as a missing or garbled object.
const EIGHT = BIG.map((row) => row.repeat(8));

const GENERAL = `sprite big { source "./big.png" size 16x16 transparent auto }
sprite other { source "./big.png" size 16x16 transparent auto }
sprite spin {
  source "./spin.png"
  size 16x16
  transparent auto
  animation go {
    frames 0, 1
    every 4
  }
}
sprite spin2 {
  source "./spin.png"
  size 16x16
  transparent auto
  animation go {
    frames 0, 1
    every 4
  }
}
`;
// Two eight-frame objects fill the 64-byte pool exactly; the third does not fit.
const POOL = `sprite pa {
  source "./pool.png"
  size 16x16
  transparent auto
  animation go {
    frames 0, 1, 2, 3, 4, 5, 6, 7
    every 4
  }
}
sprite pb {
  source "./pool.png"
  size 16x16
  transparent auto
  animation go {
    frames 0, 1, 2, 3, 4, 5, 6, 7
    every 4
  }
}
sprite pc { source "./big.png" size 16x16 transparent auto }
`;

const HEAD = `import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
import { graphics } from "@8bitscript/graphics";
`;

/** A program that acts at its n-th frame: `events` is [[n, "statements"], ...]. */
function timeline(imports, setup, events) {
  const acts = events.map(([n, code]) => `        if (n == ${n}) {\n            ${code}\n        }`).join('\n');
  return `${HEAD}${imports}
export function main(): void {
    let n: usmallint = 0;
    screen.blank();
    ${setup}
    while (true) {
        waitFrame();
        n = n + 1;
${acts}
        graphics.update();
    }
}
`;
}

const files = (program, extra = {}) => ({
  'big.png': picture(BIG, 4),
  'spin.png': picture(SPIN, 4),
  'pool.png': picture(EIGHT, 4),
  'g.8bg': GENERAL,
  'p.8bg': POOL,
  'main.8bs': program,
  ...extra,
});

async function withProject(program, body) {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-vic20-ops-'));
  try {
    for (const [name, data] of Object.entries(files(program))) await writeFile(join(scratch, name), data);
    await body(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const sorted = (set) => [...set].sort();
const expected = (...cells) => cells.flat().sort();

// --- hide, and place to show again -----------------------------------------------

const HIDE = timeline(`import { big } from "./g.8bg";`, 'graphics.place(big, 8, 8);', [
  [40, 'graphics.hide(big);'],
  [100, 'graphics.place(big, 88, 120);'],
]);

for (const machine of Object.keys(MACHINES)) {
  test(`under VICE (${machine}), hide takes the object off the screen, and place shows it again where it is told`, { skip }, async () => {
    await withProject(HIDE, async (scratch) => {
      const before = await shootFiles(scratch, `hide-before-${machine}`, machine, boot(15));
      assertObject(before, 1, 1, BIG_MASKS, 'placed');
      assert.deepEqual(sorted(litCells(before)), expected(cellsOf(1, 1, BIG_MASKS)));

      const hidden = await shootFiles(scratch, `hide-hidden-${machine}`, machine, boot(70));
      assert.deepEqual(sorted(litCells(hidden)), [], 'hidden: nothing is lit');
      assert.deepEqual(sorted(inkedCells(hidden)), [], 'hidden: nothing is left in its colour either');

      const again = await shootFiles(scratch, `hide-again-${machine}`, machine, boot(130));
      assertObject(again, 11, 15, BIG_MASKS, 'placed again');
      assert.deepEqual(sorted(litCells(again)), expected(cellsOf(11, 15, BIG_MASKS)), 'only the new place is lit; the old one stayed blank');
    });
  });
}

// --- setFrame, animate -------------------------------------------------------------

// `spin` is paused and set to a frame past its last (so: its last); `spin2`
// plays on. At 120 `spin` plays again.
const FRAMES = timeline(`import { spin, spin2 } from "./g.8bg";`, 'graphics.place(spin, 80, 40);\n    graphics.place(spin2, 80, 88);', [
  [40, 'graphics.animate(spin, false);\n            graphics.setFrame(spin, 9);'],
  [120, 'graphics.animate(spin, true);'],
]);

/** Which of SPIN's two frames shows at (col, row): 0, 1, or -1 for neither. */
const frameAt = (pixel, col, row) => SPIN_MASKS.findIndex((masks) => masks.every((line, dy) => line.every((mask, dx) => maskOf(pixel, col + dx, row + dy) === mask)));

test('under VICE, a paused object holds the frame setFrame gave it (a frame past the last is the last) while another plays on, and plays again when resumed', { skip }, async () => {
  await withProject(FRAMES, async (scratch) => {
    const held = [];
    const playing = [];
    for (const at of [70, 74, 78, 82]) {
      const pixel = await shootFiles(scratch, `frames-${at}`, '8k', boot(at));
      held.push(frameAt(pixel, 10, 5));
      playing.push(frameAt(pixel, 10, 11));
      assert.deepEqual(sorted(litCells(pixel)), expected(cellsOf(10, 5, SPIN_MASKS[held[held.length - 1]] ?? []), cellsOf(10, 11, SPIN_MASKS[playing[playing.length - 1]] ?? [])), `frames ${at}: only the two objects' cells are lit`);
    }
    assert.deepEqual(held, [1, 1, 1, 1], 'paused on its last frame');
    assert.ok(!playing.includes(-1), 'the other object always shows one of its frames');
    assert.notEqual(playing[0], playing[1], 'the other object steps every four updates');
    assert.equal(playing[0], playing[2]);
    assert.equal(playing[1], playing[3]);

    const resumed = [];
    for (const at of [150, 154, 158, 162]) {
      const pixel = await shootFiles(scratch, `frames-${at}`, '8k', boot(at));
      resumed.push(frameAt(pixel, 10, 5));
    }
    assert.ok(!resumed.includes(-1));
    assert.notEqual(resumed[0], resumed[1], 'resumed: it steps again');
    assert.equal(resumed[0], resumed[2]);
  });
});

// --- color -------------------------------------------------------------------------

// Reference letters in three colors on the bottom row, to compare the objects'
// ink with; `big` is tinted, then given colors 9 (which is white wrapped, not
// multicolor), then red again and, 40 frames later, moved with a letter
// stored where it was.
const COLOR = timeline(`import { big, other } from "./g.8bg";`, `text.setColor(2);
    text.print(440, "X");
    text.setColor(1);
    text.print(441, "X");
    text.setColor(5);
    text.print(442, "X");
    graphics.place(big, 8, 8);
    graphics.place(other, 88, 8);`, [
  [40, 'graphics.color(big, 2);'],
  [100, 'graphics.color(big, 9);\n            graphics.color(other, 5);'],
  [160, 'graphics.color(big, 2);'],
  // Moved only now, once it has been drawn red: a place() flushes at once, so
  // doing both in one frame would never draw the red in the old cells.
  [200, 'graphics.place(big, 8, 120);\n            text.putChar(23, 88);'],
]);

for (const machine of Object.keys(MACHINES)) {
  test(`under VICE (${machine}), color tints one object, 9 wraps to white and never makes a cell multicolor, and what a move leaves behind is not in the object's ink`, { skip }, async () => {
    await withProject(COLOR, async (scratch) => {
      const at = async (n) => shootFiles(scratch, `color-${n}-${machine}`, machine, boot(n));
      const refs = (pixel) => ({ red: inkOf(pixel, 0, 20), white: inkOf(pixel, 1, 20), green: inkOf(pixel, 2, 20) });

      const start = await at(15);
      const r0 = refs(start);
      assert.equal(new Set(Object.values(r0)).size, 3, 'the three reference colors differ from one another');
      assert.equal(inkOf(start, 1, 1), r0.white, 'default ink: white');
      assert.equal(inkOf(start, 11, 1), r0.white);

      const red = await at(70);
      assertObject(red, 1, 1, BIG_MASKS, 'tinted', anyInk);
      assert.equal(inkOf(red, 1, 1), r0.red, 'color(big, 2): red');
      assert.equal(inkOf(red, 11, 1), r0.white, 'the other object keeps its ink');

      const wrapped = await at(130);
      assertObject(wrapped, 1, 1, BIG_MASKS, 'color 9: same cells, nothing garbled', anyInk);
      assert.equal(inkOf(wrapped, 1, 1), r0.white, '9 is 1 with bit 3 gone: white, a plain cell');
      assert.equal(inkOf(wrapped, 11, 1), r0.green, 'color(other, 5): green');

      const redAgain = await at(180);
      assertObject(redAgain, 1, 1, BIG_MASKS, 'red again', anyInk);
      assert.equal(inkOf(redAgain, 1, 1), r0.red, 'color(big, 2) once more: red');

      const moved = await at(240);
      assertObject(moved, 1, 15, BIG_MASKS, 'moved', anyInk);
      assert.equal(inkOf(moved, 1, 15), r0.red, 'still red after the move');
      assert.notEqual(inkOf(moved, 1, 1), null, 'the letter stored where the object was is there');
      assert.equal(inkOf(moved, 1, 1), r0.white, 'and is white, not the red the object left in color RAM');
      for (const [c, r] of [[2, 1], [1, 2], [2, 2]]) assert.equal(inkOf(moved, c, r), null, `(${c}, ${r}) was blanked`);
    });
  });
}

// --- the pool -----------------------------------------------------------------------

// Two eight-frame objects fill the pool exactly (32 + 32); the third does
// not fit and is not drawn. Every call on it does nothing, and a line of text
// beside them is not touched.
const POOLED = timeline(`import { pa, pb, pc } from "./p.8bg";`, `text.print(220, "CANARY");
    graphics.place(pa, 8, 8);
    graphics.place(pb, 64, 8);
    graphics.place(pc, 120, 8);`, [
  [30, 'graphics.setFrame(pc, 3);\n            graphics.color(pc, 2);\n            graphics.animate(pc, false);\n            graphics.hide(pc);\n            graphics.place(pc, 120, 8);'],
]);

for (const machine of Object.keys(MACHINES)) {
  test(`under VICE (${machine}), the 64-byte pool is filled exactly by two eight-frame objects, and a third that does not fit is not drawn and cannot be made to be`, { skip }, async () => {
    await withProject(POOLED, async (scratch) => {
      for (const n of [20, 80]) {
        const pixel = await shootFiles(scratch, `pool-${n}-${machine}`, machine, boot(n));
        assertObject(pixel, 1, 1, BIG_MASKS, `first object (frame ${n})`);
        assertObject(pixel, 8, 1, BIG_MASKS, `second object (frame ${n})`);
        const canary = Array.from({ length: 6 }, (_, c) => `${c},10`);
        assert.deepEqual(sorted(litCells(pixel)), expected(cellsOf(1, 1, BIG_MASKS), cellsOf(8, 1, BIG_MASKS), canary), `frame ${n}: the two that fit, the canary text, and nothing at the third's place`);
      }
    });
  });
}

// --- the raster list -----------------------------------------------------------------

// A mixed-case/upper-case split down the screen (Slot.CHARSET): the objects are
// ROM quadrant blocks, which the two sets share, so an object in either half
// is the same object. Screen code 66 differs between the sets, which is how
// the test knows the split is really there.
const SPLIT = `${HEAD}import { raster, Slot } from "@8bitscript/raster";
import { Video } from "@8bitscript/vic20/geometry";
import { big, other } from "./g.8bg";

export function main(): void {
    screen.blank();
    memory.write(Video.SCREEN + 2 * 22 + 10, 66);
    memory.write(Video.COLOR + 2 * 22 + 10, 1);
    memory.write(Video.SCREEN + 14 * 22 + 10, 66);
    memory.write(Video.COLOR + 14 * 22 + 10, 1);
    graphics.place(big, 8, 16);
    graphics.place(other, 8, 112);
    raster.clear();
    raster.at(0, Slot.CHARSET, 0);
    raster.at(88, Slot.CHARSET, 1);
    raster.enable();
    while (true) {
        waitFrame();
        graphics.update();
    }
}
`;

for (const machine of Object.keys(MACHINES)) {
  test(`under VICE (${machine}), an object looks the same in both halves of a Slot.CHARSET split`, { skip }, async () => {
    await withProject(SPLIT, async (scratch) => {
      const pixel = await shootFiles(scratch, `split-${machine}`, machine, boot(30));
      assert.notEqual(bitsOf(pixel, 10, 2), bitsOf(pixel, 10, 14), 'the glyph differs between the halves: the split is real');
      assertObject(pixel, 1, 2, BIG_MASKS, 'in the upper-case half');
      assertObject(pixel, 1, 14, BIG_MASKS, 'in the mixed-case half');
    });
  });
}
