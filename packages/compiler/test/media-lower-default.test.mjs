// The default graphics lowering (packages/compiler/src/media/lower-default.mjs):
// what every machine without its own media module gets. A picture becomes one
// glyph per animation step, up to DEFAULT_MAX_STEPS of them — the number
// packages/graphics/src/index.8bs holds — and the diagnostic says what was
// kept and what was dropped. graphics-contract.test.mjs checks the two agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lowerGraphicsDefault, DEFAULT_MAX_STEPS, KIND_GLYPH } from '../src/media/lower-default.mjs';

const SIZE = 16;
const solid = { width: SIZE, height: SIZE, rgba: new Uint8Array(SIZE * SIZE * 4).fill(255) };
const clear = { width: SIZE, height: SIZE, rgba: new Uint8Array(SIZE * SIZE * 4) };

const sprite = (animations) => ({ name: 'p', width: SIZE, height: SIZE, animations, start: 0, length: 1 });

test('a still picture is one glyph and the diagnostic names no steps', () => {
  const result = lowerGraphicsDefault(sprite([]), [solid], 't.8bg');
  assert.equal(result.kind, KIND_GLYPH);
  assert.equal(result.frames, 1);
  assert.deepEqual(result.data, [0xA0]);
  assert.equal(result.every, 8);
  const [note] = result.diagnostics;
  assert.match(note.message, /software glyph on this target$/);
});

test('an animation keeps one glyph per step, in the order the animation lists them', () => {
  const result = lowerGraphicsDefault(sprite([{ frames: [1, 0, 1], every: 3 }]), [solid, clear], 't.8bg');
  assert.equal(result.frames, 3);
  assert.deepEqual(result.data, [0x2A, 0xA0, 0x2A], 'frame 1 is clear (asterisk), frame 0 is solid (reverse space)');
  assert.equal(result.every, 3);
  assert.match(result.diagnostics[0].message, /3 animation steps kept/);
});

test('steps past the glyph path\'s limit are dropped, and the diagnostic says so', () => {
  const steps = Array.from({ length: DEFAULT_MAX_STEPS + 2 }, (_, i) => i % 2);
  const result = lowerGraphicsDefault(sprite([{ frames: steps, every: 2 }]), [solid, clear], 't.8bg');
  assert.equal(result.frames, DEFAULT_MAX_STEPS);
  assert.equal(result.data.length, DEFAULT_MAX_STEPS);
  assert.match(result.diagnostics[0].message, new RegExp(`steps past ${DEFAULT_MAX_STEPS} dropped`));
});

test('a step that names a frame the file does not have falls back to the first frame, and a file with none to an asterisk', () => {
  const missing = lowerGraphicsDefault(sprite([{ frames: [0, 5], every: 1 }]), [solid], 't.8bg');
  assert.deepEqual(missing.data, [0xA0, 0xA0]);
  const none = lowerGraphicsDefault(sprite([]), [], 't.8bg');
  assert.deepEqual(none.data, [0x2A]);
});
