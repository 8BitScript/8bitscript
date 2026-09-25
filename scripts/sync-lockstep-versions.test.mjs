import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every packages/* version matches packages/cli', () => {
  const result = spawnSync(process.execPath, ['scripts/sync-lockstep-versions.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    [result.stderr, result.stdout].filter(Boolean).join('\n') || 'sync-lockstep --check failed',
  );
});
