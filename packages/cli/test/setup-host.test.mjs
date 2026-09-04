import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isDirOnPath, hasBinaryOnPath, resolveOnPath, hasXcodeCommandLineTools, installXcodeCommandLineTools,
} from '../src/setup/host.mjs';

test('isDirOnPath: exact entry match, trailing slash tolerated, empty PATH is false', () => {
  assert.equal(isDirOnPath('/usr/local/bin', { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin' }), true);
  assert.equal(isDirOnPath('/usr/local/bin', { PATH: '/usr/local/bin/:/usr/bin' }), true);
  assert.equal(isDirOnPath('/usr/local/bin', { PATH: '/usr/local/binary:/usr/bin' }), false);
  assert.equal(isDirOnPath('/usr/local/bin', { PATH: '' }), false);
  assert.equal(isDirOnPath('/usr/local/bin', {}), false);
});

test('hasBinaryOnPath / resolveOnPath: walk PATH entries in order', () => {
  const scratch = mkdtempSync(join(tmpdir(), '8bs-host-test-'));
  try {
    const a = join(scratch, 'a');
    const b = join(scratch, 'b');
    mkdirSync(a); mkdirSync(b);
    writeFileSync(join(b, 'x16emu'), '#!/bin/sh\n', { mode: 0o755 });
    const env = { PATH: `${a}:${b}` };
    assert.equal(hasBinaryOnPath('x16emu', env, 'darwin'), true);
    assert.equal(resolveOnPath('x16emu', env, 'darwin'), join(b, 'x16emu'));
    assert.equal(hasBinaryOnPath('makecart', env, 'darwin'), false);
    assert.equal(resolveOnPath('makecart', env, 'darwin'), null);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('hasXcodeCommandLineTools: `xcode-select -p` exit 0 means installed; non-zero or missing means not', async () => {
  const calls = [];
  const exec = (code, missing = false) => async (cmd, args) => { calls.push([cmd, args]); return { code, missing, stdout: '', stderr: '' }; };
  assert.equal(await hasXcodeCommandLineTools(exec(0)), true);
  assert.equal(await hasXcodeCommandLineTools(exec(2)), false);
  assert.equal(await hasXcodeCommandLineTools(exec(null, true)), false);
  assert.deepEqual(calls[0], ['xcode-select', ['-p']]);
});

test('installXcodeCommandLineTools: runs `xcode-select --install` (never under sudo)', async () => {
  let seen = null;
  await installXcodeCommandLineTools(async (cmd, args) => { seen = [cmd, args]; return { code: 0 }; });
  assert.deepEqual(seen, ['xcode-select', ['--install']]);
});
