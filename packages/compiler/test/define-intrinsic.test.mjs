// `#define("NAME", default)` is a value the build is handed: the default is
// in the source, so a plain build, `8bs check` and the editor never lack
// one; `--define NAME=VALUE` (or a program's `define` block) replaces it for
// one build. Once folded it *is* the literal — the same bytes as writing the
// number — so a program that reads no defines costs nothing and one that
// reads them costs only what the literal would.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, DEFINE_NAME, defineKind } from '../index.mjs';
import { build } from '../src/mos/index.ts';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';
import { linkFiles } from './support/link-files.mjs';

const codes = (diagnostics) => diagnostics.map((d) => d.code);
const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const petHardware = () => {
  const resolved = resolveHardware(loadCatalog('pet'), {});
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  return resolved.hardware;
};

/** A program that prints a number made from a define and writes a flag. */
const program = (seed, flag = 'false') => `import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
const SEED: utinyint = ${seed};
const BONUS: bool = ${flag};
export function main(): void {
    screen.blank();
    text.printNumber(0, SEED, 3);
    if (BONUS) {
        text.print(40, "BONUS");
    }
    text.releaseCursor();
}
`;

const DEFINED = program('#define("SEED", 10)', '#define("FORCE_BONUS", false)');

function linkWith(files, entry, options = {}) {
  return linkFiles(files, entry, { checkout: CHECKOUT, facts: petHardware().facts, ...options });
}

async function petBytes(source, options = {}) {
  const { ir, diagnostics } = linkWith({ 'main.8bs': source }, 'main.8bs', options);
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [], source);
  const dir = mkdtempSync(join(tmpdir(), '8bs-define-'));
  try {
    const result = await build(ir, { machine: 'pet', hardware: petHardware(), outFile: join(dir, 'out.prg'), frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    return [...result.bytes];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a define with nothing handed in is its default, and the build is the build of the literal', async () => {
  const folded = await petBytes(DEFINED);
  const hand = await petBytes(program('10', 'false'));
  assert.deepEqual(folded, hand);
});

test('a value handed in replaces the default: a different value is a different build', async () => {
  const handed = await petBytes(DEFINED, { defines: { SEED: 42, FORCE_BONUS: true } });
  const hand = await petBytes(program('42', 'true'));
  assert.deepEqual(handed, hand);
  assert.notDeepEqual(handed, await petBytes(DEFINED));
});

test('a string define folds to a string literal', () => {
  const source = `import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
const THEME: string = #define("THEME", "classic");
export function main(): void {
    screen.blank();
    text.print(0, THEME);
    text.releaseCursor();
}
`;
  const plain = linkWith({ 'main.8bs': source }, 'main.8bs');
  assert.deepEqual(plain.diagnostics, []);
  assert.ok(plain.ir.strings.map((s) => s.text).includes('classic'));
  const handed = linkWith({ 'main.8bs': source }, 'main.8bs', { defines: { THEME: 'cosmic' } });
  assert.deepEqual(handed.diagnostics, []);
  assert.ok(handed.ir.strings.map((s) => s.text).includes('cosmic'));
  assert.ok(!handed.ir.strings.map((s) => s.text).includes('classic'));
});

test('link() reports each name the program reads once, with its kind and source default', () => {
  const { defineSites, diagnostics } = linkWith({ 'main.8bs': DEFINED }, 'main.8bs');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(defineSites.map(({ name, kind, default: value }) => ({ name, kind, value })), [
    { name: 'SEED', kind: 'int', value: 10 },
    { name: 'FORCE_BONUS', kind: 'bool', value: false },
  ]);
  assert.ok(defineSites.every((site) => typeof site.file === 'string' && Number.isInteger(site.start)));
});

test('a program that reads no define reports none and is untouched by --define values', async () => {
  const plain = program('10', 'false');
  const linked = linkWith({ 'main.8bs': plain }, 'main.8bs', { defines: { SEED: 99 } });
  assert.deepEqual(linked.defineSites, []);
  assert.deepEqual(await petBytes(plain, { defines: { SEED: 99 } }), await petBytes(plain));
});

test('the same name in two modules is one define; two defaults for it is 8BS1049', () => {
  const lib = (value) => `export const SHARED: utinyint = #define("SEED", ${value});\n`;
  const main = (value) => `import { SHARED } from "./lib.8bs";
import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
const LOCAL: utinyint = #define("SEED", ${value});
export function main(): void {
    screen.blank();
    text.printNumber(0, LOCAL + SHARED, 3);
    text.releaseCursor();
}
`;
  const same = linkWith({ 'lib.8bs': lib(10), 'main.8bs': main(10) }, 'main.8bs');
  assert.deepEqual(same.diagnostics, []);
  assert.equal(same.defineSites.length, 1);
  const differ = linkWith({ 'lib.8bs': lib(10), 'main.8bs': main(11) }, 'main.8bs');
  assert.ok(codes(differ.diagnostics).includes('8BS1049'), JSON.stringify(codes(differ.diagnostics)));
  assert.match(differ.diagnostics.find((d) => d.code === '8BS1049').message, /one name is one value/);
});

test('#define refuses by name anything but an UPPER_SNAKE name and a default', () => {
  const file = join(tmpdir(), 'define-shapes.8bs');
  const diag = (call) => analyze(`const V: utinyint = ${call};\nexport function main(): void { memory.write(0x8000, V); }\n`, file);
  assert.deepEqual(codes(diag('#define("SEED", 10)')), []);
  assert.deepEqual(codes(diag('#define("START_CREDITS", 1000)')).filter((c) => c === '8BS1047'), []);
  assert.deepEqual(codes(diag('#define()')), ['8BS1047']);
  assert.deepEqual(codes(diag('#define("SEED")')), ['8BS1047'], 'the default is required');
  assert.match(diag('#define("SEED")')[0].message, /default/);
  assert.deepEqual(codes(diag('#define(SEED, 10)')), ['8BS1047'], 'a bare word is not a name in quotes');
  assert.deepEqual(codes(diag('#define("seed", 10)')), ['8BS1047']);
  assert.match(diag('#define("seed", 10)')[0].message, /capital letters/);
  assert.deepEqual(codes(diag('#define("1ST", 10)')), ['8BS1047']);
  assert.deepEqual(codes(diag('#define("SEED", 10, 11)')), ['8BS1047']);
  assert.deepEqual(codes(diag('#define("SEED", memory.read(1))')), ['8BS1047'], 'the default is a literal, not an expression');
  assert.ok(DEFINE_NAME.test('A') && DEFINE_NAME.test('FORCE_BONUS_2') && !DEFINE_NAME.test('_X') && !DEFINE_NAME.test('Seed'));
});

test('a value of another kind than the default is 8BS1048 naming both kinds', () => {
  const { diagnostics } = linkWith({ 'main.8bs': DEFINED }, 'main.8bs', { defines: { SEED: true } });
  const mismatch = diagnostics.filter((d) => d.code === '8BS1048');
  assert.equal(mismatch.length, 1, JSON.stringify(codes(diagnostics)));
  assert.match(mismatch[0].message, /SEED was given true or false/);
  assert.match(mismatch[0].message, /default, 10, is a number/);
  const strings = linkWith({ 'main.8bs': DEFINED }, 'main.8bs', { defines: { FORCE_BONUS: 'yes' } });
  assert.ok(codes(strings.diagnostics).includes('8BS1048'));
});

test('a handed value is checked against the width it lands in, like the literal would be', () => {
  const { diagnostics } = linkWith({ 'main.8bs': DEFINED }, 'main.8bs', { defines: { SEED: 300 } });
  assert.ok(codes(diagnostics).includes('8BS1013') || diagnostics.some((d) => /fit|range|utinyint/i.test(d.message)), JSON.stringify(diagnostics.map((d) => [d.code, d.message])));
});

test('defineKind names the three kinds a define can hold', () => {
  assert.equal(defineKind(3), 'int');
  assert.equal(defineKind(false), 'bool');
  assert.equal(defineKind('x'), 'string');
});

test('an unknown compile-time function lists #define among the ones the compiler evaluates', () => {
  const diagnostics = analyze('const V: utinyint = #nope(1);\nexport function main(): void { memory.write(0x8000, V); }\n', join(tmpdir(), 'x.8bs'));
  assert.match(diagnostics[0].message, /#define\(\.\.\.\)/);
});
