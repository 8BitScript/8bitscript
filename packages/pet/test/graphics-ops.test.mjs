// @8bitscript/graphics on the PET: the contract's operations, one at a time,
// read off a headless xpet screenshot — hide, place again, setFrame (and its
// clamp), animate on and off, a hidden object's frame, edges, and what an
// object covers coming back (docs/project/graphics.md, "The portable
// contract"). graphics.test.mjs covers pictures landing and animating; this
// file covers the calls a program makes on them.
//
// A program here is a timeline: a frame counter `t`, and one call at each
// of a few values of it, sixty frames apart. `--frames T` photographs the
// machine T frames after reset; the program starts about BOOT frames in
// (measured: the first frame the ring shows, per model), so t is T - BOOT.
// Every look is taken in the middle of a stretch, 25 frames from the call
// before and the one after, so a few frames of boot drift change nothing.
//
// A look can be torn: a capture taken while the sprite layer redraws shows
// an object part old and part new (packages/sprites/src/index.pet.8bs,
// header). Each claim is therefore made over several looks: no clean look
// may show the wrong thing, a torn look is allowed once, and at least one
// look must be clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GEOMETRY, RING, SKIP, WALK, eightBg, isLit, readShape, sheet, shoot } from './graphics-helpers.mjs';

// A solid block and a ring: a two-frame picture, to animate beside the walk.
const BLINK = [[15, 15, 15, 15], RING];
const BLANK = [0, 0, 0, 0];

// Frames the machine spends before main() runs, by model (measured).
const BOOT = { '2001': 195, '3032': 195, '4032': 150, '8032': 150 };

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** What a look at one object shows: the index of the picture, 'blank', or 'torn'. */
function classify(rows, pictures) {
  const i = pictures.findIndex((p) => same(p, rows));
  if (i !== -1) return i;
  return same(rows, BLANK) ? 'blank' : 'torn';
}

/**
 * Hold a claim over a group of looks: at most one torn, at least one clean,
 * and every clean one satisfies `ok`.
 */
function holds(seq, ok, label) {
  const clean = seq.filter((s) => s !== 'torn');
  assert.ok(seq.length - clean.length <= 1, `${label}: more than one torn look: ${seq}`);
  assert.ok(clean.length >= 1, `${label}: no clean look: ${seq}`);
  for (const s of clean) assert.ok(ok(s), `${label}: unexpected ${s} among ${seq}`);
}

function fixtures(dir) {
  for (const [name, frames] of [['ring', [RING]], ['walk', WALK], ['blink', BLINK]]) {
    writeFileSync(join(dir, `${name}.png`), sheet(frames));
    writeFileSync(join(dir, `${name}.8bg`), eightBg(name, frames.length > 1));
  }
}

/** A program that places ring, walk and blink, then runs `calls` against a frame counter `t`. */
function timeline(dir, calls, { body = '', name = 'main' } = {}) {
  fixtures(dir);
  const file = join(dir, `${name}.8bs`);
  writeFileSync(file, `import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
import { graphics } from "@8bitscript/graphics";
import { ring } from "./ring.8bg";
import { walk } from "./walk.8bg";
import { blink } from "./blink.8bg";

export function main(): void {
    screen.blank();
${body}
    let t: usmallint = 0;
    while (true) {
        waitFrame();
        graphics.update();
        t = t + 1;
${calls}
    }
}
`);
  return { file };
}

const PLACE_ALL = `    graphics.place(ring, 16, 16);
    graphics.place(walk, 120, 136);
    graphics.place(blink, 224, 136);`;

const at = (t, call) => `        if (t == ${t}) { ${call} }`;

/** Photograph at several program times, in batches (xpet is heavy to start). */
async function looks(scratch, program, hardware, boot, ts) {
  const images = [];
  for (let i = 0; i < ts.length; i += 8) {
    const batch = ts.slice(i, i + 8);
    images.push(...await Promise.all(batch.map((t) => shoot(scratch, program, hardware, boot + t, `t${t}`))));
  }
  return new Map(ts.map((t, i) => [t, images[i]]));
}

/** Every cell with lit pixels outside the rectangles in `allowed` ([col, row, cols, rows]). */
function strays(image, geometry, allowed) {
  const found = [];
  for (let row = 0; row < 25; row += 1) {
    for (let col = 0; col < 40; col += 1) {
      if (allowed.some(([c, r, w, h]) => col >= c && col < c + w && row >= r && row < r + h)) continue;
      for (const qy of [2, 6]) {
        for (const qx of [2, 6]) {
          if (isLit(image, geometry.x0 + col * 8 + qx, geometry.y0 + row * geometry.pitch + qy)) found.push(`${col},${row}`);
        }
      }
    }
  }
  return [...new Set(found)];
}

// The cells (col, row, cols, rows) each object's 2 x 2 footprint covers.
const RING_A = [2, 2, 2, 2];   // ring at (16, 16)
const RING_B = [2, 6, 2, 2];   // ring at (16, 48)
const WALK_AT = [15, 17, 2, 2];
const BLINK_AT = [28, 17, 2, 2];

test('under xpet, hide removes an object, place brings it back, and the frame calls hold, clamp, pause and resume', { skip: SKIP }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-ops-'));
  try {
    const program = timeline(scratch, [
      at(60, 'graphics.hide(ring);'),
      at(120, 'graphics.place(ring, 16, 48);'),
      at(180, 'graphics.animate(walk, false);'),
      at(240, 'graphics.setFrame(walk, 2);'),
      at(300, 'graphics.setFrame(walk, 9);'),
      at(360, 'graphics.animate(walk, true);'),
      at(420, 'graphics.animate(walk, false); graphics.hide(walk);'),
      at(480, 'graphics.setFrame(walk, 1);'),
      at(540, 'graphics.place(walk, 120, 136);'),
      at(600, 'graphics.hide(blink);'),
      at(660, 'graphics.place(blink, 224, 136);'),
    ].join('\n'), { body: PLACE_ALL });
    const g = GEOMETRY['3032'];
    const ts = [25, 35, 85, 95, 145, 155, 205, 215, 225, 235, 265, 275, 285, 325, 335, 345,
      370, 375, 380, 385, 390, 395, 400, 405, 410, 445, 455, 465, 505, 515, 525, 565, 575, 585,
      625, 635, 645, 685, 695, 705];
    const shots = await looks(scratch, program, 'model=3032,ram=32', BOOT['3032'], ts);
    const ringA = (t) => classify(readShape(shots.get(t), g, 16, 16), [RING]);
    const ringB = (t) => classify(readShape(shots.get(t), g, 16, 48), [RING]);
    const walk = (t) => classify(readShape(shots.get(t), g, 120, 136), WALK);
    const blink = (t) => classify(readShape(shots.get(t), g, 224, 136), BLINK);

    holds([25, 35].map(ringA), (s) => s === 0, 'placed: the ring is drawn');
    holds([85, 95].map(ringA), (s) => s === 'blank', 'hide: the ring is gone');
    holds([85, 95].map(ringB), (s) => s === 'blank', 'hide: it is not at its next place yet either');
    holds([145, 155].map(ringB), (s) => s === 0, 'place after hide: the ring is back, elsewhere');
    holds([145, 155].map(ringA), (s) => s === 'blank', 'place after hide: nothing is left at the old place');
    // Nothing else is lit: hide put back what the ring covered, place drew only its own cells.
    for (const t of [85, 95, 145, 155]) {
      const loose = strays(shots.get(t), g, [RING_A, RING_B, WALK_AT, BLINK_AT]);
      assert.deepEqual(loose, [], `t=${t}: lit cells outside the pictures`);
    }

    const paused = [205, 215, 225, 235].map(walk);
    holds(paused, (s) => s === paused.find((v) => v !== 'torn'), 'animate(false): the walk holds one frame');
    const blinkLooks = [205, 215, 225, 235].map(blink).filter((s) => s !== 'torn');
    assert.ok(new Set(blinkLooks).size >= 2, `animate(false) on one picture leaves the other animating: ${blinkLooks}`);
    holds([265, 275, 285].map(walk), (s) => s === 2, 'setFrame(2) while paused');
    holds([325, 335, 345].map(walk), (s) => s === 3, 'setFrame(9) clamps to the last frame');

    const running = [370, 375, 380, 385, 390, 395, 400, 405, 410].map(walk).filter((s) => s !== 'torn');
    assert.ok(new Set(running).size >= 3, `animate(true) resumes stepping: ${running}`);

    holds([445, 455, 465].map(walk), (s) => s === 'blank', 'hide(walk)');
    holds([505, 515, 525].map(walk), (s) => s === 'blank', 'setFrame on a hidden object does not show it');
    holds([565, 575, 585].map(walk), (s) => s === 1, 'place after a hidden setFrame shows that frame, and it holds (paused)');
    holds([625, 635, 645].map(blink), (s) => s === 'blank', 'hide(blink)');
    holds([685, 695, 705].map(blink), (s) => s === 0 || s === 1, 'place(blink) after hide: drawn again');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under xpet, an object that does not fit the screen is not drawn, and does not wrap onto the next row', { skip: SKIP }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-edge-'));
  try {
    fixtures(scratch);
    const file = join(scratch, 'main.8bs');
    writeFileSync(file, `import { screen } from "@8bitscript/screen";
import { graphics } from "@8bitscript/graphics";
import { ring } from "./ring.8bg";
import { walk } from "./walk.8bg";
import { blink } from "./blink.8bg";

export function main(): void {
    screen.blank();
    graphics.place(ring, 312, 16);
    graphics.place(walk, 16, 200);
    graphics.place(blink, 400, 40);
    while (true) {
        waitFrame();
        graphics.update();
    }
}
`);
    const g = GEOMETRY['3032'];
    const shots = await looks(scratch, { file }, 'model=3032,ram=32', BOOT['3032'], [90, 110]);
    for (const [t, image] of shots) {
      assert.deepEqual(strays(image, g, []), [], `t=${t}: a half-off object drew something`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under xpet, text an object covered comes back when it is hidden', { skip: SKIP }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-restore-'));
  try {
    const say = '    text.print(163, "HELLO");';   // row 4, column 3: under the ring at (16, 32)
    const covered = timeline(scratch, at(80, 'graphics.hide(ring);'),
      { body: `${say}\n    graphics.place(ring, 16, 32);`, name: 'covered' });
    const bare = timeline(scratch, '', { body: say, name: 'bare' });
    const g = GEOMETRY['3032'];
    const [withRing, without] = await Promise.all([
      looks(scratch, covered, 'model=3032,ram=32', BOOT['3032'], [40, 120]),
      looks(scratch, bare, 'model=3032,ram=32', BOOT['3032'], [40]),
    ]);
    // The cells (cols 1-8, rows 3-6) hold the text and the ring.
    const region = (image) => {
      const out = [];
      for (let y = g.y0 + 3 * g.pitch; y < g.y0 + 7 * g.pitch; y += 1) {
        for (let x = g.x0 + 8; x < g.x0 + 72; x += 1) out.push(isLit(image, x, y) ? 1 : 0);
      }
      return out.join('');
    };
    const base = region(without.get(40));
    assert.notEqual(region(withRing.get(40)), base, 'the ring is over the text, so the region differs');
    assert.equal(region(withRing.get(120)), base, 'after hide, the text is back exactly as it was');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under xpet, hide, place and setFrame behave alike on the 2001, the CRTC 4032 and the 80-column 8032', { skip: SKIP }, async () => {
  const cases = [
    ['2001', 'model=2001,ram=8'],
    ['4032', 'model=4032,ram=32'],
    ['8032', 'model=8032,ram=32,speaker=attached'],
  ];
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-ops-models-'));
  try {
    // Ninety frames between calls: the models start the program at different
    // frames, and the 4032 and 8032 are the 50 Hz ones.
    const program = timeline(scratch, [
      at(2, 'graphics.animate(walk, false); graphics.animate(blink, false);'),
      at(60, 'graphics.hide(ring);'),
      at(150, 'graphics.place(ring, 16, 48);'),
      at(240, 'graphics.setFrame(walk, 3);'),
    ].join('\n'), { body: PLACE_ALL });
    for (const [model, hardware] of cases) {
      const g = GEOMETRY[model];
      const shots = await looks(scratch, program, hardware, BOOT[model], [25, 35, 95, 105, 185, 195, 275, 285]);
      const ringA = (t) => classify(readShape(shots.get(t), g, 16, 16), [RING]);
      const ringB = (t) => classify(readShape(shots.get(t), g, 16, 48), [RING]);
      const walk = (t) => classify(readShape(shots.get(t), g, 120, 136), WALK);
      holds([25, 35].map(ringA), (s) => s === 0, `${model}: placed`);
      holds([95, 105].map(ringA), (s) => s === 'blank', `${model}: hide`);
      holds([185, 195].map(ringB), (s) => s === 0, `${model}: place after hide`);
      holds([25, 35, 95, 105, 185, 195].map(walk), (s) => s === 0, `${model}: the paused walk holds frame 0`);
      holds([275, 285].map(walk), (s) => s === 3, `${model}: setFrame(3)`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
