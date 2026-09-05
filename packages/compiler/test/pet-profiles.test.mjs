// @8bitscript/pet across its profiles: one surface (screen.8bs, text.8bs),
// one geometry file with an 8032 version beside it, and the build's
// profile deciding which the surface reads. The real package, through the
// real pnpm-linked node_modules, the way the borders example resolves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { emitC } from '../../backend-6502/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BORDERS_MAIN = join(HERE, '..', '..', '..', 'examples', 'proof-of-concept', 'borders', 'src', 'main.8bs');
const PET_SRC = join(HERE, '..', '..', 'pet', 'src');

const linked = (profile) => {
  const src = readFileSync(BORDERS_MAIN, 'utf8');
  const { ir, diagnostics } = link(src, BORDERS_MAIN, { machine: 'pet', profile });
  assert.deepEqual(diagnostics, [], profile);
  return emitC(ir, { machine: 'pet' });
};

test('the 40-column profiles blank 1000 cells; the 8032 blanks 2000; no profile is the 40-column default', () => {
  assert.match(linked('3032'), /cell < 1000/);
  assert.match(linked('3008'), /cell < 1000/);
  assert.match(linked('4032'), /cell < 1000/);
  assert.match(linked(undefined), /cell < 1000/);
  const wide = linked('8032');
  assert.match(wide, /cell < 2000/);
  assert.doesNotMatch(wide, /cell < 1000/);
});

test('text.COLUMNS and text.CELL_COUNT are the geometry\'s, per profile', () => {
  const src = [
    'import { text } from "@8bitscript/text";',
    'export function main(): void { memory.write(0x8000, text.COLUMNS); memory.write(0x8001 + text.CELL_COUNT, 1); }',
  ].join('\n');
  const entry = join(HERE, 'fixtures', 'pet-columns.8bs'); // does not need to exist: only its directory resolves packages
  const emitted = (profile) => {
    const { ir, diagnostics } = link(src, entry, { machine: 'pet', profile });
    assert.deepEqual(diagnostics, [], profile);
    return emitC(ir, { machine: 'pet' });
  };
  assert.match(emitted('3032'), /32768\)? = 40;/);
  assert.match(emitted('3032'), /\(32769 \+ 1000\)/);
  assert.match(emitted('8032'), /32768\)? = 80;/);
  assert.match(emitted('8032'), /\(32769 \+ 2000\)/);
});

test('the geometry files agree with themselves: COLUMNS * ROWS is CELL_COUNT, and the 8032 is the only 80-column one', () => {
  for (const [file, columns] of [['geometry.8bs', 40], ['geometry.pet.8032.8bs', 80]]) {
    const text = readFileSync(join(PET_SRC, file), 'utf8');
    const value = (name) => Number(new RegExp(`const ${name}: \\w+ = (\\d+);`).exec(text)[1]);
    assert.equal(value('COLUMNS'), columns, file);
    assert.equal(value('ROWS'), 25, file);
    assert.equal(value('CELL_COUNT'), columns * 25, file);
  }
});
