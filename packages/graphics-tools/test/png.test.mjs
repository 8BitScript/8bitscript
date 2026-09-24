import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodePng, encodePng, sliceFrames, quantize, contentHash, brightness, bitmask } from '../src/index.mjs';

test('encode then decode round-trips RGBA', () => {
  const width = 2;
  const height = 2;
  const rgba = Uint8Array.from([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    0, 0, 0, 0,
  ]);
  const png = encodePng(width, height, rgba);
  const decoded = decodePng(png);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.rgba], [...rgba]);
});

test('sliceFrames walks left-to-right then down', () => {
  const rgba = new Uint8Array(8 * 4 * 4);
  for (let i = 0; i < 8; i += 1) rgba[i * 4] = i + 1;
  const frames = sliceFrames(rgba, 8, 4, 4, 4);
  assert.equal(frames.length, 2);
  assert.equal(frames[0][0], 1);
  assert.equal(frames[1][0], 5);
});

test('quantize collapses extra colours and keeps transparency', () => {
  const rgba = Uint8Array.from([
    255, 0, 0, 255,
    250, 0, 0, 255,
    0, 0, 255, 255,
    0, 0, 0, 0,
  ]);
  const { indices, palette, colors } = quantize(rgba, 2);
  assert.equal(palette.length, 2);
  assert.equal(colors, 2);
  assert.equal(indices[3], 255);
  assert.equal(contentHash(indices).length, 16);
});

test('brightness averages opaque pixels and bitmask downsamples ink', () => {
  const rgba = Uint8Array.from([
    255, 255, 255, 255,
    0, 0, 0, 255,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  assert.equal(brightness(rgba), 128);
  assert.equal(brightness(new Uint8Array(8)), 0);
  const { indices } = quantize(rgba, 2);
  const bits = bitmask(indices, 2, 2, 2, 1);
  assert.equal(bits.length, 1);
  assert.ok(bits[0] !== 0);
});
