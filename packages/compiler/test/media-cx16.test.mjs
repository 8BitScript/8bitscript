// The Commander X16's .8bg lowering (packages/cx16/media/index.cjs), as
// data: what it hands @8bitscript/graphics' index.cx16.8bs byte for byte.
// packages/cx16/test/graphics.test.mjs runs the driver under x16emu on the
// same format; this half needs no emulator, and so runs in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const media = require('../../cx16/media/index.cjs');

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
const MAGENTA = [255, 0, 255];
const ORANGE = [255, 136, 0];

// An RGBA picture from a function of (x, y) returning [r, g, b] or null.
function picture(width, height, paint) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = paint(x, y);
      if (!c) continue;
      rgba.set([c[0], c[1], c[2], 255], (y * width + x) * 4);
    }
  }
  return { rgba, width, height };
}

const lower = (sprite, frames) => media.lowerGraphics(sprite, frames, {}, 'x.8bg', (code, message) => ({ code, message }));

// Nothing in this frame is symmetric, so a flipped axis or a swapped nibble
// cannot pass: white at the top left, magenta at the bottom right, red|blue
// halves between.
const tag = () => picture(16, 16, (x, y) => {
  if (x === 0 && y === 0) return WHITE;
  if (x === 15 && y === 15) return MAGENTA;
  return x < 8 ? RED : BLUE;
});
const tag2 = () => picture(16, 16, (x) => (x < 8 ? GREEN : ORANGE));

// A palette entry back to RGB: VERA's order is GGGGBBBB, then 0000RRRR.
const colorOf = (data, index) => [data[index * 2 + 1] * 17, (data[index * 2] >> 4) * 17, (data[index * 2] & 15) * 17];

test('the lowering hands the driver a palette, then linear 4bpp frames with the left pixel in the high nibble', () => {
  const out = lower({ name: 'tag', animations: [{ frames: [0, 1], every: 4 }] }, [tag(), tag2()]);
  assert.equal(out.kind, 5);
  assert.equal(out.frames, 2);
  assert.equal(out.every, 4);
  assert.equal(out.width, 16);
  assert.equal(out.height, 16);
  assert.equal(out.data.length, 32 + 2 * 128);
  assert.deepEqual(out.data.slice(0, 2), [0, 0], 'entry 0 is transparent');
  const first = out.data[32];
  assert.deepEqual(colorOf(out.data, first >> 4), WHITE, 'the left pixel is the high nibble');
  assert.deepEqual(colorOf(out.data, first & 15), RED);
  const last = out.data[32 + 127];
  assert.deepEqual(colorOf(out.data, last >> 4), BLUE);
  assert.deepEqual(colorOf(out.data, last & 15), MAGENTA);
  assert.deepEqual(colorOf(out.data, out.data[32 + 128] >> 4), GREEN, 'frame 1 starts 128 bytes on, in the same palette');
  assert.ok(out.diagnostics.some((d) => d.code === '8BS2111' && /VERA hardware sprite/.test(d.message)));
});

test('a picture is padded up to the next legal sprite size, and the padding is transparent', () => {
  const out = lower({ name: 'big' }, [picture(20, 12, () => ORANGE)]);
  assert.equal(out.width, 32);
  assert.equal(out.height, 16);
  assert.equal(out.data.length, 32 + (32 * 16) / 2);
  const row = (y) => out.data.slice(32 + y * 16, 32 + (y + 1) * 16);
  assert.deepEqual(row(0).slice(0, 10), new Array(10).fill(0x11), '20 pixels are ten bytes of color 1');
  assert.deepEqual(row(0).slice(10), new Array(6).fill(0));
  assert.deepEqual(row(12), new Array(16).fill(0), 'rows past the picture are padding');
});

test('each side picks its own legal size, and transparent pixels stay index 0', () => {
  const wide = lower({ name: 'bar' }, [picture(32, 8, (x) => (x < 16 ? RED : null))]);
  assert.equal(wide.width, 32);
  assert.equal(wide.height, 8);
  assert.equal(wide.data[32], 0x11);
  assert.equal(wide.data[32 + 8], 0, 'the transparent half is index 0');
  const tiny = lower({ name: 'dot' }, [picture(5, 3, () => RED)]);
  assert.equal(tiny.width, 8);
  assert.equal(tiny.height, 8);
});

test('more than fifteen colours is 8BS2110, and every opaque pixel lands on a kept colour', () => {
  const out = lower({ name: 'wash' }, [picture(8, 8, (x, y) => [x * 32, y * 32, 0])]);
  assert.ok(out.diagnostics.some((d) => d.code === '8BS2110'));
  for (let i = 32; i < out.data.length; i += 1) {
    assert.ok(out.data[i] >> 4 !== 0 && (out.data[i] & 15) !== 0, 'every pixel is opaque, so none may land on index 0');
  }
});

test('frames that do not fit the sprite\'s 4096-byte window are cut and say so', () => {
  const out = lower({ name: 'huge', animations: [{ frames: [0, 0, 0], every: 8 }] }, [picture(64, 64, () => RED)]);
  assert.equal(out.width, 64);
  assert.equal(out.frames, 2);
  assert.ok(out.diagnostics.some((d) => d.code === '8BS2111' && /do not fit/.test(d.message)));
});

test('a picture larger than 64x64 is cut to the biggest sprite and says so', () => {
  const out = lower({ name: 'vast' }, [picture(80, 70, () => RED)]);
  assert.equal(out.width, 64);
  assert.equal(out.height, 64);
  assert.ok(out.diagnostics.some((d) => d.code === '8BS2111' && /at most 64x64/.test(d.message)));
});

test('a sprite with no decodable frame falls back to a one-glyph placeholder', () => {
  const out = lower({ name: 'none' }, []);
  assert.equal(out.kind, 0);
  assert.deepEqual(out.data, [0x2A]);
});
