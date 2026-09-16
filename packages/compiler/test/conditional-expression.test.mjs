import assert from 'node:assert/strict';
import test from 'node:test';

import { NodeType, parse, tokenize } from '../index.mjs';

test('parses a ternary expression', () => {
  const src = 'let x: u8 = true ? 1 : 2;\n';
  const { tokens } = tokenize(src, 't.8bs');
  const { ast, diagnostics } = parse(tokens, src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  const decl = ast.body[0];
  assert.equal(decl.initializer?.type, NodeType.ConditionalExpression);
});
