// `array<T, N>`: N values of T, read and written one element at a time.
// `let` is RAM (zero until written, or `= [..]`); `const` with `= [..]` is
// data in the program, never in RAM — it has an address, so unlike a scalar
// const it is not inlined; `@address` is N cells of hardware. The length is
// part of the type, so `a.length` is a number 8bitscript fills in, an
// initializer has exactly N elements, and a literal index past the end is a
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

const MAIN = 'pub fn main() {\n}';

// ---- declarations ----------------------------------------------------------

test('a let array is a global with a length and no values; a const array has values and is constant', () => {
  const { ir, diagnostics } = lowered(`let hp: [usmallint; 4];
const TABLE: [utinyint; 3] = [1, 2, 3];
${MAIN};`);
  assert.deepEqual(diagnostics, []);
  const [hp, table] = ir.globals;
  assert.deepEqual({ name: hp.name, type: hp.type, array: hp.array, constant: hp.constant, init: hp.init },
    { name: 'hp', type: 'usmallint', array: 4, constant: false, init: null });
  assert.deepEqual({ name: table.name, type: table.type, array: table.array, constant: table.constant, init: table.init },
    { name: 'TABLE', type: 'utinyint', array: 3, constant: true, init: [1, 2, 3] });
  assert.deepEqual(ir.consts, [], 'a const array is storage, not an inlined value');
});

test('a let array may start with values; a bool array holds 0 and 1', () => {
  clean(`let scores: [utinyint; 2] = [10, 20];
let flags: [bool; 2] = [true, false];
${MAIN};`);
  assert.deepEqual(lowered('let flags: [bool; 2] = [true, false];').ir.globals[0].init, [1, 0]);
});

test('the length is a literal or a const in this module', () => {
  clean(`const COUNT: utinyint = 4;
let hp: [utinyint; COUNT];
${MAIN};`);
  assert.equal(lowered('const COUNT: utinyint = 4;\nlet hp: [utinyint; COUNT];').ir.globals[0].array, 4);
  const d = diagnosticsOf(`let hp: array<utinyint, nope>;\n${MAIN}`);
  assert.deepEqual(d.map((x) => x.code), ['8BS3001']);
  assert.match(d[0].message, /a length N: an integer literal, or a const declared in this module/);
  assert.match(diagnosticsOf(`let hp: array<utinyint, 0>;\n${MAIN}`)[0].message, /1\.\.65535, not 0/);
  assert.match(diagnosticsOf(`let hp: array<utinyint>;\n${MAIN}`)[0].message, /needs a length N/);
  assert.match(diagnosticsOf(`let hp: array<string, 4>;\n${MAIN}`)[0].message, /integer or bool element type/);
});

test('an initializer has exactly N elements, each a compile-time value that fits the element type', () => {
  const short = diagnosticsOf(`let hp: [utinyint; 4] = [1, 2];
${MAIN};`);
  assert.deepEqual(short.map((d) => d.code), ['8BS1033']);
  assert.match(short[0].message, /array<utinyint, 4>, so its initializer needs 4 elements, not 2/);
  assert.deepEqual(codes(`let hp: [utinyint; 2] = [1, 300];
${MAIN};`), ['8BS1021']);
  assert.deepEqual(codes(`let n: utinyint = 1;
let hp: [utinyint; 2] = [1, n];
${MAIN};`), ['8BS3001']);
  assert.match(diagnosticsOf(`let hp: [utinyint; 2] = 5;
${MAIN};`)[0].message, /written \[v, v, \.\.\.\]/);
});

test('a const array needs its values and cannot be @address; an @address array cannot have values', () => {
  assert.match(diagnosticsOf(`const T: array<utinyint, 2>;\n${MAIN}`)[0].message, /const NAME: array<T, N> = \[\.\.\.\]/);
  assert.match(diagnosticsOf(`#[address(0x0400)] const T: [utinyint; 2] = [1, 2];
${MAIN};`)[0].message, /cannot have an initializer/);
  assert.match(diagnosticsOf(`#[address(0x0400)] let s: [utinyint; 2] = [1, 2];
${MAIN};`)[0].message, /maps hardware and cannot have an initializer/);
});

// ---- reads and writes --------------------------------------------------------

test('a[i], a[i] = v, a[i] += v, a[i]++ lower to index reads and stores with the element type', () => {
  const { ir, diagnostics } = lowered(`let mut hp: [usmallint; 4];
let i: utinyint = 0;
pub fn main() {
    hp[i] = hp[0] + 1;
    hp[1] += 2;
    hp[i] += 1;
}`);
  assert.deepEqual(diagnostics, []);
  const [store, add, inc] = ir.functions[0].body;
  assert.equal(store.kind, 'storeIndex');
  assert.equal(store.elementType, 'usmallint');
  assert.deepEqual(store.value.left, { kind: 'index', array: { kind: 'ref', name: 'hp', start: 77, length: 2 }, index: { kind: 'const', value: 0, type: 'utinyint' }, elementType: 'usmallint', type: 'usmallint' });
  assert.equal(add.value.operator, '+');
  assert.equal(add.value.left.kind, 'index');
  assert.deepEqual(inc.value.right, { kind: 'const', value: 1, type: 'utinyint' });
});

test('a.length is the number in the type, folded where it is read', () => {
  const { ir } = lowered('let hp: [usmallint; 4];\nlet mut n: utinyint = 0;\npub fn main() {\n    n = hp.length;\n}');
  assert.deepEqual(ir.functions[0].body[0].value, { kind: 'const', value: 4, type: 'utinyint' });
});

test('a literal index outside the array is 8BS1032, at the index', () => {
  const src = 'let mut hp: [utinyint; 4];\npub fn main() {\n    hp[4] = 1;\n    hp[3] = hp[9];\n}';
  const d = diagnosticsOf(src);
  assert.deepEqual(d.map((x) => x.code), ['8BS1032', '8BS1032']);
  assert.equal(d[0].start, src.indexOf('4] = 1'));
  assert.match(d[0].message, /index 4 is outside an array<utinyint, 4>: elements are 0\.\.3/);
});

test('an element of a const array cannot be assigned: 8BS1031 once, at the name, from the editor too', () => {
  const src = 'const T: [utinyint; 2] = [1, 2];\npub fn main() {\n    T[0] = 5;\n    T[1] += 1;\n}';
  const d = diagnosticsOf(src);
  assert.deepEqual(d.map((x) => x.code), ['8BS1031', '8BS1031']);
  assert.equal(d[0].start, src.indexOf('T[0]'));
  assert.equal(d[0].length, 1);
  assert.match(d[0].message, /'T' is a const array — data in the program, not RAM/);
});

test('an array is used one element at a time: neither assigned nor read as a whole', () => {
  assert.match(diagnosticsOf(`let mut a: [utinyint; 2];
let mut b: [utinyint; 2];
pub fn main() {
    a = b;
}`)[0].message, /written one element at a time, a\[i\] = /);
  assert.match(diagnosticsOf(`let mut a: [utinyint; 2];
let mut n: utinyint = 0;
pub fn main() {
    n = a;
}`)[0].message, /read an element \(a\[i\]\) or its \.length/);
  assert.match(diagnosticsOf(`let a: [utinyint; 2];
let mut n: utinyint = 0;
pub fn main() {
    n = a.size;
}`)[0].message, /has no 'size'; it has \.length and a\[i\]/);
  assert.match(diagnosticsOf(`let mut n: utinyint = 0;
pub fn main() {
    n[0] = 1;
}`)[0].message, /'n' is not an array/);
  assert.match(diagnosticsOf(`let mut n: utinyint = 0;
pub fn main() {
    n = [1, 2];
}`)[0].message, /only initializes an array<T, N> declaration/);
});

test('a template field sizes itself from an element type or a length', () => {
  clean(`let hp: [usmallint; 4];
let i: utinyint = 0;
pub mod text {
    fn print(cell: usmallint, s: string) {
    }
    fn printNumber(cell: usmallint, value: usmallint, width: utinyint) {
    }
}
pub fn main() {
    text::print(0, \`HP \${hp[i]} OF \${hp.length}\`);
}`);
});

// ---- across modules -------------------------------------------------------------

test('an imported array: reads, writes, .length, and the const and range rules, resolved by the linker', async () => {
  const lib = 'pub const TABLE: [utinyint; 3] = [1, 2, 3];\npub let mut hp: [usmallint; 4];\n';
  const good = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'use self::lib::{TABLE, hp};\nlet mut i: utinyint = 0;\npub fn main() {\n    hp[0] = TABLE[2];\n    hp[i] += 1;\n    i = hp.length + TABLE.length;\n}\n',
  });
  assert.deepEqual(good.diagnostics, []);
  const [store, add, length] = good.ir.functions.find((f) => f.name === 'main').body;
  assert.equal(store.elementType, 'usmallint');
  assert.equal(store.value.elementType, 'utinyint');
  assert.equal(add.value.left.elementType, 'usmallint');
  assert.deepEqual(length.value, { kind: 'binop', operator: '+', left: { kind: 'const', value: 4, type: 'utinyint' }, right: { kind: 'const', value: 3, type: 'utinyint' }, type: 'utinyint' });

  const bad = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'use self::lib::{TABLE, hp};\npub fn main() {\n    TABLE[0] = 1;\n    hp[4] = 1;\n    hp = 1;\n}\n',
  });
  assert.deepEqual(bad.diagnostics.map((d) => `${d.code} ${d.message}`), [
    "8BS1031 'TABLE' is a const array — data in the program, not RAM — and cannot be assigned to",
    '8BS1032 index 4 is outside an array<usmallint, 4>: elements are 0..3',
    "8BS3001 'hp' is an array: it is written one element at a time, hp[i] = ...",
  ]);
});

test('indexing an imported function or const is refused by name', async () => {
  const { diagnostics } = await linkWith({
    'lib.8bs': 'pub const LIMIT: utinyint = 4;\npub fn f() {\n}\n',
    'main.8bs': 'use self::lib::{LIMIT, f};\nlet mut n: utinyint = 0;\npub fn main() {\n    n = f[0];\n}\n',
  });
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001']);
  assert.match(diagnostics[0].message, /'f' is not an array/);
});

test('two modules may each have an array of the same name; the second is renamed like any global', async () => {
  const { ir, diagnostics } = await linkWith({
    'lib.8bs': 'pub let mut hp: [utinyint; 2];\npub fn poke() {\n    hp[0] = 1;\n}\n',
    'main.8bs': 'use self::lib::poke;\nlet mut hp: [utinyint; 2];\npub fn main() {\n    hp[1] = 2;\n    poke();\n}\n',
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.globals.map((g) => g.name), ['hp', 'hp_2']);
  assert.equal(ir.functions.find((f) => f.name === 'poke').body[0].array.name, 'hp_2');
});

test('a const array is constant data, a let array is RAM, and an @address array is hardware', async () => {
  const { ir } = await linkWith({
    'main.8bs': 'const TABLE: [utinyint; 3] = [1, 2, 3];\nlet mut hp: [usmallint; 4];\nlet scores: [utinyint; 2] = [10, 20];\n#[address(0x0400)] let mut screenRam: [utinyint; 1000];\nlet i: utinyint = 0;\npub fn main() {\n    hp[i] = TABLE[2];\n    screenRam[i] = scores[1];\n    hp[0] += 1;\n}\n',
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
    'main.8bs': 'const TABLE: [utinyint; 3] = [1, 2, 3];\nlet mut hp: [usmallint; 4];\nlet mut name: string<8>;\nlet n: mediumint = 0;\n#[address(0x0400)] let screenRam: [utinyint; 1000];\npub fn main() {\n    hp[0] = TABLE[0];\n    name = "HI";\n}\n',
  });
  // hp 8 + name 9 + n 4 (24-bit widens to 4); TABLE 3 + "HI" 3; screenRam is hardware.
  assert.deepEqual(ir.memory, { variables: 21, data: 6 });
});

test('a namespace const or an imported const may be an array element or a global initializer; the linker fills it in', async () => {
  const lib = 'pub mod BorderColor {\n    const BLUE: utinyint = 6;\n    const RED: utinyint = 2;\n}\npub const BIG: usmallint = 300;\npub const TWO: utinyint = 2;\n';
  const good = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'use self::lib::{BorderColor, TWO};\nconst BORDERS: [utinyint; 2] = [BorderColor::BLUE, TWO];\nlet mut current: utinyint = BorderColor::RED;\npub fn main() {\n    current = BORDERS[1];\n}\n',
  });
  assert.deepEqual(good.diagnostics, []);
  assert.deepEqual(good.ir.globals.find((g) => g.name === 'BORDERS').init, [6, 2]);
  assert.equal(good.ir.globals.find((g) => g.name === 'current').init, 2);
  assert.equal(good.ir.globals.find((g) => g.name === 'BORDERS').constant, true);

  const bad = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'use self::lib::{BorderColor, BIG};\nlet bad: [utinyint; 2] = [BIG, BorderColor::Nope];\nlet worse: utinyint = BorderColor::Nope;\npub fn main() {\n}\n',
  });
  assert.deepEqual(bad.diagnostics.map((d) => `${d.code} ${d.message}`), [
    '8BS1021 300 does not fit in utinyint (0..255)',
    "8BS2005 'Nope' is not a const in namespace 'BorderColor'",
    "8BS2005 'Nope' is not a const in namespace 'BorderColor'",
  ]);
});

// ---- 0.2.2: cross-module types reach the backends ---------------------------
//
// A module's own lowering can't type a ref to an imported global, an
// imported array's element read, or a call to an imported function — the
// linker fills all three in after every body is rewritten
// (fillCrossModuleTypes), because a backend that sizes values by type
// (the 6502's 8-vs-16-bit split) must never meet a typeless node.

test('a ref to an imported global, an imported array element read, and a call across modules all carry real types after linking', async () => {
  const { ir, diagnostics } = await linkWith({
    'main.8bs': [
      'use self::board::{top, POW2, pick};',
      'let mut cell: usmallint = 0;',
      'pub fn main() {',
      '    cell = top + POW2[pick()];',
      '}',
    ].join('\n'),
    'board.8bs': [
      'pub let mut top: usmallint = 40;',
      'pub const POW2: [usmallint; 3] = [1, 2, 4];',
      'pub fn pick() -> utinyint {',
      '    return 2;',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(diagnostics, []);
  const main = ir.functions.find((f) => f.name === 'main');
  const sum = main.body[0].value;
  assert.equal(sum.kind, 'binop');
  assert.equal(sum.type, 'usmallint', "the binop's own type is computable once both sides have one");
  assert.equal(sum.left.kind, 'ref');
  assert.equal(sum.left.type, 'usmallint', "the imported global's declared type");
  assert.equal(sum.right.kind, 'index');
  assert.equal(sum.right.type, 'usmallint', "the imported array's element type");
  assert.equal(sum.right.index.kind, 'call');
  assert.equal(sum.right.index.type, 'utinyint', "the imported function's return type");
});

test('a ref to an imported string<N> variable types as a string — a pointer to its own buffer', async () => {
  const { ir, diagnostics } = await linkWith({
    'main.8bs': [
      'use self::strings::label;',
      'pub fn main() {',
      '    let length: utinyint = label.length;',
      '}',
    ].join('\n'),
    'strings.8bs': 'pub let mut label: string<5> = "HI";',
  });
  assert.deepEqual(diagnostics, []);
  const main = ir.functions.find((f) => f.name === 'main');
  const init = main.body[0].init;
  assert.equal(init.kind, 'stringLength');
  assert.equal(init.string.kind, 'ref');
  assert.equal(init.string.type, 'string');
});
