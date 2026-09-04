// PATH launchers: the symlink-vs-wrapper choice that exists because of a
// real, tested macOS failure (x16emu resolves rom.bin relative to the path
// it was invoked through, so a direct /usr/local/bin symlink dies with
// "Cannot open /usr/local/bin/rom.bin!"). Filesystem and sudo are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inspectLauncher, ensureLauncher, wrapperScript, MANAGED_MARKER } from '../src/setup/launcher.mjs';

const EXEC_LINE = 'exec /opt/commander-x16/x16emu -rom /opt/commander-x16/rom.bin "$@"';
const spec = { path: '/usr/local/bin/x16emu', target: '/opt/commander-x16/x16emu', execLine: EXEC_LINE };

/** A tiny fake filesystem: path -> { symlink } | { file } | { dir }. */
function fakeFs(entries) {
  return {
    lstatFn: async (p) => {
      const e = entries[p];
      if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isSymbolicLink: () => 'symlink' in e, isFile: () => 'file' in e };
    },
    readlinkFn: async (p) => entries[p].symlink,
    readFileFn: async (p) => entries[p].file,
  };
}

test('wrapperScript: the tested macOS launcher — /bin/sh, exec with explicit -rom, "$@" last', () => {
  const script = wrapperScript(EXEC_LINE);
  assert.equal(script, `#!/bin/sh\n${MANAGED_MARKER}\nexec /opt/commander-x16/x16emu -rom /opt/commander-x16/rom.bin "$@"\n`);
  assert.ok(script.startsWith('#!/bin/sh\n'));
});

test('inspectLauncher: classifies every state', async () => {
  const states = async (entries) => (await inspectLauncher(spec, fakeFs(entries))).state;
  assert.equal(await states({}), 'missing');
  assert.equal(await states({ '/usr/local/bin/x16emu': { symlink: '/opt/commander-x16/x16emu' } }), 'symlink');
  assert.equal(await states({ '/usr/local/bin/x16emu': { symlink: '/opt/homebrew/Cellar/x16/bin/x16emu' } }), 'foreign-symlink');
  assert.equal(await states({ '/usr/local/bin/x16emu': { file: wrapperScript(EXEC_LINE) } }), 'wrapper');
  // The exact two-line script from the tested manual install (no marker) is
  // still recognised as ours: the exec line is what matters.
  assert.equal(await states({ '/usr/local/bin/x16emu': { file: `#!/bin/sh\n${EXEC_LINE}\n` } }), 'wrapper');
  assert.equal(await states({ '/usr/local/bin/x16emu': { file: `#!/bin/sh\n${MANAGED_MARKER}\nexec /opt/commander-x16/x16emu "$@"\n` } }), 'stale-wrapper');
  assert.equal(await states({ '/usr/local/bin/x16emu': { file: '#!/bin/sh\nexec /somewhere/else/x16emu "$@"\n' } }), 'foreign-file');
  assert.equal(await states({ '/usr/local/bin/x16emu': { dir: true } }), 'foreign-file');
});

test('ensureLauncher (wrapper): missing — stages the script as the user, then `sudo install -m755` it', async () => {
  const sudo = [];
  const writes = [];
  const r = await ensureLauncher(
    { ...spec, kind: 'wrapper', workDir: '/home/u/.cache/8bitscript/setup/cx16-work', sudoExec: async (c, a) => { sudo.push([c, a]); return { code: 0 }; } },
    { ...fakeFs({}), mkdirFn: async () => {}, writeFileFn: async (p, content) => writes.push([p, content]) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.action, 'created');
  assert.deepEqual(writes, [['/home/u/.cache/8bitscript/setup/cx16-work/x16emu.launcher', wrapperScript(EXEC_LINE)]]);
  assert.deepEqual(sudo, [['install', ['-m755', '/home/u/.cache/8bitscript/setup/cx16-work/x16emu.launcher', '/usr/local/bin/x16emu']]]);
});

test('ensureLauncher (wrapper): the old broken direct symlink is repaired without asking', async () => {
  const sudo = [];
  let asked = false;
  const r = await ensureLauncher(
    { ...spec, kind: 'wrapper', workDir: '/w', sudoExec: async (c, a) => { sudo.push(c); return { code: 0 }; }, confirmReplace: async () => { asked = true; return false; } },
    { ...fakeFs({ '/usr/local/bin/x16emu': { symlink: '/opt/commander-x16/x16emu' } }), mkdirFn: async () => {}, writeFileFn: async () => {} },
  );
  assert.equal(r.ok, true);
  assert.equal(r.action, 'repaired');
  assert.equal(r.inspection.state, 'symlink');
  assert.equal(asked, false);
  assert.deepEqual(sudo, ['install']);
});

test('ensureLauncher (wrapper): an already-correct wrapper is untouched — no sudo at all', async () => {
  const r = await ensureLauncher(
    { ...spec, kind: 'wrapper', workDir: '/w', sudoExec: async () => { throw new Error('no sudo expected'); } },
    { ...fakeFs({ '/usr/local/bin/x16emu': { file: `#!/bin/sh\n${EXEC_LINE}\n` } }), mkdirFn: async () => {}, writeFileFn: async () => {} },
  );
  assert.deepEqual([r.ok, r.action], [true, 'unchanged']);
});

test('ensureLauncher: a foreign launcher is only replaced with confirmation', async () => {
  const entries = { '/usr/local/bin/x16emu': { file: '#!/bin/sh\nexec /Applications/x16emu.app/x16emu "$@"\n' } };
  const sudo = [];
  const declined = await ensureLauncher(
    { ...spec, kind: 'wrapper', workDir: '/w', sudoExec: async (c) => { sudo.push(c); return { code: 0 }; }, confirmReplace: async () => false },
    { ...fakeFs(entries), mkdirFn: async () => {}, writeFileFn: async () => {} },
  );
  assert.deepEqual([declined.ok, declined.action, sudo], [false, 'skipped-foreign', []]);

  let seen = null;
  const accepted = await ensureLauncher(
    { ...spec, kind: 'wrapper', workDir: '/w', sudoExec: async (c) => { sudo.push(c); return { code: 0 }; }, confirmReplace: async (i) => { seen = i; return true; } },
    { ...fakeFs(entries), mkdirFn: async () => {}, writeFileFn: async () => {} },
  );
  assert.deepEqual([accepted.ok, accepted.action, sudo], [true, 'replaced', ['install']]);
  assert.equal(seen.state, 'foreign-file');
});

test('ensureLauncher (symlink): missing — `sudo ln -sf <target> <path>`; existing correct symlink — untouched', async () => {
  const sudo = [];
  const created = await ensureLauncher(
    { path: '/usr/local/bin/makecart', target: '/opt/commander-x16/makecart', kind: 'symlink', sudoExec: async (c, a) => { sudo.push([c, a]); return { code: 0 }; } },
    fakeFs({}),
  );
  assert.deepEqual([created.ok, created.action], [true, 'created']);
  assert.deepEqual(sudo, [['ln', ['-sf', '/opt/commander-x16/makecart', '/usr/local/bin/makecart']]]);

  const same = await ensureLauncher(
    { path: '/usr/local/bin/makecart', target: '/opt/commander-x16/makecart', kind: 'symlink', sudoExec: async () => { throw new Error('no sudo expected'); } },
    fakeFs({ '/usr/local/bin/makecart': { symlink: '/opt/commander-x16/makecart' } }),
  );
  assert.deepEqual([same.ok, same.action], [true, 'unchanged']);
});

test('ensureLauncher: a failed sudo step is reported with the step name', async () => {
  const r = await ensureLauncher(
    { ...spec, kind: 'symlink', sudoExec: async () => ({ code: 1 }) },
    fakeFs({}),
  );
  assert.deepEqual([r.ok, r.action, r.step], [false, 'failed', 'ln']);
});
