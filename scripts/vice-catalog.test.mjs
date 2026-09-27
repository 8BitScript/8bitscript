// The VICE catalog generator, held to VICE's own awkward help text.
//
// No VICE is spawned: the parsers are pure, and the fixtures below are
// copied verbatim from `x64sc -help` (VICE 3.10). The checked-in
// `scripts/vice/x64sc.json` is read for shape only, so the suite passes on
// a machine that has never had an emulator installed — the same bar
// packages/cli/test/emulator-smoke.test.mjs holds itself to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHelp, parseResources, parseValues, parseVersion } from './vice-catalog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('a value list with labels is read as values and labels', () => {
  assert.deepEqual(
    parseValues('Set CIA 1 model (0 = old 6526, 1 = new 8521)'),
    { 0: 'old 6526', 1: 'new 8521' },
  );
});

test('VICE writes a pair with a colon or an equals sign, and both are read', () => {
  assert.deepEqual(
    parseValues('Specify SID engine and model (256: ReSID 6581, 257: ReSID 8580)'),
    { 256: 'ReSID 6581', 257: 'ReSID 8580' },
  );
});

test('a missing comma in VICE\'s own text does not swallow the next value', () => {
  // Verbatim from `x64sc -help`: there is no comma after `japanese`, so
  // splitting on commas reads `1: rev. 1` as part of the Japanese label and
  // loses revision 1 entirely. All seven have to come back.
  const values = parseValues(
    'Patch the Kernal ROM to the specified <revision> '
    + '(0/jap: japanese 1: rev. 1, 2: rev. 2, 3: rev. 3, 39/gs: C64 GS, 67/sx: sx64, 100/4064: 4064)',
  );
  assert.deepEqual(Object.keys(values), ['0', '1', '2', '3', '39', '67', '100']);
  assert.equal(values[1], 'rev. 1');
  assert.equal(values[2], 'rev. 2');
});

test('a key written as aliases keeps the first and records the rest', () => {
  const values = parseValues('(0/jap: japanese, 39/gs: C64 GS)');
  assert.equal(values[0], 'japanese (also jap)');
  assert.equal(values[39], 'C64 GS (also gs)');
});

test('a bare list with no labels is values with the labels left null', () => {
  assert.deepEqual(
    parseValues('Set VIC-II model (6569/6569r1/8565/6567/8562/6567r56a/6572)'),
    {
      6569: null, '6569r1': null, 8565: null, 6567: null, 8562: null, '6567r56a': null, 6572: null,
    },
  );
});

test('an aside in brackets is not a value list', () => {
  assert.equal(parseValues('Enable the REU (a RAM expansion)'), null);
  assert.equal(parseValues('Set something with no bracket at all'), null);
});

test('an option, its argument and its documentation are one entry', () => {
  const help = parseHelp('-drive8type <Type>\n\tSet drive type (1541: CBM 1541)\n');
  const entry = help.get('drive8type');
  assert.equal(entry.arg, '<Type>');
  assert.match(entry.doc, /^Set drive type/);
});

test('a switch VICE spells both ways is one setting, described by its `-` form', () => {
  const help = parseHelp('-reu\n\tEnable the REU\n+reu\n\tDisable the REU\n');
  assert.equal(help.size, 1);
  const entry = help.get('reu');
  assert.deepEqual([...entry.signs].sort(), ['+', '-']);
  assert.equal(entry.doc, 'Enable the REU', 'the `-` spelling carries the real description');
  assert.equal(entry.arg, null);
});

test('resources come back with their defaults and without the quotes', () => {
  const resources = parseResources('[C64SC]\nSidModel=1\nKernalName="kernal-901227-03.bin"\n');
  assert.equal(resources.get('SidModel'), '1');
  assert.equal(resources.get('KernalName'), 'kernal-901227-03.bin');
  assert.equal(resources.size, 2, 'the section header is not a resource');
});

test('the version comes from the boot banner', () => {
  assert.equal(parseVersion('*** VICE Version 3.10 ***'), '3.10');
  assert.equal(parseVersion('no banner here'), null);
});

// The generated file is checked in so the menu can be read without VICE.
// Regenerate with `node scripts/vice-catalog.mjs`.
test('the checked-in x64sc catalog has the shape the generator promises', (t) => {
  const path = join(HERE, 'vice', 'x64sc.json');
  if (!existsSync(path)) {
    t.skip('scripts/vice/x64sc.json not generated yet');
    return;
  }
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(catalog.binary, 'x64sc');
  assert.match(catalog.viceVersion, /^\d+\.\d+/);
  assert.ok(catalog.counts.total > 500, 'x64sc has hundreds of options');

  for (const [name, option] of Object.entries(catalog.options)) {
    assert.ok(['toggle', 'enum', 'range', 'value'].includes(option.kind), `${name}: kind`);
    assert.equal(option.flag, `-${name}`, `${name}: flag`);
    // A default is only ever a value VICE printed, never one made up: no
    // resource means no default.
    if (!option.resource) assert.equal(option.default, null, `${name}: default without a resource`);
    if (option.kind === 'enum') assert.ok(Object.keys(option.values).length > 1, `${name}: values`);
    if (option.kind === 'toggle') assert.equal(option.off, `+${name}`, `${name}: off`);
  }
});

/** Every `["-flag", "value", ...]` a machine's catalog hands one emulator. */
function catalogFlags(machine, emulator) {
  const pkg = JSON.parse(
    readFileSync(join(HERE, '..', 'packages', machine, 'package.json'), 'utf8'),
  );
  const calls = [];
  const hardware = pkg['8bitscript']?.hardware ?? {};
  for (const [option, { values = {} }] of Object.entries(hardware.options ?? {})) {
    for (const [value, entry] of Object.entries(values)) {
      const args = entry.run?.[emulator];
      if (Array.isArray(args)) calls.push({ option, value, args });
    }
  }
  return calls;
}

// The point of the whole exercise: a flag written into a catalog by hand is
// checked against the VICE that is actually installed, rather than against
// whoever last remembered it. Read from packages/c64/package.json, not
// copied here — a list kept in a test is the same drift one step removed.
test('every x64sc flag the C64 catalog writes is one VICE still has', (t) => {
  const path = join(HERE, 'vice', 'x64sc.json');
  if (!existsSync(path)) {
    t.skip('scripts/vice/x64sc.json not generated yet');
    return;
  }
  const { options } = JSON.parse(readFileSync(path, 'utf8'));
  const calls = catalogFlags('c64', 'x64sc');
  assert.ok(calls.length > 0, 'the C64 catalog fits hardware with x64sc flags');

  for (const { option, value, args } of calls) {
    for (let i = 0; i < args.length; i += 1) {
      if (!args[i].startsWith('-')) continue;
      const flag = args[i].slice(1);
      const known = options[flag];
      assert.ok(known, `c64 ${option}=${value} passes -${flag}, which x64sc no longer has`);
      // Where VICE enumerates the legal values, the one the catalog passes
      // has to be among them: `-sidmodel 0` is the 6581, and a VICE that
      // renumbered them would otherwise fit the wrong chip in silence.
      const next = args[i + 1];
      if (known.kind === 'enum' && next && !next.startsWith('-')) {
        assert.ok(
          Object.hasOwn(known.values, next),
          `c64 ${option}=${value} passes -${flag} ${next}, not one of `
          + `${Object.keys(known.values).join('/')}`,
        );
      }
    }
  }
});

// Two defaults worth stating out loud, because both differ from what the
// C64's catalog calls stock: a catalog that wants a plain 1541 or a 6581
// has to pass the flag rather than rely on VICE leaving it alone.
test('VICE\'s own stock C64 is a 1541-II with an 8580, not a 1541 with a 6581', (t) => {
  const path = join(HERE, 'vice', 'x64sc.json');
  if (!existsSync(path)) {
    t.skip('scripts/vice/x64sc.json not generated yet');
    return;
  }
  const { options } = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(options.drive8type.default, '1542');
  assert.equal(options.sidmodel.default, '1');
});
