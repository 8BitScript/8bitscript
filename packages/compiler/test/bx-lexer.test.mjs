import assert from 'node:assert/strict';
import test from 'node:test';

import { TokenKind, tokenize } from '../index.mjs';

test('in .8bx, comparison and shift operators keep their .8bs meaning', () => {
  const src = 'let ok: bool = a < b;\nlet n: u8 = x << 2;\nlet t: array<u8, 4>;';
  const { tokens, diagnostics } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  assert.deepEqual(diagnostics, []);
  const lt = tokens.find((t) => t.text === '<' && tokens[tokens.indexOf(t) + 1]?.text !== '<');
  const shift = tokens.find((t) => t.text === '<<');
  assert.ok(lt);
  assert.ok(shift);
});

test('`component` is a keyword in .8bx and an ordinary name in .8bs (spec §129: .8bs unchanged)', () => {
  const bs = tokenize('let component: u8 = 1;', 't.8bs', { sourceKind: '.8bs' });
  assert.deepEqual(bs.diagnostics, []);
  assert.equal(bs.tokens.find((t) => t.text === 'component').kind, TokenKind.Identifier);
  const bx = tokenize('component Foo() { }', 't.8bx', { sourceKind: '.8bx' });
  assert.equal(bx.tokens.find((t) => t.text === 'component').kind, TokenKind.Keyword);
  // No source kind at all is .8bs.
  assert.equal(tokenize('let component: u8 = 1;', 't.8bs').tokens.find((t) => t.text === 'component').kind, TokenKind.Identifier);
});
