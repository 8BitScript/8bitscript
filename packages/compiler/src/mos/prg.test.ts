import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prgBytes } from './prg.ts';

test('prgBytes: the load address, little-endian, then the body — nothing else', () => {
  const bytes = prgBytes(0x0401, new Uint8Array([0x60]));
  assert.deepEqual([...bytes], [0x01, 0x04, 0x60]);
});

test('prgBytes: an empty body is just the two-byte load address', () => {
  const bytes = prgBytes(0x1001, new Uint8Array(0));
  assert.deepEqual([...bytes], [0x01, 0x10]);
});
