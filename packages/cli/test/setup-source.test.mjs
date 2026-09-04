// The shared source checkout/build steps every source-built target uses
// (Xemu for mega65, x16-emulator + x16-rom for cx16). Process and filesystem
// boundaries are injected; nothing here clones or compiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syncRepository, runBuild } from '../src/setup/source.mjs';

test('syncRepository: no checkout yet — creates the parent and clones', async () => {
  const calls = [];
  const dirs = [];
  const r = await syncRepository({
    sourceDir: '/cache/8bitscript/setup/x16-emulator',
    repo: 'https://example.invalid/x16-emulator.git',
    exec: async (cmd, args) => { calls.push([cmd, args]); return { code: 0 }; },
    exists: async () => false,
    mkdirFn: async (p) => dirs.push(p),
  });
  assert.deepEqual(r, { ok: true, action: 'cloned' });
  assert.deepEqual(dirs, ['/cache/8bitscript/setup']);
  assert.deepEqual(calls, [['git', ['clone', 'https://example.invalid/x16-emulator.git', '/cache/8bitscript/setup/x16-emulator']]]);
});

test('syncRepository: existing checkout — fast-forwards, never re-clones', async () => {
  const calls = [];
  const r = await syncRepository({
    sourceDir: '/cache/x16-rom',
    repo: 'https://example.invalid/x16-rom.git',
    exec: async (cmd, args) => { calls.push([cmd, args]); return { code: 0 }; },
    exists: async (p) => p === '/cache/x16-rom/.git',
    mkdirFn: async () => { throw new Error('must not mkdir for an existing checkout'); },
  });
  assert.deepEqual(r, { ok: true, action: 'updated' });
  assert.deepEqual(calls, [['git', ['-C', '/cache/x16-rom', 'pull', '--ff-only']]]);
});

test('syncRepository: a failed clone/pull names the step', async () => {
  const r = await syncRepository({
    sourceDir: '/cache/x', repo: 'r', exec: async () => ({ code: 128 }), exists: async () => false, mkdirFn: async () => {},
  });
  assert.deepEqual(r, { ok: false, step: 'git clone', code: 128 });
});

test('runBuild: exit 0 and every artifact present is success — stderr warnings never matter', async () => {
  const calls = [];
  const r = await runBuild({
    cwd: '/cache/x16-emulator',
    artifacts: ['/cache/x16-emulator/build/x16emu', '/cache/x16-emulator/build/makecart'],
    exec: async (cmd, args, opts) => { calls.push([cmd, args, opts]); return { code: 0 }; },
    exists: async () => true,
  });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls, [['make', [], { cwd: '/cache/x16-emulator' }]]);
});

test('runBuild: non-zero exit is a failure', async () => {
  const r = await runBuild({ cwd: '/c', artifacts: ['/c/out'], exec: async () => ({ code: 2 }), exists: async () => true });
  assert.deepEqual(r, { ok: false, step: 'make', code: 2 });
});

test('runBuild: exit 0 but a missing artifact is still a failure, naming the artifact', async () => {
  const r = await runBuild({
    cwd: '/c', artifacts: ['/c/build/x16emu', '/c/build/makecart'],
    exec: async () => ({ code: 0 }), exists: async (p) => p.endsWith('x16emu'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.missingArtifact, '/c/build/makecart');
});
