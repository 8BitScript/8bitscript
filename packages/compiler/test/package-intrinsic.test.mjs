// `#package("version")` is the program's own package.json's field, as a
// string literal: the nearest package.json above the file the call is in,
// read at compile time, so a title screen prints the version the package
// was published as and nobody has to remember a const. Once folded it is
// the literal the program would have written — same bytes, same checks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../index.mjs';
import { build } from '../src/mos/index.ts';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';
import { nearestPackage, PACKAGE_FIELDS } from '../src/fold/package.mjs';
import { linkFiles } from './support/link-files.mjs';

const codes = (diagnostics) => diagnostics.map((d) => d.code);
// @8bitscript/* resolves through this checkout, as the CLI's --checkout does.
const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PKG = JSON.stringify({ name: 'title-screen', version: '3.4.5', private: true });

const petHardware = () => {
  const resolved = resolveHardware(loadCatalog('pet'), {});
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  return resolved.hardware;
};

/** Link `files` from `entry` and build the PET image; the bytes of the program. */
async function petBytes(files, entry) {
  const { ir, diagnostics } = linkFiles(files, entry, { checkout: CHECKOUT, facts: petHardware().facts });
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [], entry);
  const dir = mkdtempSync(join(tmpdir(), '8bs-package-'));
  try {
    const result = await build(ir, { machine: 'pet', hardware: petHardware(), outFile: join(dir, 'out.prg'), frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    return [...result.bytes];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The strings a linked program carries, in table order. */
function stringsOf(files, entry) {
  const { ir, diagnostics } = linkFiles(files, entry, { checkout: CHECKOUT, facts: petHardware().facts });
  return { strings: ir?.strings ?? [], diagnostics };
}

const PRINT = (version, name) => `import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
const VERSION: string = ${version};
export function main(): void {
    screen.blank();
    text.print(0, VERSION);
    text.print(40, ${name});
    text.releaseCursor();
}
`;

test('#package("version") and #package("name") are the nearest package.json\'s fields, as string literals', () => {
  const { strings, diagnostics } = stringsOf({
    'package.json': PKG,
    'main.8bs': PRINT('#package("version")', '#package("name")'),
  }, 'main.8bs');
  assert.deepEqual(diagnostics, []);
  const texts = strings.map((s) => s.text);
  assert.ok(texts.includes('3.4.5'), JSON.stringify(texts));
  assert.ok(texts.includes('title-screen'), JSON.stringify(texts));
});

test('a #package() build is byte-identical to the literal written by hand — it costs nothing', async () => {
  const folded = await petBytes({ 'package.json': PKG, 'main.8bs': PRINT('#package("version")', '#package("name")') }, 'main.8bs');
  const hand = await petBytes({ 'package.json': PKG, 'main.8bs': PRINT('"3.4.5"', '"title-screen"') }, 'main.8bs');
  assert.deepEqual(folded, hand);
});

test('the nearest package.json wins: a module inside a nested package reads its own', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-package-nearest-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'outer', version: '1.0.0' }));
    mkdirSync(join(dir, 'inner', 'src'), { recursive: true });
    writeFileSync(join(dir, 'inner', 'package.json'), JSON.stringify({ name: 'inner', version: '2.0.0' }));
    const outer = nearestPackage(join(dir, 'src-less'));
    const inner = nearestPackage(join(dir, 'inner', 'src'));
    assert.equal(outer.json.version, '1.0.0');
    assert.equal(inner.json.version, '2.0.0');
    assert.equal(inner.path, join(dir, 'inner', 'package.json'));
    const diagnostics = analyze('const V: string = #package("version");\nexport function main(): void { memory.write(0x8000, 1); }\n', join(dir, 'inner', 'src', 'main.8bs'));
    assert.deepEqual(diagnostics, [], 'analyze() resolves from the file, as a build does');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#package(...) refuses by name anything but one of the readable fields in quotes', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-package-fields-'));
  try {
    writeFileSync(join(dir, 'package.json'), PKG);
    const file = join(dir, 'main.8bs');
    const diag = (call) => analyze(`const V: string = ${call};\nexport function main(): void { memory.write(0x8000, 1); }\n`, file);
    assert.deepEqual(PACKAGE_FIELDS, ['name', 'version']);
    assert.deepEqual(codes(diag('#package("version")')), []);
    assert.deepEqual(codes(diag('#package("name")')), []);
    assert.deepEqual(codes(diag('#package()')), ['8BS1041']);
    assert.match(diag('#package()')[0].message, /one field name in quotes/);
    assert.deepEqual(codes(diag('#package("version", "name")')), ['8BS1041']);
    assert.deepEqual(codes(diag('#package(version)')), ['8BS1041'], 'a bare word is not a name in quotes');
    assert.deepEqual(codes(diag('#package("description")')), ['8BS1041']);
    assert.match(diag('#package("description")')[0].message, /"name", "version"/, 'the message lists the fields');
    assert.deepEqual(codes(diag('#package("private")')), ['8BS1041'], 'a field that is there but not readable is still refused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no package.json above the file, one that does not parse, or one without the field is 8BS1042 naming it', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-package-missing-'));
  try {
    const program = 'const V: string = #package("version");\nexport function main(): void { memory.write(0x8000, 1); }\n';
    const file = join(dir, 'main.8bs');
    const none = analyze(program, file);
    assert.deepEqual(codes(none), ['8BS1042']);
    assert.match(none[0].message, /no package\.json above/);
    writeFileSync(join(dir, 'package.json'), '{ not json');
    const broken = analyze(program, file);
    assert.deepEqual(codes(broken), ['8BS1042']);
    assert.match(broken[0].message, /package\.json is not valid JSON/);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'unversioned' }));
    const missing = analyze(program, file);
    assert.deepEqual(codes(missing), ['8BS1042']);
    assert.match(missing[0].message, /has no "version"/);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'v', version: 3 }));
    assert.deepEqual(codes(analyze(program, file)), ['8BS1042'], 'a version that is not a string is not a string literal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('text handed to analyze() with no file has no package: the placeholder, and no diagnostic', () => {
  const diagnostics = analyze('const V: string = #package("version");\nexport function main(): void { memory.write(0x8000, 1); }\n');
  assert.deepEqual(diagnostics, []);
});

test('the folded literal is checked like any other: a name outside the portable character set is refused where it is printed', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-package-charset-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/thing', version: '1.0.0' }));
    const diagnostics = analyze('const N: string = #package("name");\nexport function main(): void { memory.write(0x8000, 1); }\n', join(dir, 'main.8bs'));
    assert.deepEqual(codes(diagnostics), ['8BS1026']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
