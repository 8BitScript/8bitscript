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
  const { ir, diagnostics } = irOf('export function main(): void { while (true) { waitFrame(); } }');
  assert.deepEqual(diagnostics, []);
  const loop = ir.functions[0].body[0];
  assert.equal(loop.kind, 'while');
  assert.equal(loop.body[0].kind, 'waitFrame');
  assert.equal(typeof loop.body[0].start, 'number');
});

test('waitFrame() takes no arguments', () => {
  const { diagnostics } = irOf('export function main(): void { waitFrame(1); }');
  assert.deepEqual(diagnostics.map((d) => [d.code, d.message]), [['8BS3001', 'waitFrame() takes no arguments']]);
});

test('waitFrame() returns nothing and is not an expression', () => {
  const { diagnostics } = irOf('let x: u8 = 0;\nexport function main(): void { x = waitFrame(); }');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001']);
  assert.match(diagnostics[0].message, /does not return a value/);
});

test('a program using waitFrame() links with no unresolved name', () => {
  const { ir, diagnostics } = link('export function main(): void { waitFrame(); }', '/t/main.8bs');
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.functions[0].body[0].kind, 'waitFrame');
});

// ---- the entry rule -----------------------------------------------------------

test('the entry module\'s one exported function is the program, under any name', () => {
  assert.equal(link('export function main(): void {}', '/t/main.8bs').ir.entry, 'main');
  assert.equal(link('export function start(): void {}', '/t/main.8bs').ir.entry, 'start');
  assert.equal(link('export function update(): void {}\nfunction helper(): void {}', '/t/main.8bs').ir.entry, 'update');
});

test('two exported functions in the entry module is 8BS2010, once per function', () => {
  const { ir, diagnostics } = link('export function main(): void {}\nexport function frame(): void {}', '/t/main.8bs');
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2010', '8BS2010']);
  assert.match(diagnostics[0].message, /'main' is one of 2/);
  assert.match(diagnostics[1].message, /'frame' is one of 2/);
});

test('an exported global or namespace in the entry module is 8BS2010', () => {
  assert.deepEqual(linkCodes('export let x: u8 = 1;\nexport function main(): void {}'), ['8BS2010']);
  assert.deepEqual(
    linkCodes('export namespace n { const k: u8 = 1; }\nexport function main(): void {}'),
    ['8BS2010'],
  );
});

test('an entry module exporting nothing is 8BS2010', () => {
  const { diagnostics } = link('function main(): void {}', '/t/main.8bs');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2010']);
  assert.match(diagnostics[0].message, /exports nothing/);
});

test('an entry point with parameters is 8BS2010', () => {
  const { diagnostics } = link('export function main(n: u8): void {}', '/t/main.8bs');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2010']);
  assert.match(diagnostics[0].message, /must take no parameters/);
});

test('the diagnostic points at the offending name', () => {
  const src = 'export let x: u8 = 1;\nexport function main(): void {}';
  const [d] = link(src, '/t/main.8bs').diagnostics;
  assert.equal(src.slice(d.start, d.start + d.length), 'x');
});

test('library modules may export whatever they like', () => {
  // Only the entry is held to one export; a package exports many.
  const entryOnly = link('export function main(): void {}', '/t/main.8bs');
  assert.deepEqual(entryOnly.diagnostics, []);
});

// ---- entryOf: the same rule for IR that never went through the linker ----------

test('entryOf reads ir.entry from linked IR and falls back to the sole export otherwise', () => {
  assert.equal(entryOf(link('export function go(): void {}', '/t/main.8bs').ir), 'go');
  assert.equal(entryOf(irOf('export function main(): void {}').ir), 'main');
  assert.equal(entryOf(irOf('export function main(): void {}\nexport function f(): void {}').ir), null);
  assert.equal(entryOf(irOf('function main(): void {}').ir), null);
});

// ---- reserved name and hover ---------------------------------------------------

test('declaring or importing "waitFrame" is 8BS2009 with the right wording', () => {
  for (const src of [
    'function waitFrame(): void {}',
    'let waitFrame: u8 = 1;',
    'import { waitFrame } from "./x.8bs";',
    'function f(waitFrame: u8): void {}',
  ]) {
    const [d] = analyze(src, 't.8bs');
    assert.equal(d.code, '8BS2009', src);
    assert.match(d.message, /frame wait, waitFrame\(\)/);
  }
  // And frames' wording did not regress.
  assert.match(analyze('let frames: u8 = 1;', 't.8bs')[0].message, /duration clock, frames\(\.\.\., seconds\)/);
});

test('hover explains waitFrame()', () => {
  const text = 'export function main(): void { while (true) { waitFrame(); } }';
  const info = getHoverInfo(text, text.indexOf('waitFrame') + 3);
  assert.ok(info);
  assert.match(info.markdown, /Blocks until the next logical frame/);
  assert.match(info.markdown, /frameRate/);
  assert.match(info.markdown, /waitvsync/);
});
