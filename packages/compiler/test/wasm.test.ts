import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from '../src/wasm/index.ts';

const ir = {};

test('build() is not implemented and writes nothing', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-native-'));
  try {
    const outFile = join(scratch, 'out.wasm');
    const result = await build(ir, { outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /not implemented/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
