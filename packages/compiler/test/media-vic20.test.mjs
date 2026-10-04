// The VIC-20's .8bg lowering (packages/vic20/media/index.cjs) and the slots
// the compiler hands the sprites of a build (src/media/elaborate.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '@8bitscript/graphics-tools';
import { link } from '../index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);
const vicMedia = require('../../vic20/media/index.cjs');

const wrap = (code, message, file, start, length, severity = 'error') => ({ code, message, file, start, length, severity });

// A frame `size` pixels square: opaque black wherever `ink(x, y)` says so.
function frame(size, ink) {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (ink(x, y)) rgba.set([0, 0, 0, 255], (y * size + x) * 4);
    }
  }
  return { rgba, width: size, height: size };
}

const sprite = (animations) => ({ name: 's', start: 0, length: 1, animations });
const lower = (frames, animations) => vicMedia.lowerGraphics(sprite(animations), frames, {}, 'a.8bg', wrap);

// Screen codes of the ROM's quadrant blocks, by the pattern they show.
const SPACE = 32;
const SOLID = 160;
const LEFT_HALF = 97;
const RIGHT_HALF = 225;
const BOTTOM_RIGHT = 108;

test('a 16x16 lowers to one screen code per cell, worked out at build time', () => {
  // Left half of the picture inked: the left cells solid, the right empty.
  const result = lower([frame(16, (x) => x < 8)]);
  assert.equal(result.kind, 4);
  assert.deepEqual([result.width, result.height, result.frames], [16, 16, 1]);
  assert.deepEqual(result.data, [SOLID, SPACE, SOLID, SPACE]);
});

test('an 8x8 or smaller sprite is one cell, not four', () => {
  const result = lower([frame(8, (x, y) => x >= 4 && y >= 4)]);
  assert.deepEqual([result.width, result.height], [8, 8]);
  assert.deepEqual(result.data, [BOTTOM_RIGHT]);
});

test('a larger sprite is scaled down to two cells across and down', () => {
  const result = lower([frame(32, () => true)]);
  assert.deepEqual([result.width, result.height], [16, 16]);
  assert.deepEqual(result.data, [SOLID, SOLID, SOLID, SOLID]);
});

test('every animation frame is lowered, in the order the animation names them', () => {
  const frames = [frame(8, (x) => x < 4), frame(8, (x) => x >= 4), frame(8, () => false)];
  const result = lower(frames, [{ name: 'go', frames: [1, 0], every: 5 }]);
  assert.equal(result.frames, 2);
  assert.equal(result.every, 5);
  assert.deepEqual(result.data, [RIGHT_HALF, LEFT_HALF]);
});

test('more frames than the pool takes are cut, and the cut is reported', () => {
  const frames = Array.from({ length: 10 }, (_, i) => frame(8, (x) => x === i % 8));
  const result = lower(frames, [{ name: 'go', frames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], every: 2 }]);
  assert.equal(result.frames, 8);
  assert.equal(result.data.length, 8);
  assert.ok(result.diagnostics.some((d) => d.severity === 'warning' && /first 8/.test(d.message)));
});

test('a sprite with almost no ink is one glyph, and says so', () => {
  const result = lower([frame(16, (x, y) => x === y && x < 2)]);
  assert.equal(result.kind, 0);
  assert.deepEqual([result.width, result.height, result.frames], [8, 8, 1]);
  assert.equal(result.data.length, 1);
  assert.ok(result.diagnostics.some((d) => /software glyph/.test(d.message)));
});

// --- slots ------------------------------------------------------------------

function slotsOf(ir) {
  const slots = new Map();
  for (const fn of ir.functions) {
    if (!fn.name.startsWith('__8bs_media_bind_')) continue;
    const meta = fn.body[fn.body.length - 1];
    slots.set(fn.name.slice('__8bs_media_bind_'.length), meta.args[0].value);
  }
  return slots;
}

test('sprites in different .8bg files get different slots, so a driver keeps one object each', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-slots-'));
  try {
    const png = encodePng(8, 8, new Uint8Array(8 * 8 * 4).fill(255).map((v, i) => (i % 4 === 3 ? 255 : 0)));
    writeFileSync(join(dir, 'p.png'), png);
    writeFileSync(join(dir, 'one.8bg'), 'sprite a { source "./p.png" size 8x8 }\nsprite b { source "./p.png" size 8x8 }\n');
    writeFileSync(join(dir, 'two.8bg'), 'sprite c { source "./p.png" size 8x8 }\n');
    const program = `import { a, b } from "./one.8bg";
import { c } from "./two.8bg";
import { graphics } from "@8bitscript/graphics";

export function main(): void {
    graphics.place(a, 0, 0);
    graphics.place(b, 8, 0);
    graphics.place(c, 16, 0);
}
`;
    for (const machine of ['vic20', 'c64', 'pet']) {
      const linked = link(program, join(dir, 'main.8bs'), { machine, facts: stockFacts(machine), checkout: CHECKOUT });
      assert.deepEqual(linked.diagnostics.filter((d) => d.severity === 'error'), [], machine);
      const slots = slotsOf(linked.ir);
      assert.deepEqual([...slots.keys()].sort(), ['a', 'b', 'c'], machine);
      assert.equal(new Set(slots.values()).size, 3, `${machine}: ${JSON.stringify([...slots])}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
