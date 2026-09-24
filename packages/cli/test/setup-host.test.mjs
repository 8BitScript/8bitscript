import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  isDirOnPath, hasBinaryOnPath, resolveOnPath, hasXcodeCommandLineTools, installXcodeCommandLineTools,
  extraHostBinDirs, hostPath, DARWIN_APP_BINARIES,
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

test('extraHostBinDirs: macOS installer home is ~/Library/pnpm, not only the Linux XDG path', () => {
  const home = '/Users/me';
  const dirs = extraHostBinDirs(home, { PATH: '/usr/bin' }, 'darwin');
  assert.ok(dirs.includes(join(home, 'Library', 'pnpm', 'bin')));
  assert.ok(dirs.includes(join(home, 'Library', 'pnpm')));
  assert.ok(dirs.includes(join(home, '.local', 'share', 'pnpm', 'bin')), 'older/XDG installs still count');
  assert.ok(dirs.includes('/opt/homebrew/bin'));
});

test('extraHostBinDirs: linux does not invent a macOS Library path', () => {
  const home = '/home/me';
  const dirs = extraHostBinDirs(home, { PATH: '/usr/bin' }, 'linux');
  assert.equal(dirs.includes(join(home, 'Library', 'pnpm', 'bin')), false);
  assert.ok(dirs.includes(join(home, '.local', 'share', 'pnpm', 'bin')));
});

test('extraHostBinDirs: PNPM_HOME and nvm win over defaults', () => {
  const home = mkdtempSync(join(tmpdir(), '8bs-host-bins-'));
  try {
    const nvmBin = join(home, '.nvm', 'versions', 'node', 'v26.9.0', 'bin');
    mkdirSync(nvmBin, { recursive: true });
    mkdirSync(join(home, '.nvm', 'versions', 'node', 'v26.10.0', 'bin'), { recursive: true });
    const dirs = extraHostBinDirs(home, { PATH: '', PNPM_HOME: '/opt/pnpm', NVM_BIN: '/custom/nvm' }, 'darwin');
    assert.ok(dirs.includes('/opt/pnpm'));
    assert.ok(dirs.includes('/opt/pnpm/bin'));
    assert.ok(dirs.includes('/custom/nvm'));
    assert.ok(dirs.includes(join(home, '.nvm', 'versions', 'node', 'v26.10.0', 'bin')), 'numeric nvm sort picks 26.10 over 26.9');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('hostPath: appends well-known bins after PATH', () => {
  const search = hostPath({ PATH: '/usr/bin' }, '/Users/me', 'darwin');
  assert.ok(search.startsWith(`/usr/bin${delimiter}`));
  assert.ok(search.split(delimiter).includes(join('/Users/me', 'Library', 'pnpm', 'bin')));
});

test('DARWIN_APP_BINARIES: SameBoy and Fuse casks, never the fuse filesystem', () => {
  assert.deepEqual(Object.keys(DARWIN_APP_BINARIES).sort(), ['fuse', 'sameboy']);
  assert.ok(DARWIN_APP_BINARIES.sameboy.every((p) => p.includes('SameBoy.app')));
  assert.ok(DARWIN_APP_BINARIES.fuse.every((p) => p.includes('Fuse.app')));
  assert.equal(resolveOnPath('sameboy', { PATH: '' }, 'linux'), null);
  assert.equal(resolveOnPath('fuse', { PATH: '' }, 'linux'), null);
});
