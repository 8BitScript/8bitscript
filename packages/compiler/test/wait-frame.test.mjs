// `waitFrame()` — block until the next logical frame — and the rule it goes
// with: the entry module exports exactly one function, and that is the
// program. Covers lowering (packages/compiler/src/ir), the linker's entry
// rule and `ir.entry`, `entryOf()`, the reserved name, and hover.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, link, tokenize, parse, lower, entryOf, getHoverInfo,
} from '../index.mjs';

const irOf = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't');
};
const linkCodes = (src) => link(src, '/t/main.8bs').diagnostics.map((d) => d.code);

// ---- lowering ---------------------------------------------------------------

test('waitFrame() lowers to its own IR kind, not a call to a function', () => {
  const { ir, diagnostics } = irOf('pub fn main() {\n    loop {\n        waitFrame();\n    }\n}');
  assert.deepEqual(diagnostics, []);
  const loop = ir.functions[0].body[0];
  assert.equal(loop.kind, 'while');
  assert.equal(loop.body[0].kind, 'waitFrame');
  assert.equal(typeof loop.body[0].start, 'number');
});

test('waitFrame() takes no arguments', () => {
  const { diagnostics } = irOf('pub fn main() {\n    waitFrame(1);\n}');
  assert.deepEqual(diagnostics.map((d) => [d.code, d.message]), [['8BS3001', 'waitFrame() takes no arguments']]);
});

test('waitFrame() returns nothing and is not an expression', () => {
  const { diagnostics } = irOf('let mut x: u8 = 0;\npub fn main() {\n    x = waitFrame();\n}');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001']);
  assert.match(diagnostics[0].message, /does not return a value/);
});

test('a program using waitFrame() links with no unresolved name', () => {
  const { ir, diagnostics } = link('pub fn main() {\n    waitFrame();\n}', '/t/main.8bs');
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.functions[0].body[0].kind, 'waitFrame');
});

// ---- the entry rule -----------------------------------------------------------

test('the entry module\'s one exported function is the program, under any name', () => {
  assert.equal(link('pub fn main() {\n}', '/t/main.8bs').ir.entry, 'main');
  assert.equal(link('pub fn start() {\n}', '/t/main.8bs').ir.entry, 'start');
  assert.equal(link('pub fn update() {\n}\nfn helper() {\n}', '/t/main.8bs').ir.entry, 'update');
});

test('two exported functions in the entry module is 8BS2010, once per function', () => {
  const { ir, diagnostics } = link('pub fn main() {\n}\npub fn frame() {\n}', '/t/main.8bs');
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2010', '8BS2010']);
  assert.match(diagnostics[0].message, /'main' is one of 2/);
  assert.match(diagnostics[1].message, /'frame' is one of 2/);
});

test('an exported global or namespace in the entry module is 8BS2010', () => {
  assert.deepEqual(linkCodes('pub let mut x: u8 = 1;\npub fn main() {\n}'), ['8BS2010']);
  assert.deepEqual(
    linkCodes('pub mod n {\n    const K: u8 = 1;\n}\npub fn main() {\n}'),
    ['8BS2010'],
  );
});

test('an entry module exporting nothing is 8BS2010', () => {
  const { diagnostics } = link('fn main() {\n}', '/t/main.8bs');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2010']);
  assert.match(diagnostics[0].message, /has nothing pub/);
});

test('an entry point with parameters is 8BS2010', () => {
  const { diagnostics } = link('pub fn main(n: u8) {\n}', '/t/main.8bs');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2010']);
  assert.match(diagnostics[0].message, /must take no parameters/);
});

test('the diagnostic points at the offending name', () => {
  const src = 'pub let mut x: u8 = 1;\npub fn main() {\n}';
  const [d] = link(src, '/t/main.8bs').diagnostics;
  assert.equal(src.slice(d.start, d.start + d.length), 'x');
});

test('library modules may export whatever they like', () => {
  // Only the entry is held to one export; a package exports many.
  const entryOnly = link('pub fn main() {\n}', '/t/main.8bs');
  assert.deepEqual(entryOnly.diagnostics, []);
});

// ---- entryOf: the same rule for IR that never went through the linker ----------

test('entryOf reads ir.entry from linked IR and falls back to the sole export otherwise', () => {
  assert.equal(entryOf(link('pub fn go() {\n}', '/t/main.8bs').ir), 'go');
  assert.equal(entryOf(irOf('pub fn main() {\n}').ir), 'main');
  assert.equal(entryOf(irOf('pub fn main() {\n}\npub fn f() {\n}').ir), null);
  assert.equal(entryOf(irOf('fn main() {\n}').ir), null);
});

// ---- reserved name and hover ---------------------------------------------------

test('declaring or importing "waitFrame" is 8BS2009 with the right wording', () => {
  for (const src of [
    'fn waitFrame() {\n}',
    'let waitFrame: u8 = 1;',
    'use self::x::waitFrame;',
    'fn f(waitFrame: u8) {\n}',
  ]) {
    const [d] = analyze(src, 't.8bs');
    assert.equal(d.code, '8BS2009', src);
    assert.match(d.message, /frame wait, waitFrame\(\)/);
  }
  // `frames` is not reserved: `#frames` is its own token.
  assert.deepEqual(analyze('let frames: u8 = 1;', 't.8bs'), []);
});

test('hover explains waitFrame()', () => {
  const text = 'pub fn main() {\n    loop {\n        waitFrame();\n    }\n}';
  const info = getHoverInfo(text, text.indexOf('waitFrame') + 3);
  assert.ok(info);
  assert.match(info.markdown, /Blocks until the next logical frame/);
  assert.match(info.markdown, /frameRate/);
  assert.match(info.markdown, /waitvsync/);
});
