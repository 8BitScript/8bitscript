import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

test('every twin exports audio.bind, meta, play, music, and update', () => {
  for (const name of ['index.8bs', 'index.c64.8bs', 'index.nes.8bs', 'index.pet.8bs', 'index.atari8.8bs']) {
    const src = readFileSync(join(SRC, name), 'utf8');
    assert.match(src, /fn bind\(/, name);
    assert.match(src, /fn meta\(/, name);
    assert.match(src, /fn play\(/, name);
    assert.match(src, /fn music\(/, name);
    assert.match(src, /fn update\(/, name);
  }
});
