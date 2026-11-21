// The hit check is one block of source, the same in every graphics twin, so every machine gives the
// same answer; and each twin feeds it: place() records the position and marks the sprite placed,
// hide() and meta() mark it not placed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'graphics', 'src');
const TWINS = readdirSync(SRC).filter((f) => /^index(\..+)?\.8bs$/.test(f)).sort();

const block = (text) => /^ {4}\/\/ ---- hit ----\n[\s\S]*?\n {4}\/\/ ---- end hit ----$/m.exec(text)?.[0];
const body = (text, name) => new RegExp(`^ {4}fn ${name}\\([^\\n]*\\{\\n([\\s\\S]*?)\\n {4}\\}$`, 'm').exec(text)?.[1];

test('all eight twins are listed', () => {
  assert.equal(TWINS.length, 8, TWINS.join(', '));
});

test('the hit block is byte for byte the same in every twin', () => {
  const first = block(readFileSync(join(SRC, TWINS[0]), 'utf8'));
  assert.ok(first, TWINS[0]);
  for (const file of TWINS.slice(1)) assert.equal(block(readFileSync(join(SRC, file), 'utf8')), first, file);
});

test('place() records the position and marks the sprite placed; hide() and meta() unmark it', () => {
  for (const file of TWINS) {
    const text = readFileSync(join(SRC, file), 'utf8');
    const place = body(text, 'place');
    assert.match(place, /^ {8}if slot >= SLOTS \{\n {12}return;\n {8}\}\n {8}hitX\[slot\] = x;\n {8}hitY\[slot\] = y;\n {8}hitOn\[slot\] = 1;\n/, `${file}: place`);
    for (const name of ['hide', 'meta']) {
      assert.match(body(text, name), /^ {8}if slot >= SLOTS \{\n {12}return;\n {8}\}\n {8}hitOn\[slot\] = 0;\n/, `${file}: ${name}`);
    }
  }
});
