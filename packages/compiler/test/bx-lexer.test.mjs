import assert from 'node:assert/strict';
import test from 'node:test';

import { tokenize } from '../index.mjs';

test('in .8bx, comparison and shift operators keep their .8bs meaning', () => {
  const src = 'let ok: bool = a < b;\nlet n: u8 = x << 2;\nlet t: array<u8, 4>;';
  const { tokens, diagnostics } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  assert.deepEqual(diagnostics, []);
  const lt = tokens.find((t) => t.text === '<' && tokens[tokens.indexOf(t) + 1]?.text !== '<');
  const shift = tokens.find((t) => t.text === '<<');
  assert.ok(lt);
  assert.ok(shift);
});
