import assert from 'node:assert/strict';
import test from 'node:test';

import { NodeType, parse, tokenize } from '../index.mjs';

test('parses brace attribute values on elements', () => {
  const src = 'component Hud(score: usmallint, over: bool) { }\nexport function main(): void { <Hud score={score} over={over} />; }\n';
  const { tokens } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  const { diagnostics } = parse(tokens, src, 't.8bx', { sourceKind: '.8bx' });
  assert.equal(diagnostics.filter((d) => d.code === '8BS1039' || d.code === '8BS1101').length, 0);
});

test('parses a self-closing element in .8bx', () => {
  const src = 'component Foo() { }\n<Foo />;\n';
  const { tokens } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  const { ast, diagnostics } = parse(tokens, src, 't.8bx', { sourceKind: '.8bx' });
  assert.deepEqual(diagnostics, []);
  const el = ast.body.find((s) => s.type === NodeType.BxElement);
  assert.equal(el?.name, 'Foo');
  assert.equal(el?.selfClosing, true);
});

test('`export component` parses, and the declaration says so', () => {
  const src = 'export component Foo(x: utinyint = 1) { }\ncomponent Bar() { }\n';
  const { tokens } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  const { ast, diagnostics } = parse(tokens, src, 't.8bx', { sourceKind: '.8bx' });
  assert.deepEqual(diagnostics, []);
  const [foo, bar] = ast.body;
  assert.equal(foo.type, NodeType.ComponentDeclaration);
  assert.equal(foo.exported, true);
  assert.equal(foo.params[0].defaultValue?.value, 1);
  assert.equal(bar.exported, false);
});

test('`let component` still parses in .8bs', () => {
  const src = 'let component: u8 = 1;\nexport function main(): void { component = 2; }\n';
  const { tokens } = tokenize(src, 't.8bs');
  const { diagnostics } = parse(tokens, src, 't.8bs');
  assert.deepEqual(diagnostics, []);
});
