// Strings on top of arrays: `const LABEL: string = "..."` names constant
// text (inlined like a number const, a slot in the string table), and
// `let name: string<N>` is text that changes — N characters of RAM behind
// a length byte, the shape a literal has, so it goes wherever a `string`
// goes. Assignment copies at runtime, cut to N; a literal is checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze, link, tokenize, parse, lower } from '../index.mjs';

const diagnosticsOf = (src) => analyze(src, 't.8bs');
const messages = (src) => diagnosticsOf(src).map((d) => `${d.code} ${d.message}`);
const clean = (src) => assert.deepEqual(messages(src), []);
const lowered = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't', src);
};

async function linkWith(files, entry = 'main.8bs') {
  const dir = await mkdtemp(join(tmpdir(), '8bs-strvar-'));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    return link(files[entry], join(dir, entry));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TEXT = 'export namespace text {\n function print(cell: usmallint, s: string): void { }\n function printNumber(cell: usmallint, value: usmallint, width: utinyint): void { }\n}\n';

// ---- string consts -------------------------------------------------------------

test('a string const is a slot in the string table, inlined where it is read', () => {
  const { ir, diagnostics } = lowered(`const LABEL: string = "READY";\nlet n: utinyint = 0;\n${TEXT}export function main(): void { text.print(0, LABEL); n = LABEL.length + LABEL[1]; }`);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.globals.map((g) => g.name), ['n']);
  assert.deepEqual(ir.consts, [{ name: 'LABEL', type: 'string', string: 0, exported: false, start: 6, length: 5 }]);
  const [print, assign] = ir.functions[2].body;
  assert.deepEqual(print.args[1], { kind: 'string', index: 0, type: 'string', start: 261, length: 5 });
  assert.equal(assign.value.left.kind, 'stringLength');
  assert.equal(assign.value.left.string.kind, 'string');
  assert.equal(assign.value.right.kind, 'stringByte');
});

test('a string const needs a literal, has no capacity, and cannot be assigned (8BS1031 once)', () => {
  assert.match(messages('const L: string = 5;\nexport function main(): void { }')[0], /needs a string literal: const NAME: string = "\.\.\."/);
  assert.match(messages('const L: string<4> = "HI";\nexport function main(): void { }')[0], /a const string is written `const NAME: string = "\.\.\."`/);
  assert.deepEqual(messages('const L: string = "HI";\nexport function main(): void { L = "NO"; }'),
    ["8BS1031 'L' is a const — a compile-time value with no storage — and cannot be assigned"]);
  assert.match(messages('const L: string = "HI";\nlet n: utinyint = L;\nexport function main(): void { }')[0], /8BS3001/);
});

test('a string const keeps the portable-character and length rules a literal has', () => {
  // Lower case is portable (packages/pet/src/text.8bs); '~' is not, on any target.
  assert.deepEqual(diagnosticsOf('const L: string = "hi";\nexport function main(): void { }').map((d) => d.code), []);
  assert.deepEqual(diagnosticsOf('const L: string = "h~";\nexport function main(): void { }').map((d) => d.code), ['8BS1026']);
});

// ---- string<N> variables --------------------------------------------------------

test('a string<N> is N+1 bytes of RAM: a length byte then the characters, starting empty or as a literal', () => {
  const { ir, diagnostics } = lowered('let name: string<4>;\nlet greeting: string<8> = "HI";\nexport function main(): void { }');
  assert.deepEqual(diagnostics, []);
  const [name, greeting] = ir.globals;
  assert.deepEqual({ type: name.type, array: name.array, stringCapacity: name.stringCapacity, init: name.init },
    { type: 'utinyint', array: 5, stringCapacity: 4, init: [0, 0, 0, 0, 0] });
  assert.deepEqual(greeting.init, [2, 72, 73, 0, 0, 0, 0, 0, 0]);
});

test('the capacity is a literal or a const, 1..255; a literal that does not fit is 8BS1027', () => {
  clean('const WIDTH: utinyint = 8;\nlet name: string<WIDTH>;\nexport function main(): void { }');
  assert.match(messages('let name: string;\nexport function main(): void { }')[0], /needs a capacity: let name: string<N>/);
  assert.match(messages('let name: string<0>;\nexport function main(): void { }')[0], /1\.\.255, not 0/);
  assert.match(messages('let name: string<300>;\nexport function main(): void { }')[0], /1\.\.255, not 300/);
  assert.deepEqual(messages('let name: string<4> = "PLAYER";\nexport function main(): void { }'),
    ['8BS1027 "PLAYER" is 6 characters and does not fit in string<4>']);
  assert.match(messages('let name: string<4> = 5;\nexport function main(): void { }')[0], /starts as a string literal, or empty/);
  assert.match(messages('@address(0x0400) let name: string<4>;\nexport function main(): void { }')[0], /not mapped with @address/);
});

test('assigning a string<N> is a copy cut to N; a literal is checked at compile time; a number is refused', () => {
  const src = 'const L: string = "GO";\nlet a: string<4>;\nlet b: string<8> = "PLAYER";\nfunction f(s: string): void { a = s; }\nexport function main(): void { a = "HI"; a = L; a = b; }';
  const { ir, diagnostics } = lowered(src);
  assert.deepEqual(diagnostics, []);
  const [lit, konst, other] = ir.functions[1].body;
  assert.deepEqual(lit, { kind: 'stringCopy', target: { kind: 'ref', name: 'a', start: src.indexOf('a = "HI"'), length: 1 }, source: { kind: 'string', index: 1, type: 'string', start: src.indexOf('"HI"'), length: 4 }, capacity: 4, start: src.indexOf('a = "HI"'), length: 1 });
  assert.equal(konst.source.kind, 'string');
  assert.deepEqual(other.source, { kind: 'ref', name: 'b', type: 'string', start: src.lastIndexOf('b;'), length: 1 });
  assert.equal(ir.functions[0].body[0].source.name, 's', 'a string parameter is a source too');

  assert.deepEqual(messages('let a: string<4>;\nexport function main(): void { a = "TOO LONG"; }'), ['8BS1027 "TOO LONG" is 8 characters and does not fit in string<4>']);
  assert.match(messages('let a: string<4>;\nexport function main(): void { a = 5; }')[0], /assigned a string — a literal, a const, a parameter, or another string variable/);
  assert.match(messages('let a: string<4>;\nlet n: utinyint = 0;\nexport function main(): void { a = n; }')[0], /assigned a string/);
  assert.match(messages('let a: string<4>;\nexport function main(): void { a += "X"; }')[0], /assigned whole \(s = \.\.\.\); there is no string arithmetic/);
  assert.match(messages('let a: string<4>;\nexport function main(): void { a[0] = 65; }')[0], /assigned whole \(a = "\.\.\."\), not one character at a time/);
});

test('name.length and name[i] read a string<N> at runtime, and a field sizes itself from .length', () => {
  const { ir, diagnostics } = lowered('let a: string<4> = "HI";\nlet n: utinyint = 0;\nexport function main(): void { n = a.length + a[1]; }');
  assert.deepEqual(diagnostics, []);
  const { left, right } = ir.functions[0].body[0].value;
  assert.deepEqual(left, { kind: 'stringLength', string: { kind: 'ref', name: 'a', type: 'string', start: 81, length: 1 }, type: 'utinyint' });
  assert.equal(right.kind, 'stringByte');
  clean(`let a: string<4>;\n${TEXT}export function main(): void { text.print(0, \`LEN \${a.length}\`); text.print(6, a); }`);
});

// ---- across modules --------------------------------------------------------------

test('an imported string const and string<N>: inlined, copied, measured, and indexed by the linker', async () => {
  const lib = 'export const LABEL: string = "READY";\nexport let name: string<8> = "HI";\nexport function reset(): void { name = LABEL; }\n';
  const { ir, diagnostics } = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'import { LABEL, name, reset } from "./lib.8bs";\nlet n: utinyint = 0;\nlet mine: string<4>;\nfunction show(s: string): void { n = s.length; }\nexport function main(): void { name = "PLAYER"; mine = name; show(name); show(LABEL); n = name.length + LABEL.length + name[0] + LABEL[1]; reset(); }\n',
  });
  assert.deepEqual(diagnostics, []);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.equal(main.body[0].kind, 'stringCopy');
  assert.equal(main.body[0].capacity, 8);
  assert.equal(main.body[1].capacity, 4);
  assert.equal(main.body[3].args[0].kind, 'string', 'the imported const is its slot');
  const sum = main.body[4].value;
  assert.equal(sum.left.left.left.kind, 'stringLength');
  assert.equal(sum.left.left.right.kind, 'stringLength');
  assert.equal(sum.left.right.kind, 'stringByte');
  assert.equal(sum.right.kind, 'stringByte');
  assert.equal(sum.right.string.kind, 'string');
});

test('the linker applies the same rules to an imported string<N>: fits, is a string, is assigned whole', async () => {
  const lib = 'export let name: string<4>;\nexport const LABEL: string = "TOO LONG";\n';
  const { diagnostics } = await linkWith({
    'lib.8bs': lib,
    'main.8bs': 'import { name, LABEL } from "./lib.8bs";\nlet n: utinyint = 0;\nexport function main(): void { name = "PLAYER"; name = LABEL; name = 5; name = n; name[0] = 1; LABEL = "X"; }\n',
  });
  assert.deepEqual(diagnostics.map((d) => `${d.code} ${d.message}`), [
    '8BS1027 "PLAYER" is 6 characters and does not fit in string<4>',
    '8BS1027 "TOO LONG" is 8 characters and does not fit in string<4>',
    "8BS3001 'name' is a string<4>: it is assigned a string, not a number",
    "8BS3001 'name' is a string<4>: it is assigned a string — a literal, a const, a parameter, or another string variable",
    '8BS3001 a string is assigned whole (name = "..."), not one character at a time',
    "8BS1031 'LABEL' is a const — a compile-time value with no storage — and cannot be assigned",
  ]);
  // A const's text is known to the linker, so it gets the same check a
  // literal does; only a parameter or another string<N> is cut at runtime.
});

test('a string const cannot initialize a number global', async () => {
  const { diagnostics } = await linkWith({
    'lib.8bs': 'export const LABEL: string = "HI";\n',
    'main.8bs': 'import { LABEL } from "./lib.8bs";\nlet n: utinyint = LABEL;\nexport function main(): void { }\n',
  });
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001']);
  assert.match(diagnostics[0].message, /'LABEL' is a string const; it cannot initialize a utinyint/);
});

// ---- copies on the IR -----------------------------------------------------------------

test('a string assignment lowers to a stringCopy; a program that only reads one has none', async () => {
  const { ir } = await linkWith({
    'main.8bs': 'const L: string = "GO";\nlet a: string<4>;\nlet n: utinyint = 0;\nexport function main(): void { a = L; n = a.length + a[0]; }\n',
  });
  const a = ir.globals.find((g) => g.name === 'a');
  assert.deepEqual({ type: a.type, array: a.array, stringCapacity: a.stringCapacity, init: a.init },
    { type: 'utinyint', array: 5, stringCapacity: 4, init: [0, 0, 0, 0, 0] });
  const main = ir.functions.find((f) => f.name === 'main');
  assert.equal(main.body[0].kind, 'stringCopy');
  assert.equal(main.body[0].capacity, 4);
  assert.equal(main.body[0].source.kind, 'string');
  assert.equal(main.body[1].value.left.kind, 'stringLength');
  assert.equal(main.body[1].value.right.kind, 'stringByte');

  const none = await linkWith({ 'main.8bs': 'let a: string<4> = "HI";\nlet n: utinyint = 0;\nexport function main(): void { n = a.length; }\n' });
  const noneMain = none.ir.functions.find((f) => f.name === 'main');
  assert.ok(!noneMain.body.some((s) => s.kind === 'stringCopy'));
});

test('a string cannot be assigned to, or initialize, a number', () => {
  assert.deepEqual(messages('const L: string = "HI";\nlet n: utinyint = 0;\nexport function main(): void { n = "A"; n = L; let m: utinyint = L; }'), [
    "8BS3001 'n' is not a string: a string is assigned to a string<N>",
    "8BS3001 'n' is not a string: a string is assigned to a string<N>",
    '8BS3001 a string cannot initialize a utinyint: a string lives in a string<N> or a const',
  ]);
});

test('an imported string const into a number global or local is refused by the linker', async () => {
  const { diagnostics } = await linkWith({
    'lib.8bs': 'export const LABEL: string = "HI";\n',
    'main.8bs': 'import { LABEL } from "./lib.8bs";\nlet n: utinyint = 0;\nexport function main(): void { n = LABEL; let m: utinyint = LABEL; }\n',
  });
  assert.deepEqual(diagnostics.map((d) => `${d.code} ${d.message}`), [
    "8BS3001 'n' is not a string: a string is assigned to a string<N>",
    '8BS3001 a string cannot initialize a utinyint: a string lives in a string<N> or a const',
  ]);
});
