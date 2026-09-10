// @8bitscript/pet across its profiles: one surface (screen.8bs, text.8bs),
// one geometry file with an 8032 version beside it, and the build's
// profile deciding which the surface reads. The real package, through the
// real pnpm-linked node_modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PET_SRC = join(HERE, '..', '..', 'pet', 'src');
const CONSUMER = 'import { screen } from "@8bitscript/screen";\nexport function main(): void { screen.blank(); }';
const ENTRY = join(HERE, '..', '..', 'studio', 'src', 'main.8bs');

// Per-profile facts, not just the stock sheet: text.8bs's own
// asciiToScreenCode reads #fact(video.characterSetSwapped), which the
// 2001 sets and every other profile leaves at the catalog default, so a
// link() has needed real, profile-resolved facts (not none) since that
// fact was added — the same way any other #fact() read already did.
const petFacts = (profile) => {
  const resolved = resolveHardware(loadCatalog('pet'), { profile });
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  return resolved.hardware.facts;
};

const linked = (profile) => {
  const { ir, diagnostics } = link(CONSUMER, ENTRY, { machine: 'pet', profile, facts: petFacts(profile) });
  assert.deepEqual(diagnostics, [], profile);
  const blank = ir.functions.find((f) => f.name === 'screen_blank');
  const loop = blank.body.find((s) => s.kind === 'for');
  return loop.test.right.value;
};

test('the 40-column profiles blank 1000 cells; the 8032 blanks 2000; no profile is the 40-column default', () => {
  assert.equal(linked('3032'), 1000);
  assert.equal(linked('3008'), 1000);
  assert.equal(linked('4032'), 1000);
  assert.equal(linked(undefined), 1000);
  assert.equal(linked('8032'), 2000);
});

test('text.COLUMNS and text.CELL_COUNT are the geometry\'s, per profile', () => {
  const src = [
    'import { text } from "@8bitscript/text";',
    'export function main(): void { memory.write(0x8000, text.COLUMNS); memory.write(0x8001 + text.CELL_COUNT, 1); }',
  ].join('\n');
  const entry = join(HERE, 'fixtures', 'pet-columns.8bs'); // does not need to exist: only its directory resolves packages
  const folded = (profile) => {
    const { ir, diagnostics } = link(src, entry, { machine: 'pet', profile, facts: petFacts(profile) });
    assert.deepEqual(diagnostics, [], profile);
    const [columns, cells] = ir.functions.find((f) => f.name === 'main').body;
    return { columns: columns.value.value, cells: cells.address.right.value };
  };
  assert.deepEqual(folded('3032'), { columns: 40, cells: 1000 });
  assert.deepEqual(folded('8032'), { columns: 80, cells: 2000 });
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
