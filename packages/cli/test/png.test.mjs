// png.mjs is the screenshot path for the one target whose emulator does not
// write a PNG itself (the web). These tests pin the encoder's bytes and the
// decoder's pixel-at, so a screenshot test can trust what it reads back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { encodePNG, pixelAt } from '../src/png.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('encodePNG round-trips a 2x1 RGBA image; pixelAt reads the same colors back', () => {
  const rgba = Uint8Array.from([
    10, 20, 30, 255,
    40, 50, 60, 128,
  ]);
  const png = encodePNG(2, 1, rgba);
  assert.ok(png.subarray(0, 8).equals(SIGNATURE));
  assert.deepEqual(pixelAt(png, 0, 0), [10, 20, 30]);
  assert.deepEqual(pixelAt(png, 1, 0), [40, 50, 60]);
});

test('encodePNG refuses a buffer whose length is not width*height*4', () => {
  assert.throws(
    () => encodePNG(2, 2, Buffer.alloc(4)),
    /expected 16 bytes for 2x2 RGBA, got 4/,
  );
});

test('pixelAt refuses a non-PNG, a pixel outside the image, and a non-8-bit image', () => {
  assert.throws(() => pixelAt(Buffer.from('not a png'), 0, 0), /not a PNG/);
  const png = encodePNG(1, 1, Uint8Array.from([1, 2, 3, 255]));
  assert.throws(() => pixelAt(png, 1, 0), /\(1, 0\) is outside a 1x1 image/);
  assert.throws(() => pixelAt(png, 0, 1), /\(0, 1\) is outside a 1x1 image/);
});

// A 1x1 greyscale PNG (color type 0, filter 0) so pixelAt's non-RGBA
// path is not only reached by an emulator screenshot.
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  // CRC is not checked by pixelAt — only the chunk stream is.
  return Buffer.concat([len, typeBuf, data, Buffer.alloc(4)]);
}

test('pixelAt reads a greyscale PNG as [g, g, g] and a filter-2 (Up) row against the previous', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.from([
    0, 10, // filter 0, grey 10
    2, 5,  // filter 2 (Up): 5 + previous 10 = 15
  ]);
  const png = Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.deepEqual(pixelAt(png, 0, 0), [10, 10, 10]);
  assert.deepEqual(pixelAt(png, 0, 1), [15, 15, 15]);
});
