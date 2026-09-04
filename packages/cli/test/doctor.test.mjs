// Unit tests for the doctor's pure helpers. The full command shells out to
// real toolchains, so its branches are exercised against fakes by hand; what
// must never regress silently is the version arithmetic these checks stand on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseVersion, atLeast, findLocalBin, pickInstallPlan, findMega65Rom, readyTargets, checkCx16Target, checkMega65Target,
  vicePackageManagerVersion,
} from '../src/doctor.mjs';
import { MEGA65_ROM_920413, sha256Hex } from '../src/setup/rom.mjs';
import { parseX16emuVersion, romLoadFailure, testbenchBooted } from '../src/setup/cx16.mjs';

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

test('pickInstallPlan: macOS uses the darwin plan only when brew is on PATH', () => {
  const installer = { darwin: { manager: 'brew', args: ['install', 'fceux'] } };
  assert.deepEqual(
    pickInstallPlan(installer, 'darwin', (bin) => bin === 'brew'),
    { manager: 'brew', args: ['install', 'fceux'] },
  );
  assert.equal(pickInstallPlan(installer, 'darwin', () => false), null);
});

test('pickInstallPlan: linux tries each listed manager in order, first on PATH wins', () => {
  const installer = {
    linux: [
      { manager: 'apt', args: ['install', '-y', 'vice'], sudo: true },
      { manager: 'pacman', args: ['-S', '--noconfirm', 'vice'], sudo: true },
      { manager: 'brew', args: ['install', 'vice'] },
    ],
  };
  // Neither apt-get nor pacman present, but brew (Linuxbrew) is: falls
  // through to the last option rather than stopping at the first miss.
  assert.deepEqual(
    pickInstallPlan(installer, 'linux', (bin) => bin === 'brew'),
    { manager: 'brew', args: ['install', 'vice'] },
  );
  // apt is checked as `apt-get` (the scriptable binary), not `apt`.
  assert.deepEqual(
    pickInstallPlan(installer, 'linux', (bin) => bin === 'apt-get'),
    { manager: 'apt', args: ['install', '-y', 'vice'], sudo: true },
  );
  assert.equal(pickInstallPlan(installer, 'linux', () => false), null);
});

test('pickInstallPlan: a build-from-source installer never gets an auto-install plan', () => {
  const installer = { buildFromSource: true, repo: 'https://example.invalid' };
  assert.equal(pickInstallPlan(installer, 'darwin', () => true), null);
  assert.equal(pickInstallPlan(installer, 'linux', () => true), null);
});

test('pickInstallPlan: an unsupported platform (or a missing installer) yields no plan', () => {
  assert.equal(pickInstallPlan({ darwin: { manager: 'brew', args: [] } }, 'win32', () => true), null);
  assert.equal(pickInstallPlan(null, 'darwin', () => true), null);
});

// vicePackageManagerVersion() is the fallback for `xvic --version` et al
// crashing outright on some Homebrew 3.9/3.10 bottles ("argv[0] is NULL,
// giving up" — vice-emu bug #2108) rather than printing anything parseable.
test('vicePackageManagerVersion: macOS asks brew when brew is on PATH', async () => {
  const calls = [];
  const version = await vicePackageManagerVersion({
    platform: 'darwin',
    hasBinary: (bin) => bin === 'brew',
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      return { code: 0, stdout: 'vice 3.10\n', stderr: '', missing: false };
    },
  });
  assert.deepEqual(version, [3, 10, 0]);
  assert.deepEqual(calls, [['brew', ['list', '--versions', 'vice']]]);
});

test('vicePackageManagerVersion: macOS without brew on PATH asks nothing and reports null', async () => {
  const version = await vicePackageManagerVersion({
    platform: 'darwin',
    hasBinary: () => false,
    exec: async () => { throw new Error('should not be called'); },
  });
  assert.equal(version, null);
});

test('vicePackageManagerVersion: linux tries dpkg first, then falls back to pacman', async () => {
  const version = await vicePackageManagerVersion({
    platform: 'linux',
    hasBinary: () => false,
    exec: async (cmd) => {
      if (cmd === 'dpkg-query') return { code: 1, stdout: '', stderr: 'dpkg-query: no packages found matching vice', missing: false };
      if (cmd === 'pacman') return { code: 0, stdout: 'vice 3.6-1\n', stderr: '', missing: false };
      throw new Error(`unexpected command ${cmd}`);
    },
  });
  // parseVersion reads the dotted "3.6"; the "-1" package-release suffix
  // after the dash isn't part of it.
  assert.deepEqual(version, [3, 6, 0]);
});

test('vicePackageManagerVersion: linux dpkg hit skips pacman entirely', async () => {
  const calls = [];
  const version = await vicePackageManagerVersion({
    platform: 'linux',
    hasBinary: () => false,
    exec: async (cmd, args) => {
      calls.push(cmd);
      if (cmd === 'dpkg-query') return { code: 0, stdout: '3.6', stderr: '', missing: false };
      return { code: 0, stdout: '', stderr: '', missing: false };
    },
  });
  assert.deepEqual(version, [3, 6, 0]);
  assert.deepEqual(calls, ['dpkg-query']);
});

test('vicePackageManagerVersion: no manager confirms a version — null, not a throw', async () => {
  const version = await vicePackageManagerVersion({
    platform: 'linux',
    hasBinary: () => false,
    exec: async () => ({ code: 1, stdout: '', stderr: 'not found', missing: true }),
  });
  assert.equal(version, null);
});

test('findMega65Rom: not found at either the canonical or Xemu-local path', async () => {
  const found = await findMega65Rom({
    canonicalPath: '/opt/mega65/MEGA65.ROM',
    linkPath: '/home/user/.xemu-lgb/MEGA65.ROM',
    read: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.equal(found, null);
});

test('findMega65Rom: checks the canonical install before the Xemu-local copy', async () => {
  const romBytes = Buffer.alloc(MEGA65_ROM_920413.romSize, 3);
  const reads = [];
  const found = await findMega65Rom({
    canonicalPath: '/opt/mega65/MEGA65.ROM',
    linkPath: '/home/user/.xemu-lgb/MEGA65.ROM',
    read: async (p) => { reads.push(p); return romBytes; },
  });
  assert.deepEqual(reads, ['/opt/mega65/MEGA65.ROM']);
  assert.equal(found.path, '/opt/mega65/MEGA65.ROM');
  assert.equal(found.validation.sha256, sha256Hex(romBytes));
});

test('findMega65Rom: falls back to the Xemu-local copy when the canonical path has nothing', async () => {
  const romBytes = Buffer.alloc(MEGA65_ROM_920413.romSize, 4);
  const found = await findMega65Rom({
    canonicalPath: '/opt/mega65/MEGA65.ROM',
    linkPath: '/home/user/.xemu-lgb/MEGA65.ROM',
    read: async (p) => {
      if (p === '/opt/mega65/MEGA65.ROM') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return romBytes;
    },
  });
  assert.equal(found.path, '/home/user/.xemu-lgb/MEGA65.ROM');
  assert.equal(found.validation.sha256, sha256Hex(romBytes));
});

test('findMega65Rom: a present-but-wrong ROM (e.g. an Open ROM) is found but fails validation', async () => {
  const found = await findMega65Rom({
    canonicalPath: '/opt/mega65/MEGA65.ROM',
    linkPath: '/home/user/.xemu-lgb/MEGA65.ROM',
    read: async () => Buffer.alloc(MEGA65_ROM_920413.romSize, 0xaa),
  });
  assert.equal(found.validation.ok, false);
});

test('readyTargets: mega65 is only ready when compiler, emulator, and ROM checks all pass', () => {
  const passing = [
    { status: 'ok', targets: ['mega65'] }, // mos-mega65-clang
    { status: 'ok', targets: ['mega65'] }, // xmega65
    { status: 'ok', targets: ['mega65'] }, // MEGA65 ROM
  ];
  assert.deepEqual(readyTargets(passing, ['mega65']), ['mega65']);

  for (let i = 0; i < passing.length; i += 1) {
    const withOneFailing = passing.map((c, j) => (i === j ? { ...c, status: 'fail' } : c));
    assert.deepEqual(
      readyTargets(withOneFailing, ['mega65']),
      [],
      `check ${i} failing must block mega65 readiness`,
    );
  }

  // xmega65 existing alone (the other two missing/failing) must not be enough.
  const onlyEmulator = [
    { status: 'fail', targets: ['mega65'] },
    { status: 'ok', targets: ['mega65'] },
    { status: 'fail', targets: ['mega65'] },
  ];
  assert.deepEqual(readyTargets(onlyEmulator, ['mega65']), []);
});

// ---- MEGA65 ------------------------------------------------------------
//
// checkMega65Target() with `find`/`inspectLink` faked — the four-check
// split the brief calls out explicitly: xmega65 existing, a ROM found
// *somewhere*, and Xemu actually being configured to see it are three
// separate facts, and the "not ready" summary should name whichever one
// actually failed.

test('checkMega65Target: nothing installed — xmega65 missing, ROM missing, link absent, not ready', async () => {
  const checks = byLabel(await checkMega65Target({
    hasEmulator: false,
    find: async () => null,
    inspectLink: async () => ({ state: 'absent' }),
  }));
  assert.equal(checks['xmega65 (MEGA65, via Xemu)'].status, 'fail');
  assert.equal(checks['MEGA65 ROM'].status, 'fail');
  assert.equal(checks['Xemu ROM link'].status, 'fail');
  assert.equal(checks.MEGA65.status, 'skip');
});

test('checkMega65Target: Xemu\'s own built-in 920000 stub ROM must not count as a full MEGA65 ROM', async () => {
  // Xemu falls back to its bundled Xemu-ROMs (version 920000) when it can't
  // open a real MEGA65.ROM — findMega65Rom() only ever looks at the
  // canonical/link paths this project manages, so the stub never surfaces
  // as a "found" ROM at all; this is the same as nothing being installed.
  const checks = byLabel(await checkMega65Target({
    hasEmulator: true,
    emulatorPath: '/usr/local/bin/xmega65',
    find: async () => null,
    inspectLink: async () => ({ state: 'absent' }),
  }));
  assert.equal(checks['xmega65 (MEGA65, via Xemu)'].status, 'ok');
  assert.equal(checks['xmega65 (MEGA65, via Xemu)'].detail, '/usr/local/bin/xmega65');
  assert.equal(checks['MEGA65 ROM'].status, 'fail');
  assert.equal(checks.MEGA65.status, 'skip');
});

test('checkMega65Target: canonical ROM installed but Xemu is not configured to see it — the real, tested gap', async () => {
  const checks = byLabel(await checkMega65Target({
    hasEmulator: true,
    emulatorPath: '/usr/local/bin/xmega65',
    find: async () => ({ path: '/opt/mega65/MEGA65.ROM', validation: { ok: true } }),
    inspectLink: async () => ({ state: 'absent' }),
  }));
  assert.equal(checks['MEGA65 ROM'].status, 'ok');
  assert.equal(checks['Xemu ROM link'].status, 'fail');
  assert.match(checks['Xemu ROM link'].hint, /--repair/);
  assert.equal(checks.MEGA65.status, 'skip');
});

test('checkMega65Target: canonical ROM valid and linked — every check passes, target ready', async () => {
  const checks = byLabel(await checkMega65Target({
    hasEmulator: true,
    emulatorPath: '/usr/local/bin/xmega65',
    find: async () => ({ path: '/opt/mega65/MEGA65.ROM', validation: { ok: true } }),
    inspectLink: async () => ({ state: 'linked' }),
  }));
  assert.equal(checks['xmega65 (MEGA65, via Xemu)'].status, 'ok');
  assert.equal(checks['MEGA65 ROM'].status, 'ok');
  assert.equal(checks['Xemu ROM link'].status, 'ok');
  assert.equal(checks.MEGA65.status, 'ok');
});

test('checkMega65Target: a ROM installed directly at the Xemu-local path (never linked to a canonical copy) is accepted', async () => {
  const checks = byLabel(await checkMega65Target({
    hasEmulator: true,
    emulatorPath: '/usr/local/bin/xmega65',
    find: async () => ({ path: '/home/user/.xemu-lgb/MEGA65.ROM', validation: { ok: true } }),
    inspectLink: async () => ({ state: 'migratable' }),
  }));
  assert.equal(checks['Xemu ROM link'].status, 'ok');
  assert.equal(checks.MEGA65.status, 'ok');
});

test('checkMega65Target: a wrong/foreign ROM at the Xemu-local path fails distinctly from "absent"', async () => {
  const checks = byLabel(await checkMega65Target({
    hasEmulator: true,
    emulatorPath: '/usr/local/bin/xmega65',
    find: async () => ({ path: '/opt/mega65/MEGA65.ROM', validation: { ok: true } }),
    inspectLink: async () => ({ state: 'foreign', target: '/some/other/rom' }),
  }));
  assert.equal(checks['Xemu ROM link'].status, 'fail');
  assert.match(checks['Xemu ROM link'].detail, /isn't the MEGA65 ROM/);
});

test('checkMega65Target: a present-but-wrong ROM (Open ROM, different release) fails MEGA65 ROM and blocks readiness', async () => {
  const checks = byLabel(await checkMega65Target({
    hasEmulator: true,
    emulatorPath: '/usr/local/bin/xmega65',
    find: async () => ({ path: '/opt/mega65/MEGA65.ROM', validation: { ok: false } }),
    inspectLink: async () => ({ state: 'linked' }),
  }));
  assert.equal(checks['MEGA65 ROM'].status, 'fail');
  assert.equal(checks.MEGA65.status, 'skip');
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

// ---- Commander X16 ----------------------------------------------------------
//
// checkCx16Target() with every boundary faked: PATH resolution, process
// execution, and the filesystem. Each scenario is a machine state from the
// setup brief; the launcher/boot pair is what distinguishes a working
// install from the tested-broken macOS symlink layout.

const VERSION_LINE = '### Release 50 ("next") 77f2bab3\n';
const BOOT_OK = 'Testbench mode...\nRDY\nExit testbench.\n';
const WRAPPER = '#!/bin/sh\nexec /opt/commander-x16/x16emu -rom /opt/commander-x16/rom.bin "$@"\n';

function cx16World({ platform = 'darwin', compilerOk = true, entries = {}, launcher = '/usr/local/bin/x16emu', bootOutput = BOOT_OK, bootCode = 0, versionOutput = VERSION_LINE, versionCode = 0 } = {}) {
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const stats = (e) => ({ isSymbolicLink: () => 'symlink' in e, isFile: () => 'file' in e, size: 'file' in e ? Buffer.byteLength(e.file) : 0 });
  const execCalls = [];
  return {
    execCalls,
    opts: {
      platform,
      compilerOk,
      resolveBinary: (name) => (name === 'x16emu' ? launcher : null),
      realpathFn: async (p) => (entries[p]?.symlink ?? p),
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        if (args.includes('-version')) return { code: versionCode, stdout: versionOutput, stderr: '', missing: false };
        if (args.includes('-testbench')) return { code: bootCode, stdout: bootOutput, stderr: '', missing: false };
        return { code: 0, stdout: '', stderr: '', missing: false };
      },
      fs: {
        statFn: async (p) => { if (!(p in entries)) throw missing(); return stats(entries[p]); },
        accessFn: async (p) => { if (!(p in entries)) throw missing(); },
        lstatFn: async (p) => { if (!(p in entries)) throw missing(); return stats(entries[p]); },
        readlinkFn: async (p) => entries[p].symlink,
        readFileFn: async (p) => entries[p].file,
      },
    },
  };
}

const byLabel = (checks) => Object.fromEntries(checks.map((c) => [c.label, c]));

test('checkCx16Target: macOS with x16emu missing — FAIL pointing at `8bs setup cx16`, no ROM/launcher/boot probes', async () => {
  const { opts, execCalls } = cx16World({ launcher: null });
  const checks = byLabel(await checkCx16Target(opts));
  assert.equal(checks['x16emu (Commander X16)'].status, 'fail');
  assert.match(checks['x16emu (Commander X16)'].hint, /run: 8bs setup cx16/);
  assert.equal(checks['Commander X16 ROM'].status, 'fail');
  assert.equal(checks['Commander X16 ROM'].hint, 'run: 8bs setup cx16');
  assert.equal(checks['Commander X16 launcher'], undefined);
  assert.equal(checks['Commander X16'].status, 'skip');
  assert.deepEqual(execCalls, []);
  assert.deepEqual(readyTargets(Object.values(checks), ['cx16']), []);
});

test('checkCx16Target: macOS with the emulator installed but the ROM missing — the specific "emulator installed but ROM is missing" FAIL', async () => {
  const { opts } = cx16World({ entries: { '/usr/local/bin/x16emu': { file: WRAPPER } }, bootOutput: 'Cannot open /opt/commander-x16/rom.bin!\n', bootCode: 1 });
  const checks = byLabel(await checkCx16Target(opts));
  assert.equal(checks['x16emu (Commander X16)'].status, 'ok');
  assert.equal(checks['Commander X16 ROM'].status, 'fail');
  assert.match(checks['Commander X16 ROM'].hint, /emulator installed but ROM is missing\n\s+run: 8bs setup cx16/);
  assert.equal(checks['Commander X16 boot'].status, 'fail');
  assert.equal(checks['Commander X16'].status, 'skip');
});

test('checkCx16Target: a valid /opt/commander-x16 installation with the wrapper — every check ok, target ready', async () => {
  const { opts, execCalls } = cx16World({ entries: {
    '/usr/local/bin/x16emu': { file: WRAPPER },
    '/opt/commander-x16/rom.bin': { file: 'x'.repeat(1024) },
  } });
  const checks = await checkCx16Target(opts);
  const c = byLabel(checks);
  assert.deepEqual(checks.map((x) => [x.label, x.status]), [
    ['x16emu (Commander X16)', 'ok'],
    ['Commander X16 ROM', 'ok'],
    ['Commander X16 launcher', 'ok'],
    ['x16emu version', 'ok'],
    ['Commander X16 boot', 'ok'],
    ['Commander X16', 'ok'],
  ]);
  assert.equal(c['x16emu (Commander X16)'].detail, '/usr/local/bin/x16emu');
  assert.equal(c['Commander X16 ROM'].detail, '/opt/commander-x16/rom.bin');
  assert.equal(c['Commander X16 launcher'].detail, 'wrapper, -rom /opt/commander-x16/rom.bin');
  assert.equal(c['x16emu version'].detail, 'Release 50');
  assert.equal(c['Commander X16'].detail, 'ready');
  assert.ok(checks.every((x) => x.targets.includes('cx16')));
  assert.deepEqual(readyTargets(checks, ['cx16']), ['cx16']);
  // The version and boot probes both go through the PATH command, as the user would.
  assert.deepEqual(execCalls, [['x16emu', ['-version']], ['x16emu', ['-testbench']]]);
});

test('checkCx16Target: the broken direct macOS symlink — FAIL launcher with the --repair hint, and the boot reproduces the real error', async () => {
  const { opts } = cx16World({
    entries: {
      '/usr/local/bin/x16emu': { symlink: '/opt/commander-x16/x16emu' },
      '/opt/commander-x16/rom.bin': { file: 'rom' },
    },
    bootOutput: 'Cannot open /usr/local/bin/rom.bin!\n', bootCode: 1,
  });
  const c = byLabel(await checkCx16Target(opts));
  assert.equal(c['Commander X16 launcher'].status, 'fail');
  assert.equal(c['Commander X16 launcher'].detail, 'x16emu is installed as a direct symlink and cannot locate rom.bin.');
  assert.equal(c['Commander X16 launcher'].hint, 'run: 8bs setup cx16 --repair');
  // `-version` alone still succeeds on this layout — which is exactly why it can't be the only probe.
  assert.equal(c['x16emu version'].status, 'ok');
  assert.equal(c['Commander X16 boot'].status, 'fail');
  assert.match(c['Commander X16 boot'].detail, /Cannot open \/usr\/local\/bin\/rom\.bin!|\/usr\/local\/bin\/rom\.bin/);
  assert.equal(c['Commander X16 boot'].hint, 'run: 8bs setup cx16 --repair');
  assert.equal(c['Commander X16'].status, 'skip');
});

test('checkCx16Target: on Linux the same direct symlink is the correct layout', async () => {
  const { opts } = cx16World({ platform: 'linux', entries: {
    '/usr/local/bin/x16emu': { symlink: '/opt/commander-x16/x16emu' },
    '/opt/commander-x16/rom.bin': { file: 'rom' },
  } });
  const c = byLabel(await checkCx16Target(opts));
  assert.equal(c['Commander X16 launcher'].status, 'ok');
  assert.equal(c['Commander X16 launcher'].detail, 'symlink -> /opt/commander-x16/x16emu');
  assert.equal(c['Commander X16'].status, 'ok');
});

test('checkCx16Target: `x16emu -version` success is reported as the release, whatever number it is', async () => {
  const { opts } = cx16World({ entries: { '/usr/local/bin/x16emu': { file: WRAPPER }, '/opt/commander-x16/rom.bin': { file: 'rom' } }, versionOutput: '### Release 51 ("next") abcdef01\n' });
  const c = byLabel(await checkCx16Target(opts));
  assert.equal(c['x16emu version'].status, 'ok');
  assert.equal(c['x16emu version'].detail, 'Release 51');
});

test('checkCx16Target: an empty rom.bin is not a usable ROM', async () => {
  const { opts } = cx16World({ entries: { '/usr/local/bin/x16emu': { file: WRAPPER }, '/opt/commander-x16/rom.bin': { file: '' } } });
  const c = byLabel(await checkCx16Target(opts));
  assert.equal(c['Commander X16 ROM'].status, 'fail');
  assert.match(c['Commander X16 ROM'].detail, /is an empty file/);
});

test('checkCx16Target: a rom.bin beside an unmanaged x16emu (e.g. an official release zip) is accepted, and said so', async () => {
  const { opts } = cx16World({ launcher: '/Users/u/x16/x16emu', entries: {
    '/Users/u/x16/x16emu': { file: '<binary>' },
    '/Users/u/x16/rom.bin': { file: 'rom' },
  } });
  const c = byLabel(await checkCx16Target(opts));
  assert.equal(c['Commander X16 ROM'].status, 'ok');
  assert.match(c['Commander X16 ROM'].detail, /beside x16emu/);
  assert.equal(c['Commander X16 launcher'].status, 'ok');
  assert.match(c['Commander X16 launcher'].detail, /not 8bs-managed/);
});

test('checkCx16Target: everything present but mos-cx16-clang missing — not ready', async () => {
  const { opts } = cx16World({ compilerOk: false, entries: { '/usr/local/bin/x16emu': { file: WRAPPER }, '/opt/commander-x16/rom.bin': { file: 'rom' } } });
  const c = byLabel(await checkCx16Target(opts));
  assert.equal(c['Commander X16'].status, 'skip');
  assert.match(c['Commander X16'].detail, /mos-cx16-clang must pass first/);
});

test('parseX16emuVersion / romLoadFailure / testbenchBooted: the real r50 output shapes', () => {
  assert.equal(parseX16emuVersion('### Release 50 ("next") 77f2bab3'), 'Release 50');
  assert.equal(parseX16emuVersion('Commander X16 Emulator r50 (next), 77f2bab3'), null);
  assert.equal(parseX16emuVersion(''), null);
  assert.equal(romLoadFailure('Cannot open /usr/local/bin/rom.bin!\n'), '/usr/local/bin/rom.bin');
  assert.equal(romLoadFailure('Testbench mode...\nRDY\n'), null);
  assert.equal(testbenchBooted({ code: 0, output: 'Testbench mode...\nRDY\nExit testbench.\n' }), true);
  assert.equal(testbenchBooted({ code: 1, output: 'Cannot open /usr/local/bin/rom.bin!\n' }), false);
  assert.equal(testbenchBooted({ code: 0, output: '' }), false);
});
