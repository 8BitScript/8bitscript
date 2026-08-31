// Unit tests for the doctor's pure helpers. The full command shells out to
// real toolchains, so its branches are exercised against fakes by hand; what
// must never regress silently is the version arithmetic these checks stand on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseVersion, atLeast, findLocalBin } from '../src/doctor.mjs';

test('parseVersion finds the first dotted version', () => {
  assert.deepEqual(parseVersion('pnpm 12.1.0'), [12, 1, 0]);
  assert.deepEqual(parseVersion('v26.7.0'), [26, 7, 0]);
  assert.deepEqual(parseVersion('xvic (VICE 3.10)'), [3, 10, 0]);
  assert.deepEqual(parseVersion('git version 2.55.0'), [2, 55, 0]);
  assert.deepEqual(parseVersion('clang version 19.0.0 (llvm-mos)'), [19, 0, 0]);
  assert.equal(parseVersion('no digits here'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
});

test('atLeast compares componentwise', () => {
  assert.ok(atLeast([26, 7, 0], [26]));
  assert.ok(atLeast([12, 1, 0], [12]));
  assert.ok(atLeast([2, 55, 0], [2, 30]));
  assert.ok(atLeast([3, 10, 0], [3, 10]));
  assert.ok(!atLeast([3, 9, 0], [3, 10]));
  assert.ok(!atLeast([24, 20, 0], [26]));
  // 3.10 is not 3.1: components are numbers, not decimals.
  assert.ok(atLeast([3, 10, 0], [3, 2]));
});

test('findLocalBin walks upward and stops at the root', () => {
  const scratch = mkdtempSync(join(tmpdir(), '8bs-doctor-test-'));
  try {
    const bin = join(scratch, 'node_modules', '.bin');
    mkdirSync(join(scratch, 'deep', 'nested'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'asc'), '', { mode: 0o755 });
    assert.equal(findLocalBin(join(scratch, 'deep', 'nested'), 'asc'), join(bin, 'asc'));
    assert.equal(findLocalBin(scratch, 'no-such-tool'), null);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
