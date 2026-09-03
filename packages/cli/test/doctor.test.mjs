// Unit tests for the doctor's pure helpers. The full command shells out to
// real toolchains, so its branches are exercised against fakes by hand; what
// must never regress silently is the version arithmetic these checks stand on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseVersion, atLeast, findLocalBin, pickInstallPlan, findMega65Rom, readyTargets,
} from '../src/doctor.mjs';
import { MEGA65_ROM_920413, sha256Hex } from '../src/setup/rom.mjs';

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
