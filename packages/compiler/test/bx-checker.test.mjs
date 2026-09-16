import assert from 'node:assert/strict';
import test from 'node:test';

import { Codes, analyze } from '../index.mjs';

test('unknown component is 8BS2012', () => {
  const src = '<Missing />;\nexport function main(): void { }\n';
  const codes = analyze(src, 't.8bx', { sourceKind: '.8bx' }).map((d) => d.code);
  assert.ok(codes.includes(Codes.BX_UNKNOWN_COMPONENT));
});
