// End-to-end coverage of `8bs setup cx16` with every I/O boundary faked via
// the io bag: no sudo, no Homebrew, no clones, no builds. Each scenario is
// one machine state from the brief — fresh macOS, ROM missing, old broken
// symlink layout, complete install — and asserts both the outcome and,
// just as importantly, what setup did *not* do (no rebuild on a repair, no
// sudo on a re-run, no Homebrew bootstrap ever).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupCx16, X16EMU_WRAPPER_EXEC_LINE, inspectCx16Installation } from '../src/setup/cx16.mjs';
import { wrapperScript, MANAGED_MARKER } from '../src/setup/launcher.mjs';

const EMU_SRC = '/home/u/.cache/8bitscript/setup/x16-emulator';
const ROM_SRC = '/home/u/.cache/8bitscript/setup/x16-rom';
const VERSION_LINE = '### Release 50 ("next") 77f2bab3\n';
const BOOT_OK = 'Testbench mode...\nRDY\nExit testbench.\n';

/** Fake filesystem + process world. `entries`: path -> {file}|{symlink}|{dir}. */
function makeWorld({ platform = 'darwin', entries = {}, env = {}, xcode = true, brew = true, brewMissing = [], emulatorBuild, romBuild, pairOk = true, interactive = false, confirmAnswer = true, launcherBoots = true } = {}) {
  const fs = { ...entries };
  // Parent directories exist whenever something lives in them, as on a real disk.
  for (const path of Object.keys(entries)) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (parent && !(parent in fs)) fs[parent] = { dir: true };
  }
  const calls = { exec: [], live: [], sudo: [], build: [], confirms: [] };
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const stats = (e) => ({ isSymbolicLink: () => 'symlink' in e, isFile: () => 'file' in e, size: 'file' in e ? Buffer.byteLength(e.file) : 0 });
  const hasBinary = (name) => (name === 'brew' ? brew : ['cc65', 'lzsa'].includes(name));
  const io = {
    platform,
    env: { LLVM_MOS_HOME: '/opt/llvm-mos', PATH: '/usr/local/bin:/usr/bin', ...env },
    hasBinary,
    canPromptInteractively: () => interactive,
    confirm: async (q) => { calls.confirms.push(q); return confirmAnswer; },
    exists: async (p) => p in fs,
    statFn: async (p) => { if (!(p in fs)) throw missing(); return stats(fs[p]); },
    accessFn: async (p) => { if (!(p in fs)) throw missing(); },
    lstatFn: async (p) => { if (!(p in fs)) throw missing(); return stats(fs[p]); },
    readlinkFn: async (p) => fs[p].symlink,
    readFileFn: async (p) => { if (!(p in fs) || !('file' in fs[p])) throw missing(); return Buffer.from(fs[p].file); },
    mkdirFn: async (p) => { fs[p] = { dir: true }; },
    writeFileFn: async (p, content) => { fs[p] = { file: String(content) }; },
    emulatorSourceDir: () => EMU_SRC,
    romSourceDir: () => ROM_SRC,
    workDir: () => '/home/u/.cache/8bitscript/setup/cx16-work',
    exec: async (cmd, args) => {
      calls.exec.push([cmd, args]);
      if (cmd.endsWith('mos-cx16-clang')) return { code: 0, stdout: 'clang version 19', stderr: '', missing: false };
      if (cmd === 'xcode-select') return { code: xcode ? 0 : 2, stdout: '', stderr: '', missing: false };
      if (cmd === 'brew') {
        if (!brew) return { missing: true, code: null, stdout: '', stderr: '' };
        const asked = args.slice(2);
        const anyMissing = asked.some((p) => brewMissing.includes(p));
        return { code: anyMissing ? 1 : 0, stdout: '', stderr: '', missing: false };
      }
      if (cmd === '/usr/local/bin/x16emu') {
        if (args.includes('-version')) return { code: 0, stdout: VERSION_LINE, stderr: '', missing: false };
        return launcherBoots
          ? { code: 0, stdout: BOOT_OK, stderr: '', missing: false }
          : { code: 1, stdout: 'Cannot open /usr/local/bin/rom.bin!\n', stderr: '', missing: false };
      }
      return { code: 0, stdout: '', stderr: '', missing: false };
    },
    execLive: async (cmd, args) => { calls.live.push([cmd, args]); return { code: 0, missing: false }; },
    sudoExec: async (cmd, args) => {
      calls.sudo.push([cmd, args]);
      // Mirror the effect so later steps see the result, as the real fs would.
      if (cmd === 'mkdir') fs[args[1]] = { dir: true };
      if (cmd === 'install') fs[args[2]] = { file: fs[args[1]]?.file ?? `<binary ${args[1]}>` };
      if (cmd === 'ln') fs[args[2]] = { symlink: args[1] };
      return { code: 0 };
    },
    buildEmulator: async (opts) => {
      calls.build.push(['emulator', opts.sourceDir]);
      if (emulatorBuild === 'fail') return { ok: false, step: 'make', code: 2 };
      fs[`${EMU_SRC}/build/x16emu`] = { file: '<binary x16emu r50>' };
      fs[`${EMU_SRC}/build/makecart`] = { file: '<binary makecart r50>' };
      return { ok: true, emulatorPath: `${EMU_SRC}/build/x16emu`, makecartPath: `${EMU_SRC}/build/makecart` };
    },
    buildRom: async (opts) => {
      calls.build.push(['rom', opts.sourceDir]);
      if (romBuild === 'fail') return { ok: false, step: 'make', code: 2 };
      fs[`${ROM_SRC}/build/x16/rom.bin`] = { file: '<rom r50>' };
      return { ok: true, romPath: `${ROM_SRC}/build/x16/rom.bin` };
    },
    validatePair: async () => (pairOk ? { ok: true, version: 'Release 50' } : { ok: false, detail: 'x16emu could not open /nope/rom.bin' }),
  };
  return { io, fs, calls };
}

const INSTALLED = {
  '/opt/commander-x16': { dir: true },
  '/opt/commander-x16/x16emu': { file: '<binary x16emu r50>' },
  '/opt/commander-x16/makecart': { file: '<binary makecart r50>' },
  '/opt/commander-x16/rom.bin': { file: '<rom r50>' },
};
const WRAPPER = { '/usr/local/bin/x16emu': { file: `#!/bin/sh\n${X16EMU_WRAPPER_EXEC_LINE}\n` } };
const MAKECART_LINK = { '/usr/local/bin/makecart': { symlink: '/opt/commander-x16/makecart' } };

/** Run setup with stdout captured, so the report can be asserted on. */
async function runSetup(io, options = {}) {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    const result = await setupCx16(options, io);
    return { result, output: lines.join('') };
  } finally {
    process.stdout.write = original;
  }
}

test('macOS, nothing installed: builds both, validates the pair, installs to /opt, writes the wrapper + makecart symlink', async () => {
  const { io, fs, calls } = makeWorld();
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, true, output);

  assert.deepEqual(calls.build, [['emulator', EMU_SRC], ['rom', ROM_SRC]]);
  assert.deepEqual(calls.sudo, [
    ['mkdir', ['-p', '/opt/commander-x16']],
    ['install', ['-m755', `${EMU_SRC}/build/x16emu`, '/opt/commander-x16/x16emu']],
    ['install', ['-m755', `${EMU_SRC}/build/makecart`, '/opt/commander-x16/makecart']],
    ['install', ['-m644', `${ROM_SRC}/build/x16/rom.bin`, '/opt/commander-x16/rom.bin']],
    ['mkdir', ['-p', '/usr/local/bin']],
    ['install', ['-m755', '/home/u/.cache/8bitscript/setup/cx16-work/x16emu.launcher', '/usr/local/bin/x16emu']],
    ['ln', ['-sf', '/opt/commander-x16/makecart', '/usr/local/bin/makecart']],
  ]);
  // The exact tested wrapper: never a symlink for x16emu on macOS.
  assert.equal(fs['/usr/local/bin/x16emu'].file, wrapperScript(X16EMU_WRAPPER_EXEC_LINE));
  assert.match(fs['/usr/local/bin/x16emu'].file, /^#!\/bin\/sh\n/);
  assert.ok(fs['/usr/local/bin/x16emu'].file.includes('exec /opt/commander-x16/x16emu -rom /opt/commander-x16/rom.bin "$@"'));
  assert.deepEqual(fs['/usr/local/bin/makecart'], { symlink: '/opt/commander-x16/makecart' });
  // Nothing with 'sudo' anywhere near git/make/brew: only the live (user) exec sees them — and here none ran.
  assert.ok(!calls.sudo.some(([c]) => ['git', 'make', 'brew', 'cmake'].includes(c)));
  // The final verification went through the launcher, headless.
  assert.ok(calls.exec.some(([c, a]) => c === '/usr/local/bin/x16emu' && a.includes('-testbench')));
  assert.match(output, /Commander X16 is ready/);
  assert.match(output, /launcher.*wrapper, -rom \/opt\/commander-x16\/rom\.bin/);
});

test('macOS, missing Xcode Command Line Tools (non-interactive): stops with the xcode-select hint, touches nothing', async () => {
  const { io, calls } = makeWorld({ xcode: false });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /xcode-select --install/);
  assert.deepEqual(calls.build, []);
  assert.deepEqual(calls.sudo, []);
  assert.deepEqual(calls.live, []);
});

test('macOS, missing Xcode CLT (interactive, accepted): runs `xcode-select --install` once and asks for a re-run', async () => {
  const { io, calls } = makeWorld({ xcode: false, interactive: true });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.deepEqual(calls.live, [['xcode-select', ['--install']]]);
  assert.match(output, /re-run `8bs setup cx16`/);
});

test('macOS, Xcode CLT already present: never offers the installer', async () => {
  const { io, calls } = makeWorld({ interactive: true });
  await runSetup(io);
  assert.ok(!calls.live.some(([c]) => c === 'xcode-select'));
  assert.ok(!calls.confirms.some((q) => /Command Line Tools/.test(q)));
});

test('macOS, missing Homebrew: reports it as required with guidance — never runs a bootstrap script', async () => {
  const { io, calls } = makeWorld({ brew: false });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /Homebrew is required/);
  assert.match(output, /brew\.sh/);
  assert.ok(!calls.live.some(([c]) => c === 'curl' || c === 'bash' || c === 'sh'));
  assert.deepEqual(calls.build, []);
  assert.deepEqual(calls.sudo, []);
});

test('macOS, missing brew packages (non-interactive): names them with the brew install command, does not build', async () => {
  const { io, calls } = makeWorld({ brewMissing: ['pkgconf', 'lzsa'] });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /run: brew install pkgconf lzsa/);
  assert.deepEqual(calls.build, []);
});

test('macOS, missing brew packages (interactive, accepted): `brew install` runs as the user, then the build proceeds', async () => {
  const { io, calls } = makeWorld({ brewMissing: ['pkgconf'], interactive: true });
  const { result } = await runSetup(io);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.live, [['brew', ['install', 'pkgconf']]]);
  assert.ok(!calls.sudo.some(([c]) => c === 'brew'));
});

test('macOS, ROM missing (emulator already installed): rebuilds the pair, installs only what changed', async () => {
  const entries = { ...INSTALLED, ...WRAPPER, ...MAKECART_LINK };
  delete entries['/opt/commander-x16/rom.bin'];
  const { io, calls } = makeWorld({ entries });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, true, output);
  assert.match(output, /is incomplete \(missing: rom\.bin\) — rebuilding the emulator\+ROM pair together/);
  assert.deepEqual(calls.build, [['emulator', EMU_SRC], ['rom', ROM_SRC]]);
  // x16emu/makecart are byte-identical to the fresh build: not re-installed.
  assert.deepEqual(calls.sudo.filter(([c]) => c === 'install').map(([, a]) => a[2]), ['/opt/commander-x16/rom.bin']);
});

test('macOS, source build failure: stops at the emulator step with no install and no sudo', async () => {
  const { io, calls } = makeWorld({ emulatorBuild: 'fail' });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /x16-emulator build failed at 'make' \(exit 2\)/);
  assert.deepEqual(calls.build, [['emulator', EMU_SRC]]);
  assert.deepEqual(calls.sudo, []);
});

test('macOS, ROM build failure: stops at the ROM step with no install and no sudo', async () => {
  const { io, calls } = makeWorld({ romBuild: 'fail' });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /x16-rom build failed at 'make' \(exit 2\)/);
  assert.deepEqual(calls.build, [['emulator', EMU_SRC], ['rom', ROM_SRC]]);
  assert.deepEqual(calls.sudo, []);
});

test('built pair fails headless validation: nothing is installed', async () => {
  const { io, calls } = makeWorld({ pairOk: false });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /could not open/);
  assert.deepEqual(calls.sudo, []);
});

test('idempotent re-run on a complete macOS installation: no brew, no git/make, no sudo — just verification', async () => {
  const { io, calls } = makeWorld({ entries: { ...INSTALLED, ...WRAPPER, ...MAKECART_LINK } });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, true, output);
  assert.deepEqual(calls.build, []);
  assert.deepEqual(calls.live, []);
  assert.deepEqual(calls.sudo, []);
  assert.ok(!calls.exec.some(([c]) => c === 'brew' || c === 'xcode-select'));
  assert.match(output, /already present/);
  assert.match(output, /Release 50 boots via \/usr\/local\/bin\/x16emu/);
  assert.match(output, /Commander X16 is ready/);
});

test('repair of the old broken macOS symlink layout: replaces the symlink with the wrapper, rebuilds nothing', async () => {
  const entries = { ...INSTALLED, ...MAKECART_LINK, '/usr/local/bin/x16emu': { symlink: '/opt/commander-x16/x16emu' } };
  const { io, fs, calls } = makeWorld({ entries });
  const { result, output } = await runSetup(io, { repair: true });
  assert.equal(result.ok, true, output);
  assert.deepEqual(calls.build, []);
  // /usr/local/bin already exists: the one and only sudo call is the wrapper install.
  assert.deepEqual(calls.sudo, [
    ['install', ['-m755', '/home/u/.cache/8bitscript/setup/cx16-work/x16emu.launcher', '/usr/local/bin/x16emu']],
  ]);
  assert.equal(fs['/usr/local/bin/x16emu'].file, wrapperScript(X16EMU_WRAPPER_EXEC_LINE));
  assert.match(output, /replaced the direct symlink that could not find rom\.bin/);
  assert.deepEqual(calls.confirms, []);
});

test('--repair and a plain run are the same idempotent operation', async () => {
  const entries = { ...INSTALLED, ...MAKECART_LINK, '/usr/local/bin/x16emu': { symlink: '/opt/commander-x16/x16emu' } };
  const plain = makeWorld({ entries });
  const repair = makeWorld({ entries });
  await runSetup(plain.io);
  await runSetup(repair.io, { repair: true });
  assert.deepEqual(plain.calls.sudo, repair.calls.sudo);
});

test('a stale 8bs-managed wrapper (marker present, old exec line) is rewritten without asking', async () => {
  const entries = { ...INSTALLED, ...MAKECART_LINK, '/usr/local/bin/x16emu': { file: `#!/bin/sh\n${MANAGED_MARKER}\nexec /opt/commander-x16/x16emu "$@"\n` } };
  const { io, fs, calls } = makeWorld({ entries });
  const { result } = await runSetup(io);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.confirms, []);
  assert.equal(fs['/usr/local/bin/x16emu'].file, wrapperScript(X16EMU_WRAPPER_EXEC_LINE));
});

test('an unmanaged /usr/local/bin/x16emu is explained and left alone without confirmation (non-interactive)', async () => {
  const entries = { ...INSTALLED, ...MAKECART_LINK, '/usr/local/bin/x16emu': { file: '#!/bin/sh\nexec /Applications/X16/x16emu "$@"\n' } };
  const { io, fs, calls } = makeWorld({ entries });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /already exists and is a file that isn't managed by 8bs \(first line: exec \/Applications\/X16\/x16emu/);
  assert.match(output, /left untouched/);
  assert.equal(fs['/usr/local/bin/x16emu'].file, '#!/bin/sh\nexec /Applications/X16/x16emu "$@"\n');
  assert.ok(!calls.sudo.some(([c]) => c === 'install'));
});

test('an unmanaged /usr/local/bin/x16emu is replaced only after an interactive yes', async () => {
  const entries = { ...INSTALLED, ...MAKECART_LINK, '/usr/local/bin/x16emu': { symlink: '/opt/homebrew/bin/x16emu' } };
  const { io, fs, calls } = makeWorld({ entries, interactive: true, confirmAnswer: true });
  const { result } = await runSetup(io);
  assert.equal(result.ok, true);
  assert.equal(calls.confirms.length, 1);
  assert.match(calls.confirms[0], /Replace it/);
  assert.equal(fs['/usr/local/bin/x16emu'].file, wrapperScript(X16EMU_WRAPPER_EXEC_LINE));
});

test('makecart: an existing correct symlink is left alone; a missing one is linked', async () => {
  const withLink = makeWorld({ entries: { ...INSTALLED, ...WRAPPER, ...MAKECART_LINK } });
  await runSetup(withLink.io);
  assert.ok(!withLink.calls.sudo.some(([c]) => c === 'ln'));

  const withoutLink = makeWorld({ entries: { ...INSTALLED, ...WRAPPER } });
  const { result } = await runSetup(withoutLink.io);
  assert.equal(result.ok, true);
  // /usr/local/bin already exists (the wrapper lives there): no sudo mkdir.
  assert.deepEqual(withoutLink.calls.sudo, [
    ['ln', ['-sf', '/opt/commander-x16/makecart', '/usr/local/bin/makecart']],
  ]);
});

test('--update on a complete installation forces pull+build+install of the pair', async () => {
  const { io, calls } = makeWorld({ entries: { ...INSTALLED, ...WRAPPER, ...MAKECART_LINK } });
  const { result } = await runSetup(io, { update: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.build, [['emulator', EMU_SRC], ['rom', ROM_SRC]]);
});

test('the launcher is verified by a headless boot — a launcher that cannot open rom.bin fails setup even with everything installed', async () => {
  const { io } = makeWorld({ entries: { ...INSTALLED, ...WRAPPER, ...MAKECART_LINK }, launcherBoots: false });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /could not open \/usr\/local\/bin\/rom\.bin/);
});

test('/usr/local/bin missing from PATH is reported, not fatal', async () => {
  const { io } = makeWorld({ entries: { ...INSTALLED, ...WRAPPER, ...MAKECART_LINK }, env: { PATH: '/opt/homebrew/bin:/usr/bin' } });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, true);
  assert.match(output, /\/usr\/local\/bin is not on PATH/);
});

test('Linux keeps the direct symlink for x16emu — the wrapper is a macOS-specific strategy', async () => {
  const { io, fs, calls } = makeWorld({ platform: 'linux' });
  // pacman -T prints nothing: every package present; cc65/lzsa on PATH via hasBinary.
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, true, output);
  assert.deepEqual(fs['/usr/local/bin/x16emu'], { symlink: '/opt/commander-x16/x16emu' });
  assert.ok(calls.sudo.some(([c, a]) => c === 'ln' && a[2] === '/usr/local/bin/x16emu'));
  assert.ok(!calls.exec.some(([c]) => c === 'brew' || c === 'xcode-select'));
  assert.match(output, /x16emu launcher: symlink/);
});

test('Linux: a wrapper left by a macOS-style install is treated as ours and swapped back to the symlink', async () => {
  const { io, fs } = makeWorld({ platform: 'linux', entries: { ...INSTALLED, ...WRAPPER, ...MAKECART_LINK } });
  const { result } = await runSetup(io);
  assert.equal(result.ok, true);
  assert.deepEqual(fs['/usr/local/bin/x16emu'], { symlink: '/opt/commander-x16/x16emu' });
});

test('Linux: cc65/lzsa (AUR-only) missing from PATH is reported with the pamac command', async () => {
  const { io } = makeWorld({ platform: 'linux' });
  io.hasBinary = () => false;
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /run: pamac build cc65 lzsa/);
});

test('unsupported platform: says so and does nothing', async () => {
  const { io, calls } = makeWorld({ platform: 'win32' });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /no Commander X16 setup backend for 'win32'/);
  assert.deepEqual(calls.exec, []);
});

test('missing compiler: stops before touching anything', async () => {
  const { io, calls } = makeWorld({ env: { LLVM_MOS_HOME: '' } });
  const { result, output } = await runSetup(io);
  assert.equal(result.ok, false);
  assert.match(output, /LLVM_MOS_HOME is not set/);
  assert.deepEqual(calls.build, []);
});

test('inspectCx16Installation: distinguishes each state separately', async () => {
  const { io } = makeWorld({ entries: { ...INSTALLED, [`${EMU_SRC}/.git`]: { dir: true }, [`${EMU_SRC}/build/x16emu`]: { file: 'b' }, '/usr/local/bin/x16emu': { symlink: '/opt/commander-x16/x16emu' } } });
  const state = await inspectCx16Installation({ platform: 'darwin', emulatorSourceDir: EMU_SRC, romSourceDir: ROM_SRC }, io);
  assert.deepEqual(state.source, { emulator: true, rom: false });
  assert.deepEqual(state.build, { emulator: false, rom: false }); // makecart artifact absent
  assert.equal(state.installed, true);
  assert.equal(state.launcher.state, 'symlink');
  assert.equal(state.launcherOk, false); // symlink is the broken layout on macOS
  assert.equal(state.makecartLauncher.state, 'missing');
  assert.equal(state.complete, false);

  const linux = await inspectCx16Installation({ platform: 'linux', emulatorSourceDir: EMU_SRC, romSourceDir: ROM_SRC }, io);
  assert.equal(linux.launcherOk, true);
});
