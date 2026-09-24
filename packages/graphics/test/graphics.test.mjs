import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

test('every twin exports graphics.bind, meta, place, and update', () => {
  for (const name of ['index.8bs', 'index.c64.8bs', 'index.nes.8bs', 'index.pet.8bs']) {
    const src = readFileSync(join(SRC, name), 'utf8');
    assert.match(src, /function bind\(/, name);
    assert.match(src, /function meta\(/, name);
    assert.match(src, /function place\(/, name);
    assert.match(src, /function update\(/, name);
  }
});
