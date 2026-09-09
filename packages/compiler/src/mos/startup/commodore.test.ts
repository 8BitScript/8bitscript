import { test } from 'node:test';
import assert from 'node:assert/strict';

import { epilogue } from './commodore.ts';

test('epilogue: RTS, and nothing else — no prologue exists yet to need one', () => {
  assert.deepEqual(epilogue(), [{ kind: 'instruction', mnemonic: 'RTS', mode: 'implied' }]);
});
