// @8bitscript/i18n: one import, one file per locale, chosen by the
// resolver's locale twin rule and never by the program. Checked three
// ways — the bare import resolves to the locale's file when the build
// names one and to the plain file otherwise, for a locale that has a
// twin and one that does not; the probe links clean on all nine machines
// with and without a locale; and on the web target ./number is built and
// run, its cells read back and compared with the strings a person would
// write, in English and in German.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link, resolveSpecifier } from '../../compiler/index.mjs';
import { build } from '../../compiler/src/wasm/index.ts';
import { build as buildMos } from '../../compiler/src/mos/index.ts';
import { loadCatalog, resolveHardware, stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');
const CHECKOUT = resolve(ROOT, '..', '..');

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];
const LOCALES = readdirSync(SRC)
  .map((name) => /^index\.([a-z]{2,8}(?:-[a-z]{2,8})?)\.8bs$/.exec(name)?.[1])
  .filter(Boolean)
  .sort();

const PROBE = join(HERE, 'locale-probe.8bs');
const consumer = join(CHECKOUT, 'packages', 'examples', 'hello-world', 'src', 'hello-world.8bs');

test('the package exports ./number, ./messages and ./catalog, and depends on @8bitscript/text alone', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg['8bitscript'].entry, './src/index.8bs');
  assert.equal(pkg['8bitscript'].exports['./number'], './src/number.8bs');
  assert.equal(pkg['8bitscript'].exports['./messages'], './src/messages.8bs');
  assert.equal(pkg['8bitscript'].exports['./catalog'], './src/catalog.8bs');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@8bitscript/text']);
});

test('the locales shipped are the ones documented, each a twin of index.8bs with the same two names', () => {
  assert.deepEqual(LOCALES, ['de', 'fr', 'it', 'nl', 'pt-br']);
  const names = (file) => [...readFileSync(join(SRC, file), 'utf8').matchAll(/const (\w+):/g)].map((m) => m[1]).sort();
  const plain = names('index.8bs');
  assert.deepEqual(plain, ['DECIMAL', 'GROUP']);
  for (const locale of LOCALES) {
    assert.deepEqual(names(`index.${locale}.8bs`), plain, locale);
  }
});

test('the bare import resolves to the plain file with no locale, and on every machine', () => {
  for (const machine of [undefined, ...TARGETS]) {
    const resolved = resolveSpecifier('@8bitscript/i18n', consumer, { machine, checkout: CHECKOUT });
    assert.ok(resolved && !resolved.code, `${machine}: ${resolved?.message ?? 'unresolved'}`);
    assert.equal(resolved.path, join(SRC, 'index.8bs'), machine);
  }
});

for (const locale of LOCALES) {
  test(`--locale ${locale} takes index.${locale}.8bs, on every machine`, () => {
    for (const machine of TARGETS) {
      const resolved = resolveSpecifier('@8bitscript/i18n', consumer, { machine, checkout: CHECKOUT, locale });
      assert.ok(resolved && !resolved.code, `${machine}: ${resolved?.message ?? 'unresolved'}`);
      assert.equal(resolved.path, join(SRC, `index.${locale}.8bs`), machine);
    }
  });
}

test('@8bitscript/i18n/catalog is a compiler-owned specifier, not the stub file', () => {
  const resolved = resolveSpecifier('@8bitscript/i18n/catalog', consumer, { checkout: CHECKOUT });
  assert.equal(resolved?.code, '8BS1043');
  assert.match(resolved.message, /needs a message catalog/);
});

test('a locale with no file here reads the plain one', () => {
  const resolved = resolveSpecifier('@8bitscript/i18n', consumer, { machine: 'c64', checkout: CHECKOUT, locale: 'sv' });
  assert.ok(resolved && !resolved.code, resolved?.message);
  assert.equal(resolved.path, join(SRC, 'index.8bs'));
});

for (const target of TARGETS) {
  for (const locale of [undefined, 'de']) {
    test(`the probe links clean for ${target}${locale ? ` in ${locale}` : ''}, with number.print in the IR`, () => {
      const source = readFileSync(PROBE, 'utf8');
      const { ir, diagnostics } = link(source, PROBE, { machine: target, facts: stockFacts(target), locale });
      assert.deepEqual(diagnostics, []);
      assert.equal(ir.entry, 'main');
      const names = new Set(ir.functions.map((f) => f.name));
      assert.ok(names.has('number_print'), 'number.print() is linked');
    });
  }
}

// ---- the 6502 -------------------------------------------------------------
//
// The link tests above cannot see zero page: a frame that does not fit
// is the backend's refusal, not the linker's. So the PET and the
// unexpanded VIC-20 — the smallest budgets — are built for real.
async function mosBuild(file, machine, locale) {
  const hardware = resolveHardware(loadCatalog(machine), {});
  assert.ok(hardware.ok, hardware.ok ? '' : hardware.error);
  const entry = join(HERE, file);
  const { ir, diagnostics } = link(readFileSync(entry, 'utf8'), entry, { machine, facts: stockFacts(machine), locale });
  assert.deepEqual(diagnostics, []);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-i18n-mos-'));
  try {
    const result = await buildMos(ir, { machine, hardware: hardware.hardware, outFile: join(scratch, 'out.prg'), frameRate: 60, report: true });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    return { bytes: Buffer.from(result.bytes), memory: result.memory };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

for (const machine of ['pet', 'vic20']) {
  test(`on the ${machine}, Locale.GROUP builds byte-identical to the literal it folds to`, async () => {
    const fact = await mosBuild('size-fact.8bs', machine);
    const literal = await mosBuild('size-literal.8bs', machine);
    assert.ok(fact.bytes.equals(literal.bytes), 'the two images differ');
  });

  test(`on the ${machine}, number.print's frame fits the machine's zero page and the image builds, in English and in German`, async () => {
    for (const locale of [undefined, 'de']) {
      const { bytes } = await mosBuild('size-number.8bs', machine, locale);
      assert.ok(bytes.length > 0);
    }
  });
}

// The web host's text buffer: Video.CHAR_BASE in @8bitscript/web's
// geometry.8bs is 4 for the default host, one byte per cell.
const CHAR_BASE = 4;

async function runOnWeb(locale) {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-i18n-number-'));
  try {
    const entry = join(HERE, 'number-values-main.8bs');
    const { ir, diagnostics } = link(readFileSync(entry, 'utf8'), entry, { machine: 'web', facts: stockFacts('web'), locale });
    assert.deepEqual(diagnostics, []);
    const result = await build(ir, { outFile: join(scratch, 'number.wasm'), frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    const { instance } = await WebAssembly.instantiate(result.bytes, {});
    instance.exports.main();
    const memory = new Uint8Array(instance.exports.memory.buffer);
    const cells = (cell, count) => String.fromCharCode(...memory.subarray(CHAR_BASE + cell, CHAR_BASE + cell + count));
    return cells;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test('built and run for the web with no locale, number.print groups with a comma', async () => {
  const cells = await runOnWeb(undefined);
  assert.equal(cells(0, 6), '     0');
  assert.equal(cells(8, 6), '     7');
  assert.equal(cells(16, 6), '    42');
  assert.equal(cells(24, 6), '   999');
  assert.equal(cells(32, 6), ' 1,000');
  assert.equal(cells(40, 6), '12,345');
  assert.equal(cells(48, 6), '65,535');
  assert.equal(cells(56, 8), '   1,234');
  assert.equal(cells(64, 5), '1,234');
});

test('built and run for the web as a German build, the same program groups with a point', async () => {
  const cells = await runOnWeb('de');
  assert.equal(cells(32, 6), ' 1.000');
  assert.equal(cells(40, 6), '12.345');
  assert.equal(cells(48, 6), '65.535');
  assert.equal(cells(24, 6), '   999');
});
