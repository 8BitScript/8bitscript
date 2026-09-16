import assert from 'node:assert/strict';
import test from 'node:test';

import { SymbolKind, bind, parse, tokenize } from '../index.mjs';

test('binds a component symbol in .8bx', () => {
  const src = 'component Menu() { }\n';
  const { tokens } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  const { ast } = parse(tokens, src, 't.8bx', { sourceKind: '.8bx' });
  const { symbols } = bind(ast, 't.8bx');
  assert.equal(symbols.get('Menu')?.kind, SymbolKind.Component);
});
