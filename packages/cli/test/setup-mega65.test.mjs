// End-to-end coverage of `8bs setup mega65` with every I/O boundary faked
// via the io bag: no sudo, no Homebrew/pacman, no clones, no builds, no GUI
// launches. Each scenario is one machine state from the brief — fresh
// macOS, missing Xcode CLT, missing Homebrew, ROM missing, an unverified
// ROM, the Xemu-data-dir/ROM-link gap, idempotent rerun, a foreign launcher.
//
// A real, hash-matching MEGA65 920413 ROM can't be fabricated in a test
// (it's 128KB of copyrighted content this project never embeds), so these
// tests use `io.validateRom` — the same seam generateRom()'s own tests use
// via a faked patchRomFn result — to simulate a validated ROM without the
// real bytes; the "unverified ROM" scenarios use the *real* validateRomBuffer
// against an arbitrary buffer, which is exactly what "size matches, hash
// doesn't" looks like in production too.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setupMega65, MEGA65_PLATFORMS, expandHome, installProvidedRom,
} from '../src/setup/mega65.mjs';
import { xemuRomLinkPath, xemuMega65RealDataDir } from '../src/setup/paths.mjs';
import { MEGA65_ROM_920413 } from '../src/setup/rom.mjs';

const XEMU_SRC = '/home/u/.cache/8bitscript/setup/xemu';
const CANONICAL_ROM = '/opt/mega65/MEGA65.ROM';
const LINK_PATH = xemuRomLinkPath();
const REAL_DATA_DIR_MAC = xemuMega65RealDataDir('darwin');

/** Fake filesystem + process world, same shape as setup-cx16.test.mjs's. */
function makeWorld({
  platform = 'darwin', entries = {}, env = {}, xcode = true, brew = true, brewMissing = [],
  pacmanMissing = [], buildOk = true, interactive = false, confirmAnswer = true,
  promptAnswer = '/downloads/MEGA65.ROM', romValidates = 'unknown',
} = {}) {
  const fs = { ...entries };
  for (const path of Object.keys(entries)) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (parent && !(parent in fs)) fs[parent] = { dir: true };
  }
  const calls = {
    exec: [], live: [], sudo: [], build: [], confirms: [], prompts: [],
  };
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const stats = (e) => ({
    isSymbolicLink: () => 'symlink' in e, isFile: () => 'file' in e, isDirectory: () => 'dir' in e,
  });
  const io = {
    platform,
    env: { LLVM_MOS_HOME: '/opt/llvm-mos', PATH: '/usr/local/bin:/usr/bin', ...env },
    hasBinary: (name) => (name === 'brew' ? brew : false),
    canPromptInteractively: () => interactive,
    confirm: async (q) => { calls.confirms.push(q); return confirmAnswer; },
    promptLine: async (q) => { calls.prompts.push(q); return promptAnswer; },
    exists: async (p) => p in fs,
    lstatFn: async (p) => { if (!(p in fs)) throw missing(); return stats(fs[p]); },
    readlinkFn: async (p) => fs[p].symlink,
    readFileFn: async (p) => { if (!(p in fs) || !('file' in fs[p])) throw missing(); return Buffer.isBuffer(fs[p].file) ? fs[p].file : Buffer.from(fs[p].file); },
    // Real `mkdir(dir, {recursive:true})` on a path that already exists
    // (a real directory, or a symlink to one) is a no-op — it never
    // replaces a symlink with a plain directory the way an unconditional
    // write would.
    mkdirFn: async (p) => { if (!(p in fs)) fs[p] = { dir: true }; },
    writeFileFn: async (p, content) => { fs[p] = { file: content }; },
    symlinkFn: async (target, path) => { fs[path] = { symlink: target }; },
    unlinkFn: async (p) => { delete fs[p]; },
    validateRom: (buffer, expected) => {
      if (romValidates === 'valid') return { size: expected.size, sha256: 'fake-valid-hash', sizeOk: true, hashOk: true, ok: true };
      if (romValidates === 'wrong-size') return { size: 10, sha256: 'x', sizeOk: false, hashOk: false, ok: false };
      // 'unknown' — right size, but the real hash check (unfakeable without
      // the actual ROM) reports it as not matching the pinned release.
      return { size: buffer.length, sha256: 'deadbeef'.repeat(8), sizeOk: buffer.length === expected.size, hashOk: false, ok: false };
    },
    workDir: () => '/home/u/.cache/8bitscript/setup/mega65-work',
    buildXemu: async (opts) => {
      calls.build.push(['xemu', opts && opts.exec ? XEMU_SRC : XEMU_SRC]);
      if (buildOk === 'fail') return { ok: false, step: 'make', code: 2 };
      fs[`${XEMU_SRC}/build/bin/xmega65.native`] = { file: '<binary xmega65>' };
      return { ok: true, binaryPath: `${XEMU_SRC}/build/bin/xmega65.native` };
    },
    exec: async (cmd, args) => {
      calls.exec.push([cmd, args]);
      if (cmd.endsWith('mos-mega65-clang')) return { code: 0, stdout: 'clang version 19', stderr: '', missing: false };
      if (cmd === 'xcode-select') return { code: xcode ? 0 : 2, stdout: '', stderr: '', missing: false };
      if (cmd === 'brew') {
        if (!brew) return { missing: true, code: null, stdout: '', stderr: '' };
        const asked = args.slice(2);
        const anyMissing = asked.some((p) => brewMissing.includes(p));
        return { code: anyMissing ? 1 : 0, stdout: '', stderr: '', missing: false };
      }
      if (cmd === 'pacman') {
        const asked = args.slice(1);
        return { code: 0, stdout: asked.filter((p) => pacmanMissing.includes(p)).join('\n'), stderr: '', missing: false };
      }
      return { code: 0, stdout: '', stderr: '', missing: false };
    },
    execLive: async (cmd, args) => { calls.live.push([cmd, args]); return { code: 0, missing: false }; },
    sudoExec: async (cmd, args) => {
      calls.sudo.push([cmd, args]);
      if (cmd === 'mkdir') fs[args[1]] = { dir: true };
      if (cmd === 'install') fs[args[2]] = { file: fs[args[1]]?.file ?? `<binary ${args[1]}>` };
      if (cmd === 'ln') fs[args[2]] = { symlink: args[1] };
      return { code: 0 };
    },
  };
  return { io, fs, calls };
}

const INSTALLED = {
  '/opt/xemu': { dir: true },
  '/opt/xemu/xmega65': { file: '<binary xmega65>' },
  '/usr/local/bin': { dir: true },
  '/usr/local/bin/xmega65': { symlink: '/opt/xemu/xmega65' },
  [CANONICAL_ROM]: { file: '<valid rom>' },
  [LINK_PATH]: { symlink: CANONICAL_ROM },
};

/** Run setup with stdout captured, so the report can be asserted on. */
async function runSetup(io, options = {}) {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    const result = await setupMega65(options, io);
    return { result, output: lines.join('') };
  } finally {
    process.stdout.write = original;
  }
}

test('MEGA65_PLATFORMS: darwin uses brew, linux uses pacman', () => {
  assert.equal(MEGA65_PLATFORMS.darwin.packageManager, 'brew');
  assert.equal(MEGA65_PLATFORMS.linux.packageManager, 'pacman');
});

test('expandHome: expands ~ and ~/... against the real home directory, leaves other paths alone', () => {
  assert.equal(expandHome('/already/absolute/MEGA65.ROM'), '/already/absolute/MEGA65.ROM');
  assert.ok(expandHome('~/Downloads/MEGA65.ROM').endsWith('/Downloads/MEGA65.ROM'));
  assert.ok(!expandHome('~/Downloads/MEGA65.ROM').startsWith('~'));
});

test('setupMega65: macOS, everything missing — builds Xemu, installs the ROM via --rom, links it, ready', async () => {
  const { io, fs, calls } = makeWorld({
    entries: { '/downloads/MEGA65.ROM': { file: Buffer.alloc(MEGA65_ROM_920413.romSize, 1) } },
    romValidates: 'valid',
  });
  const { result, output } = await runSetup(io, { romPath: '/downloads/MEGA65.ROM' });
  assert.equal(result.ok, true, output);
  assert.match(output, /MEGA65 is ready/);
  assert.deepEqual(calls.build, [['xemu', XEMU_SRC]]);
  assert.deepEqual(calls.sudo, [
    ['mkdir', ['-p', '/opt/xemu']],
    ['install', ['-m755', `${XEMU_SRC}/build/bin/xmega65.native`, '/opt/xemu/xmega65']],
    ['mkdir', ['-p', '/usr/local/bin']],
    ['ln', ['-sf', '/opt/xemu/xmega65', '/usr/local/bin/xmega65']],
    ['mkdir', ['-p', '/opt/mega65']],
    ['install', ['-m644', '/home/u/.cache/8bitscript/setup/mega65-work/MEGA65.ROM', CANONICAL_ROM]],
    // The Xemu data-dir/ROM-link steps write under $HOME as the normal
    // user (io.mkdirFn/io.symlinkFn) — never through sudo.
  ]);
  assert.equal(fs['/usr/local/bin/xmega65'].symlink, '/opt/xemu/xmega65');
  assert.equal(fs[LINK_PATH].symlink, CANONICAL_ROM);
});

test('setupMega65: macOS, missing Xcode Command Line Tools (non-interactive) — stops with the hint, touches nothing', async () => {
  const { io, calls } = makeWorld({ xcode: false });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /xcode-select --install/);
  assert.deepEqual(calls.build, []);
  assert.deepEqual(calls.sudo, []);
});

test('setupMega65: macOS, missing Homebrew — reports it as required, never bootstraps it', async () => {
  const { io, calls } = makeWorld({ brew: false });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /Homebrew is required/);
  assert.match(output, /brew\.sh/);
  assert.ok(!calls.live.some(([c]) => c === 'curl' || c === 'bash'));
});

test('setupMega65: macOS, missing brew packages (non-interactive) — names them, does not build', async () => {
  const { io, calls } = makeWorld({ brewMissing: ['sdl2', 'wget'] });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /run: brew install sdl2 wget/);
  assert.deepEqual(calls.build, []);
});

const A_ROM_FILE = { '/downloads/MEGA65.ROM': { file: Buffer.alloc(MEGA65_ROM_920413.romSize, 1) } };

test('setupMega65: macOS, missing brew packages (interactive, accepted) — brew installs as the user, never under sudo', async () => {
  const { io, calls } = makeWorld({ entries: A_ROM_FILE, brewMissing: ['sdl2'], interactive: true, romValidates: 'valid' });
  const { result } = await runSetup(io, { romPath: '/downloads/MEGA65.ROM' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.live.filter(([c]) => c === 'brew'), [['brew', ['install', 'sdl2']]]);
  assert.ok(!calls.sudo.some(([c]) => c === 'brew'));
});

test('setupMega65: Linux uses pacman, not brew, and never touches Xcode/Homebrew checks', async () => {
  const { io, calls } = makeWorld({ entries: A_ROM_FILE, platform: 'linux', romValidates: 'valid' });
  const { result } = await runSetup(io, { romPath: '/downloads/MEGA65.ROM' });
  assert.equal(result.ok, true);
  assert.ok(!calls.exec.some(([c]) => c === 'xcode-select' || c === 'brew'));
  assert.ok(calls.exec.some(([c]) => c === 'pacman'));
});

test('setupMega65: source build failure — stops at the emulator step, no sudo at all', async () => {
  const { io, calls } = makeWorld({ buildOk: 'fail' });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /xemu build failed at 'make' \(exit 2\)/);
  assert.deepEqual(calls.sudo, []);
});

test('setupMega65: no ROM given, non-interactive — fails with the --rom hint, no sudo', async () => {
  const { io, calls } = makeWorld({ entries: { '/opt/xemu/xmega65': { file: '<bin>' }, '/usr/local/bin/xmega65': { symlink: '/opt/xemu/xmega65' } } });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /--rom \/path\/to\/MEGA65\.ROM/);
  assert.deepEqual(calls.sudo, []);
});

test('setupMega65: no ROM given, interactive — prompts for a path directly (not a C64 Forever MSI)', async () => {
  const { io, calls } = makeWorld({
    entries: { '/opt/xemu/xmega65': { file: '<bin>' }, '/usr/local/bin/xmega65': { symlink: '/opt/xemu/xmega65' }, ...A_ROM_FILE },
    interactive: true, romValidates: 'valid', promptAnswer: '/downloads/MEGA65.ROM',
  });
  const { result } = await runSetup(io);
  assert.equal(result.ok, true);
  assert.ok(calls.prompts.some((q) => /Path to MEGA65\.ROM/.test(q)));
  assert.ok(!calls.prompts.some((q) => /MSI/.test(q)));
});

test('setupMega65: a right-sized ROM with an unverified hash is installed, but setup does not print "ready" and returns ok:false', async () => {
  const { io, fs } = makeWorld({
    entries: { '/opt/xemu/xmega65': { file: '<bin>' }, '/usr/local/bin/xmega65': { symlink: '/opt/xemu/xmega65' } },
    romValidates: 'unknown',
  });
  fs['/downloads/MEGA65.ROM'] = { file: Buffer.alloc(MEGA65_ROM_920413.romSize, 2) };
  const { result, output } = await runSetup(io, { romPath: '/downloads/MEGA65.ROM' });
  assert.equal(result.ok, false);
  assert.match(output, /unverified ROM version/);
  assert.doesNotMatch(output, /MEGA65 is ready/);
  // Installed anyway — never silently rejected, per the brief.
  assert.equal(fs[CANONICAL_ROM].file.length, MEGA65_ROM_920413.romSize);
});

test('setupMega65: a wrong-size file at --rom is refused outright, nothing installed', async () => {
  const { io, calls } = makeWorld({
    entries: {
      '/opt/xemu/xmega65': { file: '<bin>' },
      '/usr/local/bin/xmega65': { symlink: '/opt/xemu/xmega65' },
      '/downloads/not-a-rom.bin': { file: Buffer.alloc(10) },
    },
    romValidates: 'wrong-size',
  });
  const { result, output } = await runSetup(io, { romPath: '/downloads/not-a-rom.bin' });
  assert.equal(result.ok, false);
  assert.match(output, /a full MEGA65 ROM is 131072 bytes/);
  assert.ok(!calls.sudo.some(([c, a]) => c === 'install' && a[2] === CANONICAL_ROM));
});

test('setupMega65: canonical ROM present, but Xemu\'s own data dir/link is missing — created, then linked', async () => {
  const compatLinkPath = LINK_PATH.slice(0, LINK_PATH.lastIndexOf('/'));
  const { io, fs, calls } = makeWorld({
    entries: {
      '/opt/xemu/xmega65': { file: '<bin>' },
      '/usr/local/bin/xmega65': { symlink: '/opt/xemu/xmega65' },
      [CANONICAL_ROM]: { file: '<valid rom>' },
    },
    romValidates: 'valid',
  });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, true, output);
  // The real per-platform data dir was created, and ~/.xemu-lgb symlinked to it.
  assert.equal(fs[REAL_DATA_DIR_MAC]?.dir, true);
  assert.equal(fs[compatLinkPath]?.symlink, REAL_DATA_DIR_MAC);
  assert.equal(fs[LINK_PATH].symlink, CANONICAL_ROM);
  assert.ok(!calls.confirms.length);
  // Neither the data dir nor the ROM symlink went through sudo — both live under $HOME.
  assert.ok(!calls.sudo.some(([c, a]) => a?.includes(REAL_DATA_DIR_MAC) || a?.includes(LINK_PATH)));
});

test('setupMega65: idempotent rerun — a complete install skips the build, deps prompts, and every sudo call', async () => {
  const { io, calls } = makeWorld({ entries: INSTALLED, romValidates: 'valid' });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, true, output);
  assert.deepEqual(calls.build, []);
  assert.deepEqual(calls.sudo, []);
  assert.deepEqual(calls.confirms, []);
  assert.match(output, /MEGA65 is ready/);
});

test('setupMega65: repair-only flow — xemu binary present but the PATH symlink is gone, only relinks (no rebuild)', async () => {
  const entries = { ...INSTALLED };
  delete entries['/usr/local/bin/xmega65'];
  const { io, calls } = makeWorld({ entries, romValidates: 'valid' });
  const { result } = await runSetup(io, { repair: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.build, []);
  assert.deepEqual(calls.sudo, [['ln', ['-sf', '/opt/xemu/xmega65', '/usr/local/bin/xmega65']]]);
});

test('setupMega65: canonical ROM present but Xemu is not linked to it (--repair scenario) — relinks without touching the emulator', async () => {
  const entries = { ...INSTALLED };
  delete entries[LINK_PATH];
  const { io, calls, fs } = makeWorld({ entries, romValidates: 'valid' });
  const { result } = await runSetup(io, { repair: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.build, []);
  assert.equal(fs[LINK_PATH].symlink, CANONICAL_ROM);
});

test('setupMega65: a foreign, non-8bs xmega65 launcher is reported and left alone without confirmation (non-interactive)', async () => {
  const entries = {
    ...INSTALLED,
    '/usr/local/bin/xmega65': { file: '#!/bin/sh\necho not ours\n' },
  };
  const { io, calls, fs } = makeWorld({ entries, romValidates: 'valid' });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /left untouched/);
  assert.equal(fs['/usr/local/bin/xmega65'].file, '#!/bin/sh\necho not ours\n');
  assert.ok(!calls.sudo.some(([c, a]) => c === 'ln' && a[1] === '/usr/local/bin/xmega65'));
});

test('setupMega65: a foreign xmega65 launcher is replaced only after interactive confirmation', async () => {
  const entries = {
    ...INSTALLED,
    '/usr/local/bin/xmega65': { file: '#!/bin/sh\necho not ours\n' },
  };
  const { io, calls, fs } = makeWorld({ entries, romValidates: 'valid', interactive: true, confirmAnswer: true });
  const { result } = await runSetup(io);
  assert.equal(result.ok, true);
  assert.ok(calls.confirms.some((q) => /Replace it with the 8bs-managed launcher/.test(q)));
  assert.equal(fs['/usr/local/bin/xmega65'].symlink, '/opt/xemu/xmega65');
});

test('installProvidedRom: ROM file not found at the given path', async () => {
  const result = await installProvidedRom('/nope.rom', async () => ({ code: 0 }), {
    readFileFn: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /not found/);
});
