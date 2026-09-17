// A locale is the innermost twin dimension: `strings.de.8bs` is the German
// `strings.8bs`, `strings.pet.de.8bs` the German version of the PET's twin,
// `strings.pet.8032.de.8bs` of the 8032's. The rule refines the machine
// rule and never changes it — whichever level a build would take without
// a locale, it takes that level's `.<locale>` file when one exists — and a
// build that names no locale reads no locale's file at all, so every
// project that never heard of locales builds exactly as it did. `#locale
// ("de")` folds to whether this is the `de` build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze, link, LOCALE_NAME, isLocaleName } from '../index.mjs';
import { resolveSpecifier, variantOf, isVariantPath } from '../src/resolver/index.mjs';

const codes = (diagnostics) => diagnostics.map((d) => d.code);

test('a locale name is two to eight lower-case letters with an optional -region, and never a machine', () => {
  for (const ok of ['de', 'en', 'fr', 'pt-br', 'zh-hans', 'eng', 'abcdefgh']) assert.equal(isLocaleName(ok), true, ok);
  for (const no of ['DE', 'd', 'pt_BR', 'pt-BR', '8032', 'on2', 'de-', 'abcdefghi', '', 'pet', 'nes', 'web', 'c64', null, 42]) {
    assert.equal(isLocaleName(no), false, String(no));
  }
  assert.equal(LOCALE_NAME.test('on'), true, 'an Atari hardware tag has the shape — the CLI refuses it against the catalog, not the shape');
});

test('variantOf puts the locale last, after the machine and the tag, and keeps the source kind', () => {
  assert.equal(variantOf('/p/strings.8bs', undefined, undefined, 'de'), '/p/strings.de.8bs');
  assert.equal(variantOf('/p/strings.8bs', 'pet', undefined, 'de'), '/p/strings.pet.de.8bs');
  assert.equal(variantOf('/p/strings.8bs', 'pet', '8032', 'de'), '/p/strings.pet.8032.de.8bs');
  assert.equal(variantOf('/p/Strings.8bx', 'pet', undefined, 'de'), '/p/Strings.pet.de.8bx');
  assert.equal(variantOf('/p/strings.8bs', 'pet', '8032'), '/p/strings.pet.8032.8bs', 'the three-argument form is unchanged');
});

test('isVariantPath knows a locale\'s file only when handed the locale; without one, x.de.8bs is an ordinary module', () => {
  assert.equal(isVariantPath('/p/strings.de.8bs', 'de'), true);
  assert.equal(isVariantPath('/p/strings.pet.de.8bs', 'de'), true);
  assert.equal(isVariantPath('/p/strings.pet.8032.de.8bs', 'de'), true);
  assert.equal(isVariantPath('/p/strings.de.8bs'), false);
  assert.equal(isVariantPath('/p/strings.de.8bs', 'fr'), false);
  assert.equal(isVariantPath('/p/strings.pet.8bs', 'de'), true, 'a machine twin is still explicit');
  assert.equal(isVariantPath('/p/strings.8bs', 'de'), false);
});

// Every file exports one const the entry prints; which file was read is
// which value main() ends up storing.
const strings = (value) => `export const WHICH: utinyint = ${value};\n`;
const MAIN = 'import { WHICH } from "./strings.8bs";\nexport function main(): void { memory.write(0x8000, WHICH); }\n';
const whichOf = (ir) => ir.functions.find((f) => f.name === 'main').body[0].value.value;

async function project(files) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-locale-variants-'));
  for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), value === true ? MAIN : strings(value));
  await writeFile(join(dir, 'main.8bs'), MAIN);
  return dir;
}

function which(dir, options) {
  const { ir, diagnostics } = link(MAIN, join(dir, 'main.8bs'), options);
  const errors = diagnostics.filter((d) => d.severity !== 'warning');
  assert.deepEqual(errors, [], JSON.stringify(options));
  return { which: whichOf(ir), warnings: diagnostics.filter((d) => d.severity === 'warning') };
}

test('a locale-only twin: read by that locale\'s build on every machine, and by no build without the locale', async () => {
  const dir = await project({ 'strings.8bs': 1, 'strings.de.8bs': 2 });
  try {
    assert.equal(which(dir, { machine: 'pet', locale: 'de' }).which, 2);
    assert.equal(which(dir, { machine: 'c64', locale: 'de' }).which, 2);
    assert.equal(which(dir, { machine: 'pet', profile: '8032', locale: 'de' }).which, 2, 'a tag with no twin of its own changes nothing');
    assert.equal(which(dir, { machine: 'pet' }).which, 1, 'no locale: the plain file, the locale\'s never consulted');
    assert.equal(which(dir, { machine: 'pet', locale: 'fr' }).which, 1, 'another locale: the plain file');
    assert.equal(which(dir, {}).which, 1, 'a check without a machine reads the plain file');
    assert.equal(which(dir, { locale: 'de' }).which, 2, 'a check with a locale but no machine reads the locale\'s');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('machine, tag and locale compose: most specific first, and the machine level is chosen before the locale refines it', async () => {
  const dir = await project({
    'strings.8bs': 1, 'strings.de.8bs': 2,
    'strings.pet.8bs': 3, 'strings.pet.de.8bs': 4,
    'strings.pet.8032.8bs': 5, 'strings.pet.8032.de.8bs': 6,
  });
  try {
    assert.equal(which(dir, { machine: 'pet', profile: '8032', locale: 'de' }).which, 6);
    assert.equal(which(dir, { machine: 'pet', profile: '8032' }).which, 5);
    assert.equal(which(dir, { machine: 'pet', locale: 'de' }).which, 4);
    assert.equal(which(dir, { machine: 'pet', profile: '3032', locale: 'de' }).which, 4, 'a tag without a twin falls to the machine level, then the locale');
    assert.equal(which(dir, { machine: 'pet' }).which, 3);
    assert.equal(which(dir, { machine: 'c64', locale: 'de' }).which, 2);
    assert.equal(which(dir, { machine: 'c64' }).which, 1);
    assert.equal(which(dir, { machine: 'pet', locale: 'fr' }).which, 3, 'a locale with no files anywhere: as if none was given');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a tag level exists when only its locale file does; a machine level likewise', async () => {
  const dir = await project({ 'strings.8bs': 1, 'strings.pet.8032.de.8bs': 6, 'strings.c64.de.8bs': 7 });
  try {
    assert.equal(which(dir, { machine: 'pet', profile: '8032', locale: 'de' }).which, 6);
    assert.equal(which(dir, { machine: 'pet', profile: '8032' }).which, 1, 'without the locale, the 8032 has no file of its own');
    assert.equal(which(dir, { machine: 'c64', locale: 'de' }).which, 7);
    assert.equal(which(dir, { machine: 'c64' }).which, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a machine twin with no version in the locale is used — and said (8BS3005) when the plain file has one', async () => {
  const dir = await project({ 'strings.8bs': 1, 'strings.de.8bs': 2, 'strings.pet.8bs': 3 });
  try {
    const pet = which(dir, { machine: 'pet', locale: 'de' });
    assert.equal(pet.which, 3, 'the machine\'s file, not the locale\'s: the right machine beats the right language');
    assert.deepEqual(codes(pet.warnings), ['8BS3005']);
    assert.match(pet.warnings[0].message, /strings\.pet\.8bs is used, not strings\.de\.8bs; add strings\.pet\.de\.8bs/);
    assert.equal(pet.warnings[0].severity, 'warning');
    const quiet = which(dir, { machine: 'pet' });
    assert.deepEqual(quiet.warnings, [], 'no locale, nothing to say');
    const c64 = which(dir, { machine: 'c64', locale: 'de' });
    assert.equal(c64.which, 2);
    assert.deepEqual(c64.warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no warning when the plain file has no locale version either: nothing was passed over', async () => {
  const dir = await project({ 'strings.8bs': 1, 'strings.pet.8bs': 3 });
  try {
    const pet = which(dir, { machine: 'pet', locale: 'de' });
    assert.equal(pet.which, 3);
    assert.deepEqual(pet.warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an explicit import of the locale\'s file is taken literally, and .8bx twins follow the same rule', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-locale-variants-'));
  try {
    await writeFile(join(dir, 'strings.8bs'), strings(1));
    await writeFile(join(dir, 'strings.de.8bs'), strings(2));
    const explicit = resolveSpecifier('./strings.de.8bs', join(dir, 'main.8bs'), { machine: 'pet', locale: 'de' });
    assert.equal(explicit.path, join(dir, 'strings.de.8bs'));
    const plain = resolveSpecifier('./strings.8bs', join(dir, 'main.8bs'), { machine: 'pet', locale: 'de' });
    assert.equal(plain.path, join(dir, 'strings.de.8bs'));

    await writeFile(join(dir, 'Hello.8bx'), 'export component Hello() { memory.write(0x8000, 1); }\n');
    await writeFile(join(dir, 'Hello.de.8bx'), 'export component Hello() { memory.write(0x8000, 2); }\n');
    await writeFile(join(dir, 'Hello.pet.de.8bx'), 'export component Hello() { memory.write(0x8000, 3); }\n');
    const bx = resolveSpecifier('./Hello.8bx', join(dir, 'main.8bs'), { machine: 'c64', locale: 'de' });
    assert.equal(bx.path, join(dir, 'Hello.de.8bx'), 'an .8bx locale twin is an .8bx');
    const bxPet = resolveSpecifier('./Hello.8bx', join(dir, 'main.8bs'), { machine: 'pet', locale: 'de' });
    assert.equal(bxPet.path, join(dir, 'Hello.pet.de.8bx'));
    const bxNone = resolveSpecifier('./Hello.8bx', join(dir, 'main.8bs'), { machine: 'pet' });
    assert.equal(bxNone.path, join(dir, 'Hello.8bx'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file that exists only per locale: a build without one is told which locales there are', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-locale-variants-'));
  try {
    await writeFile(join(dir, 'strings.de.8bs'), strings(2));
    await writeFile(join(dir, 'strings.fr.8bs'), strings(3));
    const none = resolveSpecifier('./strings.8bs', join(dir, 'main.8bs'), { machine: 'pet' });
    assert.equal(none.code, '8BS3002');
    assert.match(none.message, /no version for the pet target \(targets: locale de, locale fr\)/);
    const other = resolveSpecifier('./strings.8bs', join(dir, 'main.8bs'), { machine: 'pet', locale: 'es' });
    assert.match(other.message, /in locale es/);
    const check = resolveSpecifier('./strings.8bs', join(dir, 'main.8bs'), {});
    assert.equal(check.path, null, 'valid, and target-dependent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the old ambiguity rule still counts a tag that has only a locale file', async () => {
  const dir = await project({ 'strings.8bs': 1, 'strings.vic20.3k.8bs': 2, 'strings.vic20.expanded.de.8bs': 3 });
  try {
    const { diagnostics } = link(MAIN, join(dir, 'main.8bs'), { machine: 'vic20', tags: ['3k', 'expanded'], locale: 'de' });
    assert.deepEqual(codes(diagnostics), ['8BS3004']);
    const one = link(MAIN, join(dir, 'main.8bs'), { machine: 'vic20', tags: ['3k', 'expanded'] });
    assert.deepEqual(codes(one.diagnostics), [], 'without the locale only 3k has a file');
    assert.equal(whichOf(one.ir), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- #locale("de") -------------------------------------------------------

const BRANCH = 'let v: utinyint = 0;\nexport function main(): void {\n    if (#locale("de")) { v = 1; } else { v = 2; }\n    memory.write(0x8000, v);\n}\n';
// The `if` reaches the linked IR with its test already a literal — the
// backends drop the dead arm — so what the fold decided is that literal.
const branchTest = (ir) => ir.functions.find((f) => f.name === 'main').body[0].test;

test('#locale("de") folds to true in the de build, false in every other and in a build with no locale', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-locale-fold-'));
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, BRANCH);
    const build = (options) => {
      const { ir, diagnostics } = link(BRANCH, entry, options);
      assert.deepEqual(diagnostics, [], JSON.stringify(options));
      const test = branchTest(ir);
      assert.equal(test.kind, 'const', JSON.stringify(options));
      assert.equal(test.type, 'bool', 'a locale folds to a boolean, as a flag fact does');
      return test.value;
    };
    assert.equal(build({ machine: 'pet', locale: 'de' }), 1);
    assert.equal(build({ machine: 'pet', locale: 'fr' }), 0);
    assert.equal(build({ machine: 'pet' }), 0, 'no locale is any other locale, as far as "de" is concerned');
    assert.equal(build({}), 0, 'a check without a build reads it as false, valid and target-dependent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('#locale(...) refuses by name anything but one locale name in quotes', () => {
  const diag = (text, options = {}) => analyze(text, '/p/main.8bs', options);
  const wrap = (call) => `export function main(): void { if (${call}) { memory.write(0x8000, 1); } }\n`;
  assert.deepEqual(codes(diag(wrap('#locale("de")'))), []);
  assert.deepEqual(codes(diag(wrap('#locale()'))), ['8BS1040']);
  assert.match(diag(wrap('#locale()'))[0].message, /one locale name in quotes/);
  assert.deepEqual(codes(diag(wrap('#locale("de", "fr")'))), ['8BS1040']);
  assert.deepEqual(codes(diag(wrap('#locale(de)'))), ['8BS1040'], 'a bare word is not a name in quotes');
  assert.deepEqual(codes(diag(wrap('#locale("DE")'))), ['8BS1040']);
  assert.match(diag(wrap('#locale("DE")'))[0].message, /not a locale name/);
  assert.deepEqual(codes(diag(wrap('#locale("pet")'))), ['8BS1040'], 'a machine is not a locale');
  const bare = diag('export function main(): void { let x: bool = #locale; }\n');
  assert.deepEqual(codes(bare), ['8BS1030']);
  assert.match(bare[0].message, /#locale\("de"\)/, 'the bare form names how to call it');
  assert.equal(diag(wrap('#locale("de")'), { machine: 'pet', locale: 'de' }).length, 0);
});
