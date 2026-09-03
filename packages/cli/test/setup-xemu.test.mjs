// Unit tests for building/installing Xemu's MEGA65 core from source — the
// only path this project uses (the AUR xmega65-git package is deliberately
// not depended on). Process and filesystem boundaries are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildXemuMega65, installXemu } from '../src/setup/xemu.mjs';

test('buildXemuMega65: xmega65 missing — a fresh clone, `make` only in targets/mega65, binary found', async () => {
  const calls = [];
  const result = await buildXemuMega65({
    sourceDir: '/cache/xemu',
    repo: 'https://example.invalid/xemu.git',
    exec: async (cmd, args, opts) => { calls.push([cmd, args, opts]); return { code: 0 }; },
    exists: async (p) => p.endsWith('build/bin/xmega65.native'),
    mkdirFn: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.binaryPath, '/cache/xemu/build/bin/xmega65.native');
  const cloneCall = calls.find(([cmd]) => cmd === 'git' && calls[0][1][0] === 'clone');
  assert.ok(cloneCall);
  const makeCall = calls.find(([cmd]) => cmd === 'make');
  assert.equal(makeCall[2].cwd, '/cache/xemu/targets/mega65');
});

test('buildXemuMega65: xmega65 present (already cloned) — pulls instead of re-cloning', async () => {
  const calls = [];
  await buildXemuMega65({
    sourceDir: '/cache/xemu',
    exec: async (cmd, args, opts) => { calls.push([cmd, args, opts]); return { code: 0 }; },
    exists: async () => true,
    mkdirFn: async () => { throw new Error('should not need to mkdir when already cloned'); },
  });
  assert.deepEqual(calls[0], ['git', ['-C', '/cache/xemu', 'pull', '--ff-only'], undefined]);
});

test('buildXemuMega65: a non-zero make exit is a failure (harmless warnings on stderr are not)', async () => {
  const result = await buildXemuMega65({
    sourceDir: '/cache/xemu',
    exec: async (cmd) => (cmd === 'git' ? { code: 0 } : { code: 1 }),
    exists: async () => false,
    mkdirFn: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'make');
});

test('buildXemuMega65: make exits 0 but xmega65.native is missing — still a failure, never named .native downstream', async () => {
  const result = await buildXemuMega65({
    sourceDir: '/cache/xemu',
    exec: async () => ({ code: 0 }),
    exists: async (p) => p.endsWith('.git'),
    mkdirFn: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'make');
});

test('installXemu: installs to /opt/xemu/xmega65 (never named .native) and symlinks /usr/local/bin/xmega65', async () => {
  const calls = [];
  const sudoExec = async (cmd, args) => { calls.push([cmd, args]); return { code: 0 }; };
  const result = await installXemu('/cache/xemu/build/bin/xmega65.native', { sudoExec });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['mkdir', ['-p', '/opt/xemu']],
    ['install', ['-m755', '/cache/xemu/build/bin/xmega65.native', '/opt/xemu/xmega65']],
    ['ln', ['-sf', '/opt/xemu/xmega65', '/usr/local/bin/xmega65']],
  ]);
  assert.equal(result.installPath, '/opt/xemu/xmega65');
  assert.equal(result.symlinkPath, '/usr/local/bin/xmega65');
});

test('installXemu: a failed sudo step is reported, without running the later steps', async () => {
  const calls = [];
  const sudoExec = async (cmd, args) => {
    calls.push(cmd);
    return { code: cmd === 'install' ? 1 : 0 };
  };
  const result = await installXemu('/bin/xmega65.native', { sudoExec });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'install');
  assert.deepEqual(calls, ['mkdir', 'install']);
});
