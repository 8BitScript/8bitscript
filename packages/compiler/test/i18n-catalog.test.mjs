// Message catalogs: `src/i18n/<locale>.8bs` imported as
// `@8bitscript/i18n/catalog`, schema/placeholder parity, fallback merge,
// `i18n.format` fold, and Latin transliteration into the portable set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  Codes, formatMessage, getHoverInfo, link, placeholdersOf, prepareCatalog, transliterate,
} from '../index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const CHECKOUT = resolve(import.meta.dirname, '..', '..', '..');

const EN = [
  'export namespace Game {',
  '    const NAME: string = "2048";',
  '    const SCORE: string = "SCORE";',
  '}',
  'export namespace Prompt {',
  '    const START: string = "PRESS {control}";',
  '}',
  '',
].join('\n');

const DE = [
  'export namespace Game {',
  '    const NAME: string = "2048";',
  '    const SCORE: string = "PUNKTE";',
  '}',
  'export namespace Prompt {',
  '    const START: string = "{control} DRÜCKEN";',
  '}',
  '',
].join('\n');

function catalogOptions(dir, extras = {}) {
  return {
    catalogDir: join(dir, 'src', 'i18n'),
    defaultLocale: 'en',
    fallbackLocale: 'en',
    locales: ['en', 'de'],
    charset: 'transliterate',
    ...extras,
  };
}

async function catalogProject(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-catalog-'));
  await mkdir(join(dir, 'src', 'i18n'), { recursive: true });
  await writeFile(join(dir, 'src', 'i18n', 'en.8bs'), files.en ?? EN);
  await writeFile(join(dir, 'src', 'i18n', 'de.8bs'), files.de ?? DE);
  return dir;
}

test('placeholdersOf lists unique {name}s in source order', () => {
  assert.deepEqual(placeholdersOf('PRESS {control}'), ['control']);
  assert.deepEqual(placeholdersOf('{control} OR {other}'), ['control', 'other']);
  assert.deepEqual(placeholdersOf('{control} and {control}'), ['control']);
  assert.deepEqual(placeholdersOf('no slots'), []);
});

test('formatMessage substitutes every {name} and refuses extras or gaps', () => {
  assert.deepEqual(formatMessage('PRESS {control}', { control: 'RETURN' }), { ok: true, text: 'PRESS RETURN' });
  assert.equal(formatMessage('PRESS {control}', {}).ok, false);
  assert.equal(formatMessage('PRESS {control}', { control: 'RETURN', extra: 'x' }).ok, false);
});

test('transliterate maps Latin extras; Ü is two portable columns', () => {
  const mapped = transliterate('DRÜCKEN');
  assert.deepEqual(mapped.unmapped, []);
  assert.equal(mapped.text, 'DRUECKEN');
  assert.equal(mapped.text.length, 8);
  const sharp = transliterate('GROSS ß');
  assert.equal(sharp.text, 'GROSS SS');
  const bad = transliterate('café');
  assert.ok(bad.unmapped.includes('é'));
});

test('prepareCatalog transliterates the selected locale and fills missing keys from the fallback', async () => {
  const dir = await catalogProject({
    de: [
      'export namespace Game {',
      '    const SCORE: string = "PUNKTE";',
      '}',
      'export namespace Prompt {',
      '    const START: string = "{control} DRÜCKEN";',
      '}',
      '',
    ].join('\n'),
  });
  try {
    const prepared = prepareCatalog({ locale: 'de', i18n: catalogOptions(dir) });
    assert.equal(prepared.ok, true, prepared.diagnostics.map((d) => d.message).join('\n'));
    assert.match(prepared.text, /const NAME: string = "2048"/);
    assert.match(prepared.text, /const SCORE: string = "PUNKTE"/);
    assert.match(prepared.text, /const START: string = "\{control\} DRUECKEN"/);
    assert.doesNotMatch(prepared.text, /Ü/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('prepareCatalog reports extra keys and placeholder mismatches', async () => {
  const dir = await catalogProject({
    de: [
      'export namespace Game {',
      '    const NAME: string = "2048";',
      '    const SCORE: string = "PUNKTE";',
      '    const EXTRA: string = "NEIN";',
      '}',
      'export namespace Prompt {',
      '    const START: string = "{name} DRUECKEN";',
      '}',
      '',
    ].join('\n'),
  });
  try {
    const prepared = prepareCatalog({ locale: 'de', i18n: catalogOptions(dir) });
    assert.equal(prepared.ok, false);
    const codes = prepared.diagnostics.map((d) => d.code);
    assert.ok(codes.includes(Codes.CATALOG_SCHEMA), codes.join(','));
    assert.ok(codes.includes(Codes.CATALOG_PLACEHOLDER), codes.join(','));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('charset: strict refuses a non-portable catalog character', async () => {
  const dir = await catalogProject();
  try {
    const prepared = prepareCatalog({
      locale: 'de',
      i18n: catalogOptions(dir, { charset: 'strict' }),
    });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.diagnostics[0].code, Codes.UNPORTABLE_CHARACTER);
    assert.match(prepared.diagnostics[0].message, /Ü/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('link folds i18n.format and .length; --locale de picks the German catalog', async () => {
  const dir = await catalogProject();
  const main = [
    'import { Game, Prompt } from "@8bitscript/i18n/catalog";',
    'import { i18n } from "@8bitscript/i18n";',
    'import { Input } from "@8bitscript/input";',
    'export function main(): void {',
    '    memory.write(0x8000, i18n.format(Prompt.START, { control: Input.CONFIRM_LABEL }).length);',
    '    memory.write(0x8001, Game.SCORE.length);',
    '}',
    '',
  ].join('\n');
  await writeFile(join(dir, 'main.8bs'), main);
  try {
    const i18n = catalogOptions(dir);
    const de = link(main, join(dir, 'main.8bs'), {
      machine: 'pet', facts: stockFacts('pet'), locale: 'de', checkout: CHECKOUT, i18n,
    });
    assert.deepEqual(de.diagnostics, []);
    const texts = (de.ir.strings ?? []).map((s) => s.text);
    assert.ok(texts.includes('RETURN DRUECKEN'), texts.join(' | '));
    assert.ok(texts.includes('PUNKTE'), texts.join(' | '));
    const write = de.ir.functions.find((f) => f.name === 'main').body[0];
    assert.equal(write.value.kind, 'const');
    assert.equal(write.value.value, 'RETURN DRUECKEN'.length);

    const en = link(main, join(dir, 'main.8bs'), {
      machine: 'pet', facts: stockFacts('pet'), locale: 'en', checkout: CHECKOUT, i18n,
    });
    assert.deepEqual(en.diagnostics, []);
    const enTexts = (en.ir.strings ?? []).map((s) => s.text);
    assert.ok(enTexts.includes('PRESS RETURN'), enTexts.join(' | '));
    assert.ok(!enTexts.includes('DRUECKEN'), 'the other locale is not in the image');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hover on i18n.format names the compile-time interpolation', () => {
  const consumer = join(CHECKOUT, 'packages', 'examples', 'hello-world', 'src', 'hello-world.8bs');
  const text = 'import { i18n } from "@8bitscript/i18n";\ni18n.format("HI");\n';
  const info = getHoverInfo(text, text.indexOf('format') + 3, { path: consumer, checkout: CHECKOUT });
  assert.ok(info);
  assert.match(info.markdown, /i18n\.format\(template: string\): void/);
  assert.match(info.markdown, /Folded at every/);
});

test('a project without catalogs still links; @8bitscript/i18n/catalog is 8BS1043', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-no-catalog-'));
  const main = [
    'import { Game } from "@8bitscript/i18n/catalog";',
    'export function main(): void { memory.write(0x8000, Game.NAME.length); }',
    '',
  ].join('\n');
  await writeFile(join(dir, 'main.8bs'), main);
  try {
    const { diagnostics } = link(main, join(dir, 'main.8bs'), {
      machine: 'pet', facts: stockFacts('pet'), checkout: CHECKOUT,
    });
    assert.ok(diagnostics.some((d) => d.code === Codes.CATALOG));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
