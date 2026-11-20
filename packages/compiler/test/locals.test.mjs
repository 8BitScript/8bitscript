// Local variables and `for` loops. A local is storage that exists while
// its function runs (the target's own stack or registers); it is
// block-scoped, as in C, and shadows a global, const, or array of the
// same name. A `for` keeps its initializer, test, and update, so
// `continue` still runs the update.
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
  const dir = await mkdtemp(join(tmpdir(), '8bs-local-'));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    return link(files[entry], join(dir, entry));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- locals -------------------------------------------------------------------

test('a local lowers to a local statement; left uninitialized it starts at 0', () => {
  const { ir, diagnostics } = lowered('pub fn main() {\n    let n: utinyint = 5;\n    let mut m: usmallint;\n    m = n;\n}');
  assert.deepEqual(diagnostics, []);
  const [n, m, assign] = ir.functions[0].body;
  assert.deepEqual(n, { kind: 'local', name: 'n', type: 'utinyint', init: { kind: 'const', value: 5, type: 'utinyint' }, start: 24, length: 1 });
  assert.deepEqual(m.init, { kind: 'const', value: 0, type: 'usmallint' });
  assert.equal(assign.kind, 'assign');
});

test('a local initializer is any expression, and its literal gets the range rule', () => {
  clean('let g: utinyint = 1;\npub fn main() {\n    let n: utinyint = g + 1;\n}');
  assert.deepEqual(codes('pub fn main() {\n    let n: utinyint = 300;\n}'), ['8BS1021']);
});

test('a local is an integer or bool: no const, string, array, or @address inside a function', () => {
  assert.match(diagnosticsOf('pub fn main() {\n    const N: utinyint = 1;\n}')[0].message, /a const is a compile-time value declared at the top level/);
  assert.match(diagnosticsOf('pub fn main() {\n    let s: string;\n}')[0].message, /a local of type string is not compilable yet/);
  assert.match(diagnosticsOf('pub fn main() {\n    let a: [utinyint; 4];\n}')[0].message, /a local array is not compilable yet/);
  assert.match(diagnosticsOf('pub fn main() {\n    #[address(0xD020)] let b: utinyint;\n}')[0].message, /belongs on a top-level declaration/);
  assert.match(diagnosticsOf('pub fn main() {\n    let b = 1;\n}')[0].message, /needs an explicit type/);
});

test('a local shadows a const, an array, or a global of the same name, and only inside its block', () => {
  const src = 'const MAX: utinyint = 4;\nlet mut hp: [utinyint; 2];\nlet mut g: utinyint = 0;\npub fn main() {\n    {\n        let mut MAX: utinyint = 9;\n        MAX = MAX + 1;\n        g = MAX;\n    }\n    g = MAX;\n    {\n        let mut hp: utinyint = 1;\n        hp = 2;\n    }\n    hp[0] = 1;\n    {\n        let g: utinyint = 3;\n    }\n    g = 5;\n}';
  const { ir, diagnostics } = lowered(src);
  assert.deepEqual(diagnostics, [], 'assigning to the local MAX is not assigning to the const');
  const body = ir.functions[0].body;
  assert.deepEqual(body[0].body[1].value.left, { kind: 'ref', name: 'MAX', type: 'utinyint', start: src.indexOf('MAX + 1'), length: 3 });
  assert.deepEqual(body[1].value, { kind: 'const', value: 4, type: 'utinyint' }, 'outside the block, MAX is the const again');
  assert.equal(body[3].kind, 'storeIndex', 'outside the block, hp is the array again');
});

test('the checker sees a local shadow too: no 8BS1031 for a local named after a const — only the case rule', () => {
  assert.deepEqual(codes('const MAX: utinyint = 4;\npub fn main() {\n    let mut MAX: utinyint = 1;\n    MAX += 1;\n}'), ['8BS1034']);
});

test('a template field sizes itself from a local', () => {
  clean('pub mod text {\n    fn print(cell: usmallint, s: string) {\n    }\n    fn printNumber(cell: usmallint, value: usmallint, width: utinyint) {\n    }\n}\npub fn main() {\n    let n: usmallint = 7;\n    text::print(0, `N ${n}`);\n}');
});

// ---- for ------------------------------------------------------------------------

test('for lowers to a for with an initializer, test, and update; each may be left off', () => {
  const { ir, diagnostics } = lowered('let mut g: utinyint = 0;\npub fn main() {\n    for i: utinyint in 0..4 {\n        g = i;\n    }\n    for (g = 0; g < 2; g += 1) {\n    }\n    for (; ; ) {\n        break;\n    }\n}');
  assert.deepEqual(diagnostics, []);
  const [a, b, c] = ir.functions[0].body;
  assert.equal(a.kind, 'for');
  assert.equal(a.init.kind, 'local');
  assert.equal(a.test.kind, 'binop');
  assert.equal(a.update.kind, 'assign');
  assert.equal(a.body[0].kind, 'assign');
  assert.equal(b.init.kind, 'assign');
  assert.deepEqual([c.init, c.test, c.update], [null, null, null]);
});

test('a for initializer or update is an assignment, ++/--, or a call', () => {
  assert.match(diagnosticsOf('pub fn main() {\n    for (1; ; ) {\n    }\n}')[0].message, /a for initializer is an assignment, \+\+\/--, or a call/);
  assert.match(diagnosticsOf('let g: utinyint = 0;\npub fn main() {\n    for (; ; g) {\n    }\n}')[0].message, /a for update is an assignment/);
});

test("the loop variable is scoped to the loop: after it, the name is the outer one again", async () => {
  const { ir, diagnostics } = await linkWith({
    'main.8bs': 'let i: utinyint = 7;\nlet mut g: utinyint = 0;\npub fn main() {\n    for i: utinyint in 0..2 {\n        g = i;\n    }\n    g = i;\n}\n',
  });
  assert.deepEqual(diagnostics, []);
  const [loop, after] = ir.functions.find((f) => f.name === 'main').body;
  assert.equal(loop.kind, 'for');
  assert.equal(loop.init.name, 'i');
  assert.deepEqual(loop.test.right, { kind: 'const', value: 2, type: 'utinyint' });
  assert.equal(loop.body[0].target, 'g');
  assert.equal(loop.body[0].value.name, 'i');
  assert.equal(after.target, 'g');
  assert.equal(after.value.name, 'i');
});

test('a name declared only inside a block is not visible after it — the linker reports it', async () => {
  const { diagnostics } = await linkWith({
    'main.8bs': 'let mut g: utinyint = 0;\npub fn main() {\n    if g == 0 {\n        let n: utinyint = 1;\n        g = n;\n    }\n    g = n;\n}\n',
  });
  assert.deepEqual(diagnostics.map((d) => `${d.code} ${d.message}`), ["8BS2007 cannot find name 'n'"]);
});

test('a local shadows an import of the same name inside its block', async () => {
  const { ir, diagnostics } = await linkWith({
    'lib.8bs': 'pub let mut hp: [utinyint; 2];\npub const MAX: utinyint = 4;\n',
    'main.8bs': 'use self::lib::{hp, MAX};\nlet mut g: utinyint = 0;\npub fn main() {\n    {\n        let hp: utinyint = 1;\n        g = hp;\n    }\n    hp[0] = 1;\n    g = MAX;\n}\n',
  });
  assert.deepEqual(diagnostics, []);
  const [block, store, assign] = ir.functions.find((f) => f.name === 'main').body;
  assert.equal(block.body[0].kind, 'local');
  assert.equal(block.body[0].name, 'hp');
  assert.equal(block.body[1].target, 'g');
  assert.equal(block.body[1].value.name, 'hp');
  assert.equal(store.kind, 'storeIndex');
  assert.deepEqual(assign.value, { kind: 'const', type: 'utinyint', value: 4 });
});

test('a for over an array length folds the bound, keeps continue, and writes the local', async () => {
  const { ir } = await linkWith({
    'main.8bs': 'let hp: [usmallint; 4];\nlet mut total: usmallint = 0;\npub fn main() {\n    let mut sum: usmallint = 0;\n    for i: utinyint in 0..hp.length {\n        if i == 2 {\n            continue;\n        }\n        sum += hp[i];\n    }\n    total = sum;\n}\n',
  });
  const [sum, loop, total] = ir.functions.find((f) => f.name === 'main').body;
  assert.equal(sum.kind, 'local');
  assert.equal(sum.type, 'usmallint');
  assert.equal(loop.kind, 'for');
  assert.deepEqual(loop.test.right, { kind: 'const', value: 4, type: 'utinyint' });
  assert.equal(loop.body[0].then[0].kind, 'continue');
  assert.equal(loop.body[1].kind, 'assign');
  assert.equal(loop.body[1].value.operator, '+');
  assert.equal(total.target, 'total');
});

test('a waitFrame() inside a for is still a waitFrame statement', async () => {
  const { ir } = await linkWith({
    'main.8bs': 'pub fn main() {\n    for i: utinyint in 0..4 {\n        waitFrame();\n    }\n}\n',
  });
  const loop = ir.functions.find((f) => f.name === 'main').body[0];
  assert.equal(loop.kind, 'for');
  assert.equal(loop.body[0].kind, 'waitFrame');
});

test('one declaration per name per block: a second let, or a let over a parameter, is a diagnostic here, not from the C compiler', () => {
  const d = analyze('pub fn main() {\n    let y: utinyint = 1;\n    let y: utinyint = 2;\n    {\n        let y: utinyint = 3;\n    }\n}\nfn f(x: utinyint) {\n    let x: utinyint = 1;\n}', 't.8bs');
  assert.deepEqual(d.map((x) => `${x.code} ${x.message}`), [
    "8BS3001 'y' is already declared in this block",
    "8BS3001 'x' is already declared in this block",
  ]);
});
