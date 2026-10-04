// @8bitscript/graphics on the PET: a .8bg picture becomes a 4×4 quadrant-
// block object, an animation is one shape a frame, and the sprite layer's
// seven shapes are shared by every picture in the program.
//
// This file is the real thing under xpet: a program built from generated
// pictures, screenshotted headless, and read by pixel. The lowering and the
// link — slots, bind order, the budget's warnings — are tested in
// packages/compiler/test/media-lower.test.mjs, where CI runs them. The
// fixtures are written to a scratch directory at run time so no PNG lives
// in the tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GEOMETRY, RING, SKIP, WALK, eightBg, readShape, sheet, shoot } from './graphics-helpers.mjs';

// ---- fixtures ---------------------------------------------------------------

/** Write the pictures and a program into `dir`; `layout` is [name, frames, x, y] for each. */
function writeProgram(dir, layout) {
  const imports = [];
  const places = [];
  for (const [name, frames, x, y] of layout) {
    writeFileSync(join(dir, `${name}.png`), sheet(frames));
    writeFileSync(join(dir, `${name}.8bg`), eightBg(name, frames.length > 1));
    imports.push(`import { ${name} } from "./${name}.8bg";`);
    places.push(`    graphics.place(${name}, sprites.ORIGIN_X + ${x}, sprites.ORIGIN_Y + ${y});`);
  }
  const text = `import { screen } from "@8bitscript/screen";
import { graphics } from "@8bitscript/graphics";
import { sprites } from "@8bitscript/sprites";
${imports.join('\n')}

export function main(): void {
    screen.blank();
${places.join('\n')}
    while (true) {
        waitFrame();
        graphics.update();
    }
}
`;
  const file = join(dir, 'main.8bs');
  writeFileSync(file, text);
  return { file, text };
}

// ---- under xpet ---------------------------------------------------------------

// The animated pictures sit in the lower half of the screen on purpose. The
// sprite layer redraws a picture that changed right after the frame edge, about
// 2,600 cycles each, while the beam is still near the top of the picture: a
// capture that lands in that window shows a half-old, half-new object (seen
// here at y 16 — packages/sprites/src/index.pet.8bs, header, "tear"). By row 17
// the beam has not yet arrived when the redraw is done.

/** Frame counts at which a program is photographed: nine looks, five frames apart. */
const LOOKS = Array.from({ length: 9 }, (_, k) => 300 + 5 * k);

/**
 * What a run of looks at one animated picture has to show. A look is a
 * capture taken mid-frame, so one that lands on the frame where the picture
 * changes can hold part of the old picture and part of the new (the lines the
 * beam had drawn, and the lines it had not): that look matches none of the
 * pictures and is allowed, a couple of times. Every other look is one of the
 * pictures, each next one is the picture after or the one after that, and
 * every picture the sprite was given comes up.
 */
function assertStepsThrough(seq, count, label) {
  assert.ok(seq.filter((i) => i === -1).length <= 2, `${label}: at most two torn looks: ${seq}`);
  assert.ok(seq.every((i) => i < count), `${label}: never beyond the ${count} pictures it was given: ${seq}`);
  for (let i = 1; i < seq.length; i += 1) {
    if (seq[i] === -1 || seq[i - 1] === -1) continue;
    const step = (seq[i] - seq[i - 1] + count) % count;
    assert.ok(step === 1 || step === 2, `${label}: look ${i} is ${step} pictures on from the last: ${seq}`);
  }
  assert.equal(new Set(seq.filter((i) => i !== -1)).size, count, `${label}: all ${count} pictures come up: ${seq}`);
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const frameIndex = (rows, frames = WALK) => frames.findIndex((f) => same(f, rows));

test('under xpet, a static picture and a four-frame walk are drawn where they are placed, and the walk steps through its frames in order', { skip: SKIP }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-gfx-walk-'));
  try {
    const program = writeProgram(scratch, [['ring', [RING], 16, 16], ['walk', WALK, 120, 136]]);
    // Five frames apart is a step and a quarter of `every 4`: each look is the
    // next picture or the one after, mostly the next, so nine looks go round
    // the four. (Six apart is a step and a half — which, over a cycle of three
    // or four, can alternate between two pictures and never show the rest.)
    const times = LOOKS;
    const images = await Promise.all(times.map((t) => shoot(scratch, program, 'model=3032,ram=8', t, `walk-${t}`)));
    const geometry = GEOMETRY['3032'];
    const seen = images.map((image) => {
      assert.deepEqual(readShape(image, geometry, 16, 16), RING, 'the static ring, every look');
      return frameIndex(readShape(image, geometry, 120, 136));
    });
    assertStepsThrough(seen, 4, 'walk');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under xpet, pictures past the seven shapes lose frames, then vanish, exactly as the build said', { skip: SKIP }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-gfx-budget-'));
  try {
    const program = writeProgram(scratch, [['alpha', WALK, 16, 136], ['beta', WALK, 120, 136], ['gamma', [RING], 224, 136]]);
    const times = LOOKS;
    const images = await Promise.all(times.map((t) => shoot(scratch, program, 'model=3032,ram=8', t, `budget-${t}`)));
    const geometry = GEOMETRY['3032'];
    const alphaSeq = [];
    const betaSeq = [];
    for (const image of images) {
      alphaSeq.push(frameIndex(readShape(image, geometry, 16, 136)));
      betaSeq.push(frameIndex(readShape(image, geometry, 120, 136)));
      assert.deepEqual(readShape(image, geometry, 224, 136), [0, 0, 0, 0], 'gamma found no shape left and is not drawn');
    }
    assertStepsThrough(alphaSeq, 4, 'alpha, given all four');
    assertStepsThrough(betaSeq, 3, 'beta, given the three that were left');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under xpet, the same program draws the same pictures on the 2001, the CRTC 4032 and the 80-column 8032', { skip: SKIP }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-gfx-models-'));
  try {
    // The ring near the top-left and a walk in the bottom-right corner of a
    // 40-column screen: its last whole cells are columns 38-39 (x 304) and
    // rows 23-24 (y 184). The 80-column 8032 has room beyond that column.
    const program = writeProgram(scratch, [['ring', [RING], 16, 16], ['edge', WALK, 304, 184]]);
    const cases = [
      ['2001', 'model=2001,ram=8'],
      ['4032', 'model=4032,ram=32'],
      ['8032', 'model=8032,ram=32,speaker=attached'],
    ];
    const images = await Promise.all(cases.map(([model, hardware]) => shoot(scratch, program, hardware, 300, `model-${model}`)));
    cases.forEach(([model], i) => {
      const geometry = GEOMETRY[model];
      assert.deepEqual(readShape(images[i], geometry, 16, 16), RING, `${model}: ring`);
      assert.notEqual(frameIndex(readShape(images[i], geometry, 304, 184)), -1, `${model}: the picture in the bottom-right whole cells`);
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

