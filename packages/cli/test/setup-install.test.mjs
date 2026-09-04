// Privileged installation into /opt and /usr/local/bin: unchanged files are
// never re-installed (no needless sudo prompt on a re-run), and a failed
// step stops the sequence rather than continuing past it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installFiles, ensureDirectory, filesIdentical } from '../src/setup/install.mjs';

const files = [
  { src: '/cache/x16-emulator/build/x16emu', dst: '/opt/commander-x16/x16emu', mode: '755' },
  { src: '/cache/x16-emulator/build/makecart', dst: '/opt/commander-x16/makecart', mode: '755' },
  { src: '/cache/x16-rom/build/x16/rom.bin', dst: '/opt/commander-x16/rom.bin', mode: '644' },
];

test('installFiles: fresh install — `sudo install -m<mode> <src> <dst>` for every file, in order', async () => {
  const calls = [];
  const r = await installFiles(files, async (cmd, args) => { calls.push([cmd, args]); return { code: 0 }; }, { identical: async () => false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.installed, files.map((f) => f.dst));
  assert.deepEqual(calls, [
    ['install', ['-m755', '/cache/x16-emulator/build/x16emu', '/opt/commander-x16/x16emu']],
    ['install', ['-m755', '/cache/x16-emulator/build/makecart', '/opt/commander-x16/makecart']],
    ['install', ['-m644', '/cache/x16-rom/build/x16/rom.bin', '/opt/commander-x16/rom.bin']],
  ]);
});

test('installFiles: byte-identical files are skipped — only the changed one is written', async () => {
  const calls = [];
  const r = await installFiles(
    files,
    async (cmd, args) => { calls.push(args[2]); return { code: 0 }; },
    { identical: async (src, dst) => !dst.endsWith('rom.bin') },
  );
  assert.deepEqual(r.installed, ['/opt/commander-x16/rom.bin']);
  assert.deepEqual(r.unchanged, ['/opt/commander-x16/x16emu', '/opt/commander-x16/makecart']);
  assert.deepEqual(calls, ['/opt/commander-x16/rom.bin']);
});

test('installFiles: a failed sudo install stops there and reports the path', async () => {
  const calls = [];
  const r = await installFiles(
    files,
    async (cmd, args) => { calls.push(args[2]); return { code: args[2].endsWith('makecart') ? 1 : 0 }; },
    { identical: async () => false },
  );
  assert.equal(r.ok, false);
  assert.equal(r.path, '/opt/commander-x16/makecart');
  assert.deepEqual(calls, ['/opt/commander-x16/x16emu', '/opt/commander-x16/makecart']);
});

test('ensureDirectory: sudo mkdir -p', async () => {
  const calls = [];
  const r = await ensureDirectory('/opt/commander-x16', async (cmd, args) => { calls.push([cmd, args]); return { code: 0 }; });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls, [['mkdir', ['-p', '/opt/commander-x16']]]);
});

test('filesIdentical: equal bytes true; a missing file is simply "not identical", never a throw', async () => {
  const read = async (p) => { if (p === '/missing') throw new Error('ENOENT'); return Buffer.from('abc'); };
  assert.equal(await filesIdentical('/a', '/b', read), true);
  assert.equal(await filesIdentical('/a', '/missing', read), false);
  assert.equal(await filesIdentical('/a', '/b', async (p) => Buffer.from(p)), false);
});
