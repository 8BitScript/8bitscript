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
