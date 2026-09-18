// A locale as a build input (config.mjs resolveLocale / localeArg, the
// build's file names): `--locale de` over a release entry's `locale` over
// `targets.<m>.locale` over the project's `locale`; a name that is a
// machine or one of the machine's hardware tags is refused, because a
// file named `x.<word>.8bs` would then mean two things; and no locale at
// all — every project written before there were any — builds and names
// exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { localeArg, localeProblem, resolveI18n, resolveLocale } from '../src/config.mjs';
import { catalogTags, loadCatalog } from '../src/hardware.mjs';
import { build, compile } from '../src/build.mjs';
import { RELEASE_MACHINES } from '@8bitscript/compiler';

// Packages resolve from this checkout, the way hello-bx.test.mjs does.
const REPO = resolve(import.meta.dirname, '..', '..', '..');

function capture(fn) {
  const stdout = [];
  const stderr = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  }).then((result) => ({ result, stdout: stdout.join(''), stderr: stderr.join('') }));
}

test('localeArg reads --locale <name> and refuses a missing name', () => {
  assert.deepEqual(localeArg(['--target', 'pet']), { ok: true, locale: undefined, consumed: [] });
  assert.deepEqual(localeArg(['--target', 'pet', '--locale', 'de']), { ok: true, locale: 'de', consumed: [2, 3] });
  const bare = localeArg(['--locale']);
  assert.equal(bare.ok, false);
  assert.match(bare.error, /--locale expects a name/);
  const flag = localeArg(['--locale', '--size']);
  assert.equal(flag.ok, false, 'the next flag is not the name');
});

test('localeProblem: the shape, a machine\'s name, and a hardware tag are each named as what they are', () => {
  assert.equal(localeProblem('de'), null);
  assert.equal(localeProblem('pt-br'), null);
  assert.match(localeProblem(42), /a name in quotes/);
  assert.match(localeProblem('DE'), /not a locale name/);
  assert.match(localeProblem('pet'), /a machine's name/);
  assert.match(localeProblem('on', ['on', 'off']), /hardware tag/);
  assert.equal(localeProblem('on', ['8032']), null, 'a tag on another machine is not this machine\'s');
});

test('every catalog\'s tags are known, and none of them is a machine — the words a locale is checked against', () => {
  for (const machine of RELEASE_MACHINES) {
    const tags = catalogTags(loadCatalog(machine));
    assert.ok(Array.isArray(tags), machine);
    for (const tag of tags) assert.equal(localeProblem(tag, tags) !== null, true, `${machine}: '${tag}' must be refused as a locale`);
  }
  // The ones a locale could otherwise be spelled as.
  assert.ok(catalogTags(loadCatalog('atari8')).includes('on'));
  assert.ok(catalogTags(loadCatalog('pet')).includes('8032'));
  assert.ok(catalogTags(loadCatalog('vic20')).includes('expanded'));
});

test('resolveLocale: nearest wins — the override, the target\'s, the project\'s — and nothing is the default', () => {
  assert.deepEqual(resolveLocale(null, { target: 'pet' }), { ok: true, locale: undefined });
  assert.deepEqual(resolveLocale({}, { target: 'pet' }), { ok: true, locale: undefined });
  assert.deepEqual(resolveLocale({ locale: 'de' }, { target: 'pet' }), { ok: true, locale: 'de' });
  assert.deepEqual(resolveLocale({ locale: 'de', targets: { pet: { locale: 'fr' }, c64: {} } }, { target: 'pet' }), { ok: true, locale: 'fr' });
  assert.deepEqual(resolveLocale({ locale: 'de', targets: { pet: { locale: 'fr' }, c64: {} } }, { target: 'c64' }), { ok: true, locale: 'de' });
  assert.deepEqual(resolveLocale({ locale: 'de', targets: ['pet'] }, { target: 'pet' }), { ok: true, locale: 'de' }, 'an array of targets has no per-target locale');
  assert.deepEqual(resolveLocale({ locale: 'de', targets: { pet: { locale: 'fr' } } }, { target: 'pet', override: 'es' }), { ok: true, locale: 'es' });
  const bad = resolveLocale({ locale: 'pet' }, { target: 'pet' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /8bitscript\.config\.ts's locale: 'pet' is a machine's name/);
  const badTarget = resolveLocale({ targets: { pet: { locale: 8 } } }, { target: 'pet' });
  assert.match(badTarget.error, /targets\.pet\.locale: a locale is a name in quotes, got 8/);
  const tag = resolveLocale({}, { target: 'atari8', override: 'on', tags: ['on'] });
  assert.match(tag.error, /--locale: 'on' is a hardware tag/);
  assert.deepEqual(resolveLocale({ i18n: { defaultLocale: 'de' } }, { target: 'pet' }), { ok: true, locale: 'de' });
});

const STRINGS = (word) => `export const HELLO: string = "${word}";\n`;
const MAIN = [
  'import { screen } from "@8bitscript/screen";',
  'import { text } from "@8bitscript/text";',
  'import { HELLO } from "./strings.8bs";',
  'export function main(): void {',
  '    screen.blank();',
  '    text.print(0, HELLO);',
  '    if (#locale("de")) { text.print(40, "DE"); } else { text.print(40, "--"); }',
  '    text.releaseCursor();',
  '}',
  '',
].join('\n');

async function project(config) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-locale-'));
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'main.8bs'), MAIN);
  await writeFile(join(dir, 'src', 'strings.8bs'), STRINGS('HELLO WORLD'));
  await writeFile(join(dir, 'src', 'strings.de.8bs'), STRINGS('HALLO WELT'));
  await writeFile(join(dir, '8bitscript.config.ts'), `export default ${JSON.stringify(config)};\n`);
  return dir;
}

const hasText = (bytes, word) => bytes.includes(Buffer.from(word, 'latin1'));

test('--locale de reads strings.de.8bs, folds #locale("de") true, and names the artifact with the locale; without it nothing changes', async () => {
  const dir = await project({ entry: 'src/main.8bs', targets: { pet: {}, web: {} } });
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const plain = await capture(() => build(['--target', 'pet', '--checkout', REPO]));
    assert.equal(plain.result, 0, plain.stdout + plain.stderr);
    assert.match(plain.stdout, /built .*main-pet\.prg/);
    const plainBytes = await readFile(join(dir, 'dist', 'main-pet.prg'));
    assert.equal(hasText(plainBytes, 'HELLO WORLD'), true);
    assert.equal(hasText(plainBytes, 'HALLO WELT'), false);
    assert.equal(hasText(plainBytes, '--'), true);
    assert.equal(hasText(plainBytes, 'DE'), false, '#locale("de") is false with no locale');

    const de = await capture(() => build(['--target', 'pet', '--locale', 'de', '--checkout', REPO]));
    assert.equal(de.result, 0, de.stdout + de.stderr);
    assert.match(de.stdout, /built .*main-pet-de\.prg/);
    const deBytes = await readFile(join(dir, 'dist', 'main-pet-de.prg'));
    assert.equal(hasText(deBytes, 'HALLO WELT'), true);
    assert.equal(hasText(deBytes, 'HELLO WORLD'), false);
    assert.equal(hasText(deBytes, 'DE'), true);
    assert.equal(hasText(deBytes, '--'), false);
    assert.equal(existsSync(join(dir, 'dist', 'main-pet.prg')), true, 'the plain artifact keeps its name beside it');

    const web = await capture(() => build(['--target', 'web', '--locale', 'de', '--checkout', REPO]));
    assert.equal(web.result, 0, web.stdout + web.stderr);
    assert.match(web.stdout, /built .*main-de\.wasm/);
    assert.equal(existsSync(join(dir, 'dist', 'web', 'program-de.wasm')), true, 'a bundle per locale beside the others');
    assert.equal(existsSync(join(dir, 'dist', 'web', 'program-de.json')), true);

    const bad = await capture(() => build(['--target', 'pet', '--locale', 'PET', '--checkout', REPO]));
    assert.equal(bad.result, 1);
    assert.match(bad.stderr, /--locale: 'PET' is not a locale name/);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('the config\'s locale and a release entry\'s locale drive compile() the same way --locale does', async () => {
  const dir = await project({ entry: 'src/main.8bs', locale: 'de', targets: { pet: { release: [{}, { locale: 'de' }] } } });
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const fromConfig = await capture(() => compile('pet', undefined, { checkout: REPO }));
    assert.equal(fromConfig.result.ok, true, fromConfig.stdout + fromConfig.stderr);
    assert.equal(fromConfig.result.locale, 'de');
    assert.ok(fromConfig.result.outFile.endsWith('main-pet-de.prg'), fromConfig.result.outFile);

    const overridden = await capture(() => compile('pet', undefined, { locale: 'fr', checkout: REPO }));
    assert.equal(overridden.result.ok, true, overridden.stdout + overridden.stderr);
    assert.ok(overridden.result.outFile.endsWith('main-pet-fr.prg'), 'a locale with no files still names the build, and reads the plain files');
    const frBytes = await readFile(overridden.result.outFile);
    assert.equal(hasText(frBytes, 'HELLO WORLD'), true);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveI18n: no block and no catalog directory is undefined; a catalog dir defaults to en', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-i18n-cfg-'));
  try {
    assert.deepEqual(resolveI18n(null, { projectDir: dir }), { ok: true, i18n: undefined });
    await mkdir(join(dir, 'src', 'i18n'), { recursive: true });
    await writeFile(join(dir, 'src', 'i18n', 'en.8bs'), 'export namespace Game { const NAME: string = "2048"; }\n');
    await writeFile(join(dir, 'src', 'i18n', 'de.8bs'), 'export namespace Game { const NAME: string = "2048"; }\n');
    const discovered = resolveI18n({}, { projectDir: dir });
    assert.equal(discovered.ok, true);
    assert.equal(discovered.i18n.defaultLocale, 'en');
    assert.deepEqual(discovered.i18n.locales, ['de', 'en']);
    assert.equal(resolveLocale({}, { target: 'pet', projectDir: dir }).locale, 'en');

    const listed = resolveI18n({ i18n: { locales: ['en'] } }, { projectDir: dir });
    assert.equal(listed.ok, false);
    assert.match(listed.error, /de\.8bs is a catalog file that i18n.locales does not list/);

    const missing = resolveI18n({ i18n: { locales: ['en', 'de', 'fr'] } }, { projectDir: dir });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /fr\.8bs is missing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--locale de with src/i18n catalogs folds the German catalog and leaves English out of the image', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-i18n-build-'));
  await mkdir(join(dir, 'src', 'i18n'), { recursive: true });
  await writeFile(join(dir, 'src', 'i18n', 'en.8bs'), [
    'export namespace Game { const NAME: string = "HELLO WORLD"; }',
    'export namespace Prompt { const START: string = "PRESS {control}"; }',
    '',
  ].join('\n'));
  await writeFile(join(dir, 'src', 'i18n', 'de.8bs'), [
    'export namespace Game { const NAME: string = "HALLO WELT"; }',
    'export namespace Prompt { const START: string = "{control} DRUECKEN"; }',
    '',
  ].join('\n'));
  await writeFile(join(dir, 'src', 'main.8bs'), [
    'import { screen } from "@8bitscript/screen";',
    'import { text } from "@8bitscript/text";',
    'import { Game, Prompt } from "@8bitscript/i18n/catalog";',
    'import { i18n } from "@8bitscript/i18n";',
    'import { Input } from "@8bitscript/input";',
    'export function main(): void {',
    '    screen.blank();',
    '    text.print(0, Game.NAME);',
    '    text.print(40, i18n.format(Prompt.START, { control: Input.CONFIRM_LABEL }));',
    '    text.releaseCursor();',
    '}',
    '',
  ].join('\n'));
  await writeFile(join(dir, '8bitscript.config.ts'), `export default ${JSON.stringify({
    entry: 'src/main.8bs',
    targets: { pet: {} },
    i18n: { defaultLocale: 'en', fallbackLocale: 'en', locales: ['en', 'de'] },
  })};\n`);
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const plain = await capture(() => build(['--target', 'pet', '--checkout', REPO]));
    assert.equal(plain.result, 0, plain.stdout + plain.stderr);
    assert.match(plain.stdout, /built .*main-pet\.prg/);
    const plainBytes = await readFile(join(dir, 'dist', 'main-pet.prg'));
    assert.equal(hasText(plainBytes, 'HELLO WORLD'), true);
    assert.equal(hasText(plainBytes, 'HALLO WELT'), false);
    assert.equal(hasText(plainBytes, 'PRESS RETURN'), true);

    const de = await capture(() => build(['--target', 'pet', '--locale', 'de', '--checkout', REPO]));
    assert.equal(de.result, 0, de.stdout + de.stderr);
    const deBytes = await readFile(join(dir, 'dist', 'main-pet-de.prg'));
    assert.equal(hasText(deBytes, 'HALLO WELT'), true);
    assert.equal(hasText(deBytes, 'HELLO WORLD'), false);
    assert.equal(hasText(deBytes, 'RETURN DRUECKEN'), true);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});
