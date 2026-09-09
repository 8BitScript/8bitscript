// `array<T, N>`: N values of T, read and written one element at a time.
// `let` is RAM (zero until written, or `= [..]`); `const` with `= [..]` is
// data in the program, never in RAM — it has an address, so unlike a scalar
// const it is not inlined; `@address` is N cells of hardware. The length is
// part of the type, so `a.length` is a number 8bitscript fills in, an
// initialiser has exactly N elements, and a literal index past the end is a
// diagnostic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze, link, tokenize, parse, lower } from '../index.mjs';

const diagnosticsOf = (src) => analyze(src, 't.8bs');
const codes = (src) => diagnosticsOf(src).map((d) => d.code);
const clean = (src) => assert.deepEqual(diagnosticsOf(src).map((d) => `${d.code} ${d.message}`), []);
const lowered = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't', src);
};

async function linkWith(files, entry = 'main.8bs') {
  const dir = await mkdtemp(join(tmpdir(), '8bs-array-'));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    return link(files[entry], join(dir, entry));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MAIN = 'export function main(): void { }';

// ---- declarations ----------------------------------------------------------

test('a let array is a global with a length and no values; a const array has values and is constant', () => {
  const { ir, diagnostics } = lowered(`let hp: array<usmallint, 4>;\nconst TABLE: array<utinyint, 3> = [1, 2, 3];\n${MAIN}`);
  assert.deepEqual(diagnostics, []);
  const [hp, table] = ir.globals;
  assert.deepEqual({ name: hp.name, type: hp.type, array: hp.array, constant: hp.constant, init: hp.init },
    { name: 'hp', type: 'usmallint', array: 4, constant: false, init: null });
  assert.deepEqual({ name: table.name, type: table.type, array: table.array, constant: table.constant, init: table.init },
    { name: 'TABLE', type: 'utinyint', array: 3, constant: true, init: [1, 2, 3] });
  assert.deepEqual(ir.consts, [], 'a const array is storage, not an inlined value');
});

test('a let array may start with values; a bool array holds 0 and 1', () => {
  clean(`let scores: array<utinyint, 2> = [10, 20];\nlet flags: array<bool, 2> = [true, false];\n${MAIN}`);
  assert.deepEqual(lowered('let flags: array<bool, 2> = [true, false];').ir.globals[0].init, [1, 0]);
});

test('the length is a literal or a const in this module', () => {
  clean(`const COUNT: utinyint = 4;\nlet hp: array<utinyint, COUNT>;\n${MAIN}`);
  assert.equal(lowered('const COUNT: utinyint = 4;\nlet hp: array<utinyint, COUNT>;').ir.globals[0].array, 4);
  const d = diagnosticsOf(`let hp: array<utinyint, nope>;\n${MAIN}`);
  assert.deepEqual(d.map((x) => x.code), ['8BS3001']);
  assert.match(d[0].message, /a length N: an integer literal, or a const declared in this module/);
  assert.match(diagnosticsOf(`let hp: array<utinyint, 0>;\n${MAIN}`)[0].message, /1\.\.65535, not 0/);
  assert.match(diagnosticsOf(`let hp: array<utinyint>;\n${MAIN}`)[0].message, /needs a length N/);
  assert.match(diagnosticsOf(`let hp: array<string, 4>;\n${MAIN}`)[0].message, /integer or bool element type/);
});

test('an initialiser has exactly N elements, each a compile-time value that fits the element type', () => {
  const short = diagnosticsOf(`let hp: array<utinyint, 4> = [1, 2];\n${MAIN}`);
  assert.deepEqual(short.map((d) => d.code), ['8BS1033']);
  assert.match(short[0].message, /array<utinyint, 4>, so its initialiser needs 4 elements, not 2/);
  assert.deepEqual(codes(`let hp: array<utinyint, 2> = [1, 300];\n${MAIN}`), ['8BS1021']);
  assert.deepEqual(codes(`let n: utinyint = 1;\nlet hp: array<utinyint, 2> = [1, n];\n${MAIN}`), ['8BS3001']);
  assert.match(diagnosticsOf(`let hp: array<utinyint, 2> = 5;\n${MAIN}`)[0].message, /written \[v, v, \.\.\.\]/);
});

test('a const array needs its values and cannot be @address; an @address array cannot have values', () => {
  assert.match(diagnosticsOf(`const T: array<utinyint, 2>;\n${MAIN}`)[0].message, /const NAME: array<T, N> = \[\.\.\.\]/);
  assert.match(diagnosticsOf(`@address(0x0400) const T: array<utinyint, 2> = [1, 2];\n${MAIN}`)[0].message, /cannot have an initialiser/);
  assert.match(diagnosticsOf(`@address(0x0400) let s: array<utinyint, 2> = [1, 2];\n${MAIN}`)[0].message, /maps hardware and cannot have an initialiser/);
});

// ---- reads and writes --------------------------------------------------------

test('a[i], a[i] = v, a[i] += v, a[i]++ lower to index reads and stores with the element type', () => {
  const { ir, diagnostics } = lowered(`let hp: array<usmallint, 4>;\nlet i: utinyint = 0;\nexport function main(): void { hp[i] = hp[0] + 1; hp[1] += 2; hp[i]++; }`);
  assert.deepEqual(diagnostics, []);
  const [store, add, inc] = ir.functions[0].body;
  assert.equal(store.kind, 'storeIndex');
  assert.equal(store.elementType, 'usmallint');
  assert.deepEqual(store.value.left, { kind: 'index', array: { kind: 'ref', name: 'hp', start: 89, length: 2 }, index: { kind: 'const', value: 0, type: 'utinyint' }, elementType: 'usmallint', type: 'usmallint' });
  assert.equal(add.value.operator, '+');
  assert.equal(add.value.left.kind, 'index');
  assert.deepEqual(inc.value.right, { kind: 'const', value: 1, type: 'utinyint' });
});

test('a.length is the number in the type, folded where it is read', () => {
  const { ir } = lowered('let hp: array<usmallint, 4>;\nlet n: utinyint = 0;\nexport function main(): void { n = hp.length; }');
  assert.deepEqual(ir.functions[0].body[0].value, { kind: 'const', value: 4, type: 'utinyint' });
});

test('a literal index outside the array is 8BS1032, at the index', () => {
  const src = 'let hp: array<utinyint, 4>;\nexport function main(): void { hp[4] = 1; hp[3] = hp[9]; }';
  const d = diagnosticsOf(src);
  assert.deepEqual(d.map((x) => x.code), ['8BS1032', '8BS1032']);
  assert.equal(d[0].start, src.indexOf('4] = 1'));
  assert.match(d[0].message, /index 4 is outside an array<utinyint, 4>: elements are 0\.\.3/);
});

test('an element of a const array cannot be assigned: 8BS1031 once, at the name, from the editor too', () => {
  const src = 'const T: array<utinyint, 2> = [1, 2];\nexport function main(): void { T[0] = 5; T[1]++; }';
  const d = diagnosticsOf(src);
  assert.deepEqual(d.map((x) => x.code), ['8BS1031', '8BS1031']);
  assert.equal(d[0].start, src.indexOf('T[0]'));
  assert.equal(d[0].length, 1);
  assert.match(d[0].message, /'T' is a const array — data in the program, not RAM/);
});

test('an array is used one element at a time: neither assigned nor read as a whole', () => {
  assert.match(diagnosticsOf(`let a: array<utinyint, 2>;\nlet b: array<utinyint, 2>;\nexport function main(): void { a = b; }`)[0].message, /written one element at a time, a\[i\] = /);
  assert.match(diagnosticsOf(`let a: array<utinyint, 2>;\nlet n: utinyint = 0;\nexport function main(): void { n = a; }`)[0].message, /read an element \(a\[i\]\) or its \.length/);
  assert.match(diagnosticsOf(`let a: array<utinyint, 2>;\nlet n: utinyint = 0;\nexport function main(): void { n = a.size; }`)[0].message, /has no 'size'; it has \.length and a\[i\]/);
  assert.match(diagnosticsOf(`let n: utinyint = 0;\nexport function main(): void { n[0] = 1; }`)[0].message, /'n' is not an array/);
  assert.match(diagnosticsOf(`let n: utinyint = 0;\nexport function main(): void { n = [1, 2]; }`)[0].message, /only initialises an array<T, N> declaration/);
});

test('a template field sizes itself from an element type or a length', () => {
  clean(`let hp: array<usmallint, 4>;\nlet i: utinyint = 0;\nexport namespace text {\n function print(cell: usmallint, s: string): void { }\n function printNumber(cell: usmallint, value: usmallint, width: utinyint): void { }\n}\nexport function main(): void { text.print(0, \`HP \${hp[i]} OF \${hp.length}\`); }`);
});

// ---- across modules -------------------------------------------------------------

test('an imported array: reads, writes, .length, and the const and range rules, resolved by the linker', async () => {
  const lib = 'export const TABLE: array<utinyint, 3> = [1, 2, 3];\nexport let hp: array<usmallint, 4>;\n';
  const good = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'import { TABLE, hp } from "./lib.8bs";\nlet i: utinyint = 0;\nexport function main(): void { hp[0] = TABLE[2]; hp[i] += 1; i = hp.length + TABLE.length; }\n',
  });
  assert.deepEqual(good.diagnostics, []);
  const [store, add, length] = good.ir.functions.find((f) => f.name === 'main').body;
  assert.equal(store.elementType, 'usmallint');
  assert.equal(store.value.elementType, 'utinyint');
  assert.equal(add.value.left.elementType, 'usmallint');
  assert.deepEqual(length.value, { kind: 'binop', operator: '+', left: { kind: 'const', value: 4, type: 'utinyint' }, right: { kind: 'const', value: 3, type: 'utinyint' }, type: 'utinyint' });

  const bad = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'import { TABLE, hp } from "./lib.8bs";\nexport function main(): void { TABLE[0] = 1; hp[4] = 1; hp = 1; }\n',
  });
  assert.deepEqual(bad.diagnostics.map((d) => `${d.code} ${d.message}`), [
    "8BS1031 'TABLE' is a const array — data in the program, not RAM — and cannot be assigned to",
    '8BS1032 index 4 is outside an array<usmallint, 4>: elements are 0..3',
    "8BS3001 'hp' is an array: it is written one element at a time, hp[i] = ...",
  ]);
});

test('indexing an imported function or const is refused by name', async () => {
  const { diagnostics } = await linkWith({
    'lib.8bs': 'export const LIMIT: utinyint = 4;\nexport function f(): void { }\n',
    'main.8bs': 'import { LIMIT, f } from "./lib.8bs";\nlet n: utinyint = 0;\nexport function main(): void { n = f[0]; }\n',
  });
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001']);
  assert.match(diagnostics[0].message, /'f' is not an array/);
});

test('two modules may each have an array of the same name; the second is renamed like any global', async () => {
  const { ir, diagnostics } = await linkWith({
    'lib.8bs': 'export let hp: array<utinyint, 2>;\nexport function poke(): void { hp[0] = 1; }\n',
    'main.8bs': 'import { poke } from "./lib.8bs";\nlet hp: array<utinyint, 2>;\nexport function main(): void { hp[1] = 2; poke(); }\n',
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.globals.map((g) => g.name), ['hp', 'hp_2']);
  assert.equal(ir.functions.find((f) => f.name === 'poke').body[0].array.name, 'hp_2');
});

test('a const array is constant data, a let array is RAM, and an @address array is hardware', async () => {
  const { ir } = await linkWith({
    'main.8bs': 'const TABLE: array<utinyint, 3> = [1, 2, 3];\nlet hp: array<usmallint, 4>;\nlet scores: array<utinyint, 2> = [10, 20];\n@address(0x0400) let screenRam: array<utinyint, 1000>;\nlet i: utinyint = 0;\nexport function main(): void { hp[i] = TABLE[2]; screenRam[i] = scores[1]; hp[0]++; }\n',
  });
  const global = (name) => ir.globals.find((g) => g.name === name);
  assert.deepEqual({ type: global('TABLE').type, array: global('TABLE').array, constant: global('TABLE').constant, init: global('TABLE').init },
    { type: 'utinyint', array: 3, constant: true, init: [1, 2, 3] });
  assert.deepEqual({ type: global('hp').type, array: global('hp').array, constant: global('hp').constant, init: global('hp').init, address: global('hp').address },
    { type: 'usmallint', array: 4, constant: false, init: null, address: null });
  assert.deepEqual(global('scores').init, [10, 20]);
  assert.equal(global('screenRam').address, 0x400);
  const [storeHp, storeScreen, inc] = ir.functions.find((f) => f.name === 'main').body;
  assert.equal(storeHp.kind, 'storeIndex');
  assert.equal(storeHp.array.name, 'hp');
  assert.equal(storeHp.value.kind, 'index');
  assert.equal(storeHp.value.array.name, 'TABLE');
  assert.equal(storeScreen.array.name, 'screenRam');
  assert.equal(storeScreen.value.array.name, 'scores');
  assert.equal(inc.kind, 'storeIndex');
  assert.equal(inc.value.operator, '+');
});

// ---- what the program declares --------------------------------------------------

test('the linked program reports the RAM its variables declare and the constant data it carries', async () => {
  const { ir } = await linkWith({
    'main.8bs': 'const TABLE: array<utinyint, 3> = [1, 2, 3];\nlet hp: array<usmallint, 4>;\nlet name: string<8>;\nlet n: mediumint = 0;\n@address(0x0400) let screenRam: array<utinyint, 1000>;\nexport function main(): void { hp[0] = TABLE[0]; name = "HI"; }\n',
  });
  // hp 8 + name 9 + n 4 (24-bit widens to 4); TABLE 3 + "HI" 3; screenRam is hardware.
  assert.deepEqual(ir.memory, { variables: 21, data: 6 });
});

test('a namespace const or an imported const may be an array element or a global initialiser; the linker fills it in', async () => {
  const lib = 'export namespace BorderColor { const BLUE: utinyint = 6; const RED: utinyint = 2; }\nexport const BIG: usmallint = 300;\nexport const TWO: utinyint = 2;\n';
  const good = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'import { BorderColor, TWO } from "./lib.8bs";\nconst BORDERS: array<utinyint, 2> = [BorderColor.BLUE, TWO];\nlet current: utinyint = BorderColor.RED;\nexport function main(): void { current = BORDERS[1]; }\n',
  });
  assert.deepEqual(good.diagnostics, []);
  assert.deepEqual(good.ir.globals.find((g) => g.name === 'BORDERS').init, [6, 2]);
  assert.equal(good.ir.globals.find((g) => g.name === 'current').init, 2);
  assert.equal(good.ir.globals.find((g) => g.name === 'BORDERS').constant, true);

  const bad = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'import { BorderColor, BIG } from "./lib.8bs";\nlet bad: array<utinyint, 2> = [BIG, BorderColor.Nope];\nlet worse: utinyint = BorderColor.Nope;\nexport function main(): void { }\n',
  });
  assert.deepEqual(bad.diagnostics.map((d) => `${d.code} ${d.message}`), [
    '8BS1021 300 does not fit in utinyint (0..255)',
    "8BS2005 'Nope' is not a const in namespace 'BorderColor'",
    "8BS2005 'Nope' is not a const in namespace 'BorderColor'",
  ]);
});
