// System-specific files, one level more specific: `geometry.pet.8032.8bs`
// is the PET's 8032-profile version of `geometry.8bs`, taken before the
// machine's own `geometry.pet.8bs` when the build's profile is 8032, and
// ignored for every other profile. The rule is the machine rule with the
// profile's name after the machine's, and it applies to any file in the
// graph — which is how one small geometry file can give a package's
// portable surface a different `text.COLUMNS` per profile without a copy
// of the surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { link } from '../index.mjs';
import { variantOf, isVariantPath } from '../src/resolver/index.mjs';
import { emitC } from '../../backend-6502/src/index.mjs';

const codes = (diagnostics) => diagnostics.map((d) => d.code);

test('variantOf with a profile puts the profile after the machine; isVariantPath recognises both forms and no other', () => {
  assert.equal(variantOf('/p/geometry.8bs', 'pet'), '/p/geometry.pet.8bs');
  assert.equal(variantOf('/p/geometry.8bs', 'pet', '8032'), '/p/geometry.pet.8032.8bs');
  assert.equal(isVariantPath('/p/geometry.pet.8bs'), true);
  assert.equal(isVariantPath('/p/geometry.pet.8032.8bs'), true);
  assert.equal(isVariantPath('/p/geometry.vic20.16k.8bs'), true);
  assert.equal(isVariantPath('/p/geometry.8bs'), false);
  assert.equal(isVariantPath('/p/geometry.data.8bs'), false); // `data` is no machine
  assert.equal(isVariantPath('/p/geometry.pet.8032.extra.8bs'), false); // one word after the machine
});

const GEOMETRY_40 = 'export namespace Video {\n    const COLUMNS: utinyint = 40;\n    const CELL_COUNT: usmallint = 1000;\n}\n';
const GEOMETRY_80 = 'export namespace Video {\n    const COLUMNS: utinyint = 80;\n    const CELL_COUNT: usmallint = 2000;\n}\n';
const LIB = [
  'import { Video } from "./geometry.8bs";',
  'export namespace text {',
  '    const COLUMNS: utinyint = Video.COLUMNS;',
  '    function fill(): void {',
  '        for (let cell: usmallint = 0; cell < Video.CELL_COUNT; cell++) { memory.write(0x8000 + cell, 32); }',
  '    }',
  '}',
].join('\n');
const MAIN = 'import { text } from "./lib.8bs";\nexport function main(): void { text.fill(); memory.write(0x8000, text.COLUMNS); }\n';

test('a build for a machine and profile reads the profile\'s twin; the same machine on another profile, or no profile, reads the plain file', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-profile-variants-'));
  try {
    await writeFile(join(dir, 'geometry.8bs'), GEOMETRY_40);
    await writeFile(join(dir, 'geometry.pet.8032.8bs'), GEOMETRY_80);
    await writeFile(join(dir, 'lib.8bs'), LIB);
    await writeFile(join(dir, 'main.8bs'), MAIN);
    const entry = join(dir, 'main.8bs');
    const columns = (options) => {
      const { ir, diagnostics } = link(MAIN, entry, options);
      assert.deepEqual(diagnostics, [], JSON.stringify(options));
      const c = emitC(ir, { machine: 'pet' });
      return { c, cells: /cell < (\d+)/.exec(c)[1], columns: /32768\)? = (\d+);/.exec(c)[1] };
    };
    assert.deepEqual(columns({ machine: 'pet', profile: '8032' }).cells, '2000');
    assert.deepEqual(columns({ machine: 'pet', profile: '8032' }).columns, '80');
    assert.deepEqual(columns({ machine: 'pet', profile: '3032' }).cells, '1000');
    assert.deepEqual(columns({ machine: 'pet' }).cells, '1000');
    assert.deepEqual(columns({ machine: 'c64', profile: '8032' }).cells, '1000'); // another machine's profile of that name is not this one
    assert.deepEqual(columns({}).cells, '1000');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a machine\'s plain twin serves the profiles that have no twin of their own, and a profile\'s twin wins over it', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-profile-variants-'));
  try {
    await writeFile(join(dir, 'geometry.8bs'), GEOMETRY_40.replace('40', '22'));
    await writeFile(join(dir, 'geometry.pet.8bs'), GEOMETRY_40);
    await writeFile(join(dir, 'geometry.pet.8032.8bs'), GEOMETRY_80);
    await writeFile(join(dir, 'lib.8bs'), LIB);
    await writeFile(join(dir, 'main.8bs'), MAIN);
    const entry = join(dir, 'main.8bs');
    const columnsOf = (options) => /32768\)? = (\d+);/.exec(emitC(link(MAIN, entry, options).ir, { machine: 'pet' }))[1];
    assert.equal(columnsOf({ machine: 'pet', profile: '8032' }), '80');
    assert.equal(columnsOf({ machine: 'pet', profile: '3016' }), '40');
    assert.equal(columnsOf({ machine: 'pet' }), '40');
    assert.equal(columnsOf({ machine: 'vic20', profile: '16k' }), '22');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file that exists only as a profile\'s twin: that profile builds, the machine\'s others are 8BS3002 naming what exists, and no machine means target-dependent', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-profile-variants-'));
  try {
    await writeFile(join(dir, 'geometry.pet.8032.8bs'), GEOMETRY_80);
    await writeFile(join(dir, 'geometry.c64.8bs'), GEOMETRY_40);
    await writeFile(join(dir, 'lib.8bs'), LIB);
    await writeFile(join(dir, 'main.8bs'), MAIN);
    const entry = join(dir, 'main.8bs');
    assert.deepEqual(codes(link(MAIN, entry, { machine: 'pet', profile: '8032' }).diagnostics), []);
    assert.deepEqual(codes(link(MAIN, entry, { machine: 'c64', profile: 'stock' }).diagnostics), []);
    const other = link(MAIN, entry, { machine: 'pet', profile: '3032' });
    assert.deepEqual(codes(other.diagnostics), ['8BS3002']);
    assert.match(other.diagnostics[0].message, /no version for the pet target's 3032 hardware \(targets: c64, pet \(8032\)\)/);
    const bare = link(MAIN, entry, { machine: 'pet' });
    assert.deepEqual(codes(bare.diagnostics), ['8BS3002']);
    assert.match(bare.diagnostics[0].message, /no version for the pet target \(targets/);
    // No machine at all: the resolver answers "valid, and target-dependent",
    // and linking without a machine reports that as it always has (8BS3001).
    const unknown = link(MAIN, entry, {});
    assert.deepEqual(codes(unknown.diagnostics), ['8BS3001']);
    assert.match(unknown.diagnostics[0].message, /target-specific; linking it needs a machine target/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an import that names a profile\'s twin outright gets exactly that file, on every machine and profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-profile-variants-'));
  try {
    await writeFile(join(dir, 'geometry.pet.8032.8bs'), GEOMETRY_80);
    await writeFile(join(dir, 'lib.8bs'), LIB.replace('./geometry.8bs', './geometry.pet.8032.8bs'));
    await writeFile(join(dir, 'main.8bs'), MAIN);
    const entry = join(dir, 'main.8bs');
    for (const options of [{ machine: 'pet', profile: '3032' }, { machine: 'c64' }, {}]) {
      const { ir, diagnostics } = link(MAIN, entry, options);
      assert.deepEqual(diagnostics, [], JSON.stringify(options));
      assert.match(emitC(ir, { machine: 'pet' }), /cell < 2000/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- tags: a build carries several, and each may have a twin ---------------

test('a build with several hardware tags reads the one tag\'s twin that exists; two twins at once is 8BS3004', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-profile-variants-'));
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, MAIN);
    await writeFile(join(dir, 'lib.8bs'), LIB);
    await writeFile(join(dir, 'geometry.8bs'), GEOMETRY_40);
    await writeFile(join(dir, 'geometry.pet.8032.8bs'), GEOMETRY_80);
    const columnsOf = (options) => /32768\)? = (\d+);/.exec(emitC(link(MAIN, entry, options).ir, { machine: 'pet' }))[1];
    // Only one of the build's tags has a twin: that twin is the file.
    assert.equal(columnsOf({ machine: 'pet', tags: ['8032', 'sidcart'] }), '80');
    assert.equal(columnsOf({ machine: 'pet', tags: ['sidcart', '8032'] }), '80');
    // None of them does: the plain file.
    assert.equal(columnsOf({ machine: 'pet', tags: ['sidcart'] }), '40');
    assert.equal(columnsOf({ machine: 'pet', tags: [] }), '40');
    // `profile` is the older spelling of one tag.
    assert.equal(columnsOf({ machine: 'pet', profile: '8032' }), '80');

    // Two tags, two twins: the resolver will not pick between them.
    await writeFile(join(dir, 'geometry.pet.sidcart.8bs'), GEOMETRY_40);
    const { diagnostics } = link(MAIN, entry, { machine: 'pet', tags: ['8032', 'sidcart'] });
    assert.deepEqual(codes(diagnostics), ['8BS3004']);
    assert.match(diagnostics[0].message, /'8032' and 'sidcart'/);
    // Either tag alone is unambiguous.
    assert.equal(columnsOf({ machine: 'pet', tags: ['8032'] }), '80');
    assert.equal(columnsOf({ machine: 'pet', tags: ['sidcart'] }), '40');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
