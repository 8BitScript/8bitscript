import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startupBytes } from './commodore.ts';

test('startupBytes: RTS, and nothing else — no lowering exists yet to run into', () => {
  assert.deepEqual([...startupBytes()], [0x60]);
});
