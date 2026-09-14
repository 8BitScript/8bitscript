// @8bitscript/cx16/text — locate() must widen before multiplying, and
// reverse video must keep the paper colour on a second write. `--screenshot`
// cannot press keys or inspect VRAM, so this file locks the source shape
// the IR test in packages/compiler/test/cx16-screen.test.mjs also reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'src', 'text.8bs'), 'utf8');

test('locate widens high and row before the 8-bit-wrapping multiplies', () => {
  assert.match(SOURCE, /let highWide: usmallint = high/);
  assert.match(SOURCE, /highWide \* 28/);
  assert.match(SOURCE, /let rowWide: usmallint = row/);
  assert.match(SOURCE, /rowWide \* 76/);
  assert.match(SOURCE, /rowWide \* 256/);
  assert.doesNotMatch(SOURCE, /let x: usmallint = high \* 28/);
  assert.doesNotMatch(SOURCE, /cell - row \* 76/);
});

test('reverse video is fill colour with a black glyph, and does not take paper from DATA1', () => {
  assert.match(SOURCE, /return currentColor \* 16;/);
  assert.doesNotMatch(SOURCE, /paper == currentColor/);
  assert.doesNotMatch(SOURCE, /let paper: utinyint = attr \/ 16/);
});
