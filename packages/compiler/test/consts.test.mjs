// Top-level `const`: a compile-time constant — one of the three spellings
// that say "8bitscript resolves this" (a literal, a `const`, `#name(...)`).
// Lowering records it, the linker inlines every reference (its own
// module's and an importer's), no backend ever sees it, and assigning to
// one is a diagnostic from the checker (own module, so it reaches the
// editor) or the linker (imported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze, link, tokenize, parse, lower } from '../index.mjs';

const codes = (src, options) => analyze(src, 't.8bs', options).map((d) => d.code);
const lowered = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't', src);
};

async function linkWith(files, entry = 'main.8bs', options = {}) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-const-'));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    return link(files[entry], join(dir, entry), options);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('lowering: a const is recorded, not stored — no global, one const', () => {
  const { ir, diagnostics } = lowered('const HALF: utinyint = 30;\nlet n: u8 = 0;\nexport function main(): void { }');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.globals.map((g) => g.name), ['n']);
  assert.deepEqual(ir.consts, [{ name: 'HALF', type: 'utinyint', value: 30, exported: false, start: 6, length: 4 }]);
});

test('lowering: a const initialized from #frames(...) is a literal by the time it is recorded', async () => {
  const { ir, diagnostics } = await linkWith({
    'main.8bs': 'const HALF: utinyint = #frames(0.5, seconds);\nlet n: utinyint = 0;\nexport function main(): void { n = HALF; }\n',
  }, 'main.8bs', { frameRate: 50 });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.functions[0].body[0].value, { kind: 'const', value: 25, type: 'utinyint' });
});

test('lowering: a const needs a literal initializer and cannot be volatile or @address', () => {
  for (const src of [
    'const X: utinyint;',
    'const X: volatile<utinyint> = 1;',
    '@address(0x900F) const X: utinyint;',
  ]) {
    const { diagnostics } = lowered(`${src}\nexport function main(): void { }`);
    assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001'], src);
  }
});

test('checker: assigning to, or ++/--ing, a const is 8BS1031 at the name; a parameter of that name shadows it', () => {
  const src = 'const HALF: utinyint = 30;\nexport function main(): void { HALF = 2; HALF++; HALF += 1; }\nfunction f(HALF: u8): void { HALF = 1; }';
  const d = analyze(src, 't.8bs');
  assert.deepEqual(d.map((x) => x.code), ['8BS1031', '8BS1031', '8BS1031']);
  assert.equal(d[0].start, src.indexOf('HALF = 2'));
  assert.equal(d[0].length, 4);
  assert.match(d[0].message, /'HALF' is a const .* cannot be assigned/);
});

test('checker: a const still gets the literal-fits-the-type rule', () => {
  assert.deepEqual(codes('const X: utinyint = 300;'), ['8BS1021']);
});

test('linker: every reference to a const is the value, and the name never becomes storage', async () => {
  const { ir, diagnostics } = await linkWith({
    'main.8bs': 'const LIMIT: utinyint = 4;\nlet option: utinyint = 0;\nexport function main(): void { option = option + 1; if (option == LIMIT) { option = 0; } }\n',
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.globals.map((g) => g.name), ['option']);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.deepEqual(main.body[1].test.right, { kind: 'const', value: 4, type: 'utinyint' });
});

test('linker: an exported const is importable and inlines in the importer; assigning to it there is 8BS1031', async () => {
  const lib = 'export const LIMIT: utinyint = 4;\nexport let hidden: utinyint = 0;\n';
  const good = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'import { LIMIT as Max } from "./lib.8bs";\nlet n: utinyint = 0;\nexport function main(): void { n = Max; }\n',
  });
  assert.deepEqual(good.diagnostics, []);
  assert.deepEqual(good.ir.functions.find((f) => f.name === 'main').body[0].value, { kind: 'const', type: 'utinyint', value: 4 });

  const bad = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'import { LIMIT } from "./lib.8bs";\nexport function main(): void { LIMIT = 5; }\n',
  });
  assert.deepEqual(bad.diagnostics.map((d) => d.code), ['8BS1031']);
});

test('linker: a const that is not exported is not importable, like any other declaration', async () => {
  const { diagnostics } = await linkWith({
    'lib.8bs': 'const LIMIT: utinyint = 4;\n',
    'main.8bs': 'import { LIMIT } from "./lib.8bs";\nexport function main(): void { }\n',
  });
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2005']);
});

test('linker: the entry module may not export a const — its one export is the program', async () => {
  const { diagnostics } = await linkWith({
    'main.8bs': 'export const LIMIT: utinyint = 4;\nexport function main(): void { }\n',
  });
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2010']);
  assert.match(diagnostics[0].message, /'LIMIT' is a global/);
});

test('template: a const sizes a field like a global would', async () => {
  const { diagnostics } = await linkWith({
    'text.8bs': 'let i: utinyint = 0;\nexport namespace text {\n function print(cell: usmallint, s: string): void { }\n function printNumber(cell: usmallint, value: usmallint, width: utinyint): void { }\n}\n',
    'main.8bs': 'import { text } from "./text.8bs";\nconst LIMIT: usmallint = 400;\nexport function main(): void { text.print(0, `${LIMIT}`); }\n',
  });
  assert.deepEqual(diagnostics, []);
});

// ---- a const reaches the places only a literal could ----------------------

test('a const names an address, and the linker never sees storage for it', () => {
  const { ir, diagnostics } = lowered('const BORDER_REGISTER: usmallint = 0xD020;\n@address(BORDER_REGISTER) let border: volatile<utinyint>;\nexport function main(): void { border = 1; }');
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.globals[0].address, 0xD020);
  assert.equal(ir.globals[0].volatile, true);
});

test('an @address that is neither a literal nor an own const says so', () => {
  const { diagnostics } = lowered('@address(nope) let border: volatile<utinyint>;\nexport function main(): void { }');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001']);
  assert.match(diagnostics[0].message, /one integer literal, or a const declared in this module/);
});

test('a const initializes a global, its own module and an imported one', async () => {
  const own = await linkWith({
    'main.8bs': 'const START: usmallint = 1024;\nlet cursor: usmallint = START;\nexport function main(): void { }\n',
  });
  assert.deepEqual(own.diagnostics, []);
  assert.equal(own.ir.globals.find((g) => g.name === 'cursor').init, 1024);

  const imported = await linkWith({
    'lib.8bs': 'export const START: usmallint = 1024;\n',
    'main.8bs': 'import { START } from "./lib.8bs";\nlet cursor: usmallint = START;\nexport function main(): void { }\n',
  });
  assert.deepEqual(imported.diagnostics, []);
  assert.equal(imported.ir.globals.find((g) => g.name === 'cursor').init, 1024);
});

test('a global initialized from something that is not a const says which it is', async () => {
  const notConst = await linkWith({
    'main.8bs': 'let a: utinyint = 1;\nlet b: utinyint = a;\nexport function main(): void { }\n',
  });
  assert.deepEqual(notConst.diagnostics.map((d) => d.code), ['8BS3001']);
  assert.match(notConst.diagnostics[0].message, /'a' is not a const, so it cannot initialize a global/);

  const unknown = await linkWith({
    'main.8bs': 'let b: utinyint = nope;\nexport function main(): void { }\n',
  });
  assert.deepEqual(unknown.diagnostics.map((d) => d.code), ['8BS2007']);
});

test('a const argument gets the same range check a literal would', async () => {
  const { diagnostics } = await linkWith({
    'main.8bs': 'const BIG: usmallint = 400;\nexport function main(): void { memory.write(1024, BIG); }\n',
  });
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS1021']);
  assert.match(diagnostics[0].message, /400 does not fit in utinyint/);
});

test('a const may be written in terms of one above it', () => {
  const { ir, diagnostics } = lowered('const BASE: usmallint = 1024;\nconst CURSOR: usmallint = BASE;\nlet at: usmallint = CURSOR;\nexport function main(): void { }');
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.globals[0].init, 1024);
});

// ---- a const the linker has to finish -------------------------------------

test('a const initialized from a namespace const or an imported const: the value, inlined, and range-checked', async () => {
  const good = await linkWith({
    'lib.8bs': 'export namespace TextColor { const YELLOW: utinyint = 7; }\nexport const TWO: utinyint = 2;\n',
    'main.8bs': 'import { TextColor, TWO } from "./lib.8bs";\nconst HIGHLIGHT: utinyint = TextColor.YELLOW;\nconst PAIR: utinyint = TWO;\nconst AGAIN: utinyint = PAIR;\nlet n: utinyint = AGAIN;\nexport function main(): void { n = HIGHLIGHT + PAIR + AGAIN; }\n',
  });
  assert.deepEqual(good.diagnostics, []);
  assert.equal(good.ir.globals.find((g) => g.name === 'n').init, 2);
  const assign = good.ir.functions.find((f) => f.name === 'main').body[0];
  assert.deepEqual(assign.value, {
    kind: 'binop', operator: '+', type: 'utinyint',
    left: {
      kind: 'binop', operator: '+', type: 'utinyint',
      left: { kind: 'const', value: 7, type: 'utinyint' }, right: { kind: 'const', value: 2, type: 'utinyint' },
    },
    right: { kind: 'const', value: 2, type: 'utinyint' },
  });

  const bad = await linkWith({
    'lib.8bs': 'export const BIG: usmallint = 300;\nexport let g: utinyint = 0;\nexport namespace C { const BLUE: utinyint = 6; }\n',
    'main.8bs': 'import { BIG, g, C } from "./lib.8bs";\nconst A: utinyint = BIG;\nconst E: utinyint = g;\nconst F: utinyint = nope;\nconst G: utinyint = C.Nope;\nexport function main(): void { }\n',
  });
  assert.deepEqual(bad.diagnostics.map((d) => `${d.code} ${d.message}`), [
    '8BS1021 300 does not fit in utinyint (0..255)',
    "8BS3001 'g' is not a const, so it cannot initialize a const",
    "8BS2007 cannot find name 'nope'",
    "8BS2005 'Nope' is not a const in namespace 'C'",
  ]);
});

test('a const that depends on itself through other consts is reported, not looped on', async () => {
  const { diagnostics } = await linkWith({
    'lib.8bs': 'export const A: utinyint = B;\nexport const B: utinyint = A;\n',
    'main.8bs': 'import { A } from "./lib.8bs";\nlet n: utinyint = A;\nexport function main(): void { }\n',
  });
  assert.ok(diagnostics.some((d) => /depends on itself/.test(d.message)), JSON.stringify(diagnostics.map((d) => d.message)));
});

// ---- the spelling says which side a name is on -----------------------------

test('checker: a const is UPPER_SNAKE and a variable starts lower-case — 8BS1034 names the spelling to use', () => {
  const d = analyze('const OptionCount: utinyint = 4;\nlet Ticks: utinyint = 0;\nexport namespace BorderColor { const Blue: utinyint = 6; }\nexport function main(): void { let Cell: utinyint = 0; }', 't.8bs');
  assert.deepEqual(d.map((x) => `${x.code} ${x.message}`), [
    '8BS1034 a const is written in upper case, so a reader knows it is resolved by 8bitscript: OPTION_COUNT',
    '8BS1034 a variable starts with a lower-case letter; an upper-case name is a const',
    '8BS1034 a const is written in upper case, so a reader knows it is resolved by 8bitscript: BLUE',
    '8BS1034 a variable starts with a lower-case letter; an upper-case name is a const',
  ]);
  assert.equal(d[0].start, 6);
  assert.equal(d[0].length, 11);
  assert.deepEqual(codes('const OPTION_COUNT: utinyint = 4;\nconst X2: utinyint = 1;\nlet ticks: utinyint = 0;\nlet _scratch: utinyint = 0;\n@address(0xD020) let borderColor: volatile<utinyint>;'), []);
});

// ---- an imported const carries its declared type into IR -------------------
//
// Lowering inlines a module's own const with the type it was declared with
// (ownConstTypes). A reference to an *imported* const survives lowering as
// a `ref` and is inlined by the linker instead — and it used to arrive at
// the backend as `{ kind: 'const', value }` with no type at all, so the MOS
// backend refused it wherever a type is needed to widen or size it ("'const':
// no type on this IR node") — as a call argument, in a 16-bit binop, as a
// let initializer. The same-module spelling built. The linker now keeps the
// declared type beside the value, for its own consts and every import.

const IMPORTED_CONST = (type, value, use) => ({
  'lib.8bs': `export const R: ${type} = ${value};\n`,
  'main.8bs': `import { R } from "./lib.8bs";\nlet out: ${type === 'bool' ? 'utinyint' : type} = 0;\nfunction sink(cell: usmallint, n: utinyint): void { memory.write(cell, n); }\nexport function main(): void { ${use} }\n`,
});

test('linker: an imported const is inlined with its declared type — every integer width, every use', async () => {
  const cases = [
    // [type, value, use, where in main's body the const node lands]
    ['utinyint', 5, 'sink(R, 4);', (body) => body[0].args[0]],
    ['utinyint', 5, 'let n: utinyint = out + R; sink(0, n);', (body) => body[0].init.right],
    ['utinyint', 5, 'let n: utinyint = R; sink(0, n);', (body) => body[0].init],
    ['usmallint', 300, 'sink(R, 4);', (body) => body[0].args[0]],
    ['usmallint', 300, 'let n: usmallint = out + R; sink(n, 4);', (body) => body[0].init.right],
    ['usmallint', 300, 'let n: usmallint = R; sink(n, 4);', (body) => body[0].init],
    ['smallint', -5, 'let n: smallint = R; sink(0, 4);', (body) => body[0].init],
    ['int', 70000, 'let n: int = R; sink(0, 4);', (body) => body[0].init],
  ];
  for (const [type, value, use, at] of cases) {
    const { ir, diagnostics } = await linkWith(IMPORTED_CONST(type, value, use));
    assert.deepEqual(diagnostics, [], `${type} ${use}`);
    const main = ir.functions.find((f) => f.name === 'main');
    assert.deepEqual(at(main.body), { kind: 'const', value, type }, `${type} ${use}`);
  }
});

test('linker: an imported bool const is inlined typed too, and a 16-bit binop over an imported const is 16-bit', async () => {
  const flag = await linkWith(IMPORTED_CONST('bool', 'true', 'if (R) { sink(0, 1); }'));
  assert.deepEqual(flag.diagnostics, []);
  assert.deepEqual(flag.ir.functions.find((f) => f.name === 'main').body[0].test, { kind: 'const', value: 1, type: 'bool' });

  const wide = await linkWith(IMPORTED_CONST('usmallint', 300, 'let n: usmallint = out + R; sink(n, 4);'));
  assert.equal(wide.ir.functions.find((f) => f.name === 'main').body[0].init.type, 'usmallint');
});

test('mos: a PET image is byte-identical whether the const is imported or declared in the module that uses it', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { linkFiles } = await import('./support/link-files.mjs');
  const { build: buildMos } = await import('../src/mos/index.ts');
  const body = 'let out: usmallint = 0;\nexport function main(): void { let n: usmallint = out + R; memory.write(n, 4); memory.write(R, 2); }\n';
  const imported = { 'lib.8bs': 'export const R: usmallint = 300;\n', 'main.8bs': `import { R } from "./lib.8bs";\n${body}` };
  const own = { 'main.8bs': `const R: usmallint = 300;\n${body}` };
  const dir = mkdtempSync(join(tmpdir(), '8bs-const-prg-'));
  try {
    const hardware = { build: { defsym: { __ram_size: 32, __load_address: 0x0401 } }, facts: {} };
    const images = [];
    for (const files of [imported, own]) {
      const linked = linkFiles(files, 'main.8bs', { machine: 'pet' });
      assert.deepEqual(linked.diagnostics, []);
      const prg = await buildMos(linked.ir, { machine: 'pet', hardware, frameRate: 60, outFile: join(dir, `${images.length}.prg`) });
      assert.equal(prg.ok, true, prg.error);
      images.push(prg.bytes);
    }
    assert.deepEqual([...images[0]], [...images[1]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
