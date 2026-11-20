// The 64 KiB check on the web page's sprite region (web-layout.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agreementFor, spriteRegionProblem } from '../src/web-layout.mjs';

// The pool that makes the region end exactly at `end`, for 128 sprites.
const poolFor = (end) => end - agreementFor({ sprites: { count: 128, poolBytes: 0 } }).reservedEnd;

test('a layout with sprites off has no sprite problem', () => {
  assert.equal(spriteRegionProblem(agreementFor({})), null);
});

test('a sprite region ending exactly at 65536 is fine', () => {
  const layout = agreementFor({ sprites: { count: 128, poolBytes: poolFor(0x10000) } });
  assert.equal(layout.reservedEnd, 0x10000);
  assert.equal(spriteRegionProblem(layout), null);
});

test('a sprite region ending at 65537 is refused with its size', () => {
  const poolBytes = poolFor(0x10001);
  const layout = agreementFor({ sprites: { count: 128, poolBytes } });
  assert.equal(layout.reservedEnd, 0x10001);
  assert.equal(
    spriteRegionProblem(layout),
    `the sprite region needs ${0x10001 - layout.spriteTable} bytes (128 sprites, ${poolBytes} bytes pool) and runs to 65537, past 64 KiB; this build asks for more sprites or sprite memory than fit beside the page`,
  );
});
