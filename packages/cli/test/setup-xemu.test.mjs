// Unit tests for building/installing Xemu's MEGA65 core from source — the
// only path this project uses (the AUR xmega65-git package is deliberately
// not depended on) — plus the compatibility data-directory symlink Xemu
// itself creates on first launch. Process and filesystem boundaries are
// injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildXemuMega65, installXemu, ensureXemuDataDir, inspectXemuDataDir } from '../src/setup/xemu.mjs';

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

test('installXemu: installs to /opt/xemu/xmega65 (never named .native) — the PATH symlink is a separate step', async () => {
  const calls = [];
  const sudoExec = async (cmd, args) => { calls.push([cmd, args]); return { code: 0 }; };
  const result = await installXemu('/cache/xemu/build/bin/xmega65.native', { sudoExec });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['mkdir', ['-p', '/opt/xemu']],
    ['install', ['-m755', '/cache/xemu/build/bin/xmega65.native', '/opt/xemu/xmega65']],
  ]);
  assert.equal(result.installPath, '/opt/xemu/xmega65');
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

test('ensureXemuDataDir: nothing at ~/.xemu-lgb yet — creates the real per-platform dir, then the symlink', async () => {
  const mkdirCalls = [];
  const symlinkCalls = [];
  const result = await ensureXemuDataDir({
    platform: 'darwin',
    linkPath: '/home/u/.xemu-lgb',
    realDir: '/home/u/Library/Application Support/xemu-lgb/mega65',
    mkdirFn: async (p, opts) => mkdirCalls.push([p, opts]),
    symlinkFn: async (target, path) => symlinkCalls.push([target, path]),
    inspect: async () => ({ state: 'missing' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.deepEqual(mkdirCalls, [['/home/u/Library/Application Support/xemu-lgb/mega65', { recursive: true }]]);
  assert.deepEqual(symlinkCalls, [['/home/u/Library/Application Support/xemu-lgb/mega65', '/home/u/.xemu-lgb']]);
});

test('ensureXemuDataDir: already a symlink (Xemu\'s own first-run layout) — left completely alone', async () => {
  const mkdirCalls = [];
  const result = await ensureXemuDataDir({
    inspect: async () => ({ state: 'symlink', target: '/home/u/Library/Application Support/xemu-lgb/mega65' }),
    mkdirFn: async (p) => mkdirCalls.push(p),
    symlinkFn: async () => { throw new Error('should not symlink over an existing one'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'unchanged');
  assert.equal(mkdirCalls.length, 0);
});

test('ensureXemuDataDir: a real directory already there — left alone, never replaced with a symlink', async () => {
  const result = await ensureXemuDataDir({
    inspect: async () => ({ state: 'other' }),
    mkdirFn: async () => { throw new Error('should not mkdir'); },
    symlinkFn: async () => { throw new Error('should not symlink'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'unchanged');
});

test('inspectXemuDataDir: resolves a relative symlink target against the link\'s own directory', async () => {
  const inspection = await inspectXemuDataDir('/home/u/.xemu-lgb', {
    lstatFn: async () => ({ isSymbolicLink: () => true }),
    readlinkFn: async () => 'Library/Application Support/xemu-lgb/mega65',
  });
  assert.equal(inspection.state, 'symlink');
  assert.equal(inspection.target, '/home/u/Library/Application Support/xemu-lgb/mega65');
});
