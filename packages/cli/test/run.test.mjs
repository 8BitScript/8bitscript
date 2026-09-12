// `run()`/`boot()`'s own logic — argument parsing failures, the atari800
// display config helper, the screenshot-throws path, and `emulatorInvocation`
// (the shared argv construction both share) — as opposed to the VICE model
// flags themselves (run-model.test.mjs) or the real CLI path against actual
// emulators (screenshot.test.mjs, and this session's own manual `8bs boot
// pet --profile 8032` check against a real xpet window). The PET is a
// released target (build.mjs's RELEASE_MACHINES), so its own dispatch
// branch is real and covered directly below; the other VICE/atari8/nes/
// cx16/mega65 branches stay parked and untested here until they un-park —
// nothing here fakes past that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  run, boot, atari800CleanDisplayConfig, atari800CleanDisplayText, emulatorInvocation, resolveController,
} from '../src/run.mjs';
import { loadCatalog, resolveHardware } from '../src/hardware.mjs';

function capture(fn) {
  const stdout = [];
  const stderr = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  }).then((result) => ({ result, stdout: stdout.join(''), stderr: stderr.join('') }));
}

const SUM = [
  'let sum: utinyint = 0;',
  'export function main(): void {',
  '    for (let i: utinyint = 0; i < 10; i++) {',
  '        sum = sum + i;',
  '    }',
  '    memory.write(0x8000, sum);',
  '}',
  '',
].join('\n');

test('run() returns 2 and writes the error when --hardware/--profile parsing fails', async () => {
  const { result, stderr } = await capture(() => run(['--profile']));
  assert.equal(result, 2);
  assert.match(stderr, /^8bs run: --profile expects a name/);
});

test('run() returns 2 and writes the error when --frames is not a number', async () => {
  const { result, stderr } = await capture(() => run(['--frames', 'soon']));
  assert.equal(result, 2);
  assert.match(stderr, /^8bs run: --frames expects a number, got 'soon'/);
});

test('run() with no target prints usage and returns 2', async () => {
  const { result, stdout, stderr } = await capture(() => run(['--pal']));
  assert.equal(result, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /^Usage: 8bs run <pet\|web>/);
  assert.match(stderr, /\[--size\]/, 'run --size is the breakdown before the emulator starts');
});

test('run() --screenshot to an unwritable path reports the error and returns 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-run-test-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), SUM);
    process.chdir(dir);
    const badPath = join(dir, 'does-not-exist', 'out.png');
    const { result, stdout, stderr } = await capture(() => run(['pet', 'main.8bs', '--screenshot', badPath, '--no-open']));
    assert.equal(result, 1);
    assert.match(stdout, /^built /, 'compile() should still have run and reported the build');
    assert.notEqual(stderr, '', 'captureScreenshot\'s failure should be reported');
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test('emulatorInvocation for the PET carries the model/ram/speaker/drive flags and, given an outFile, autostarts it', async () => {
  const { hardware } = resolveHardware(loadCatalog('pet'), { profile: '8032' });
  const invocation = await emulatorInvocation('pet', { pal: false, hardware, outFile: '/tmp/x.prg' });
  assert.equal(invocation.ok, true);
  assert.equal(invocation.emulator, 'xpet');
  assert.deepEqual(invocation.emulatorArgs, [
    '-autostartprgmode', '1',
    '-model', '8032', '-ramsize', '32', '-sound', '-drive8type', '0',
    '+confirmonexit',
    '-autostart', '/tmp/x.prg',
  ]);
});

test('emulatorInvocation re-opens a muted VICE sound device when the catalog said +sound — host pacing, not a speaker', async () => {
  const { hardware } = resolveHardware(loadCatalog('pet'), { profile: '2001' });
  assert.ok(hardware.run.xpet.includes('+sound'), 'stock 2001 catalog names no speaker');
  const invocation = await emulatorInvocation('pet', { pal: false, hardware });
  assert.equal(invocation.ok, true);
  const args = invocation.emulatorArgs;
  const plus = args.indexOf('+sound');
  const dash = args.lastIndexOf('-sound');
  assert.ok(plus >= 0, 'catalog +sound stays so a speaker-less PET is still named');
  assert.ok(dash > plus, 'a later -sound opens the host audio clock');
  assert.deepEqual(args.slice(dash, dash + 3), ['-sound', '-soundvolume', '0']);
});

test('emulatorInvocation for the PET with no outFile carries the same hardware flags and nothing to load', async () => {
  const { hardware } = resolveHardware(loadCatalog('pet'), { profile: '8032' });
  const invocation = await emulatorInvocation('pet', { pal: false, hardware });
  assert.equal(invocation.ok, true);
  assert.deepEqual(invocation.emulatorArgs, [
    '-autostartprgmode', '1',
    '-model', '8032', '-ramsize', '32', '-sound', '-drive8type', '0',
    '+confirmonexit',
  ]);
});

test('emulatorInvocation for the PET fitted with a real disk drive passes VICE its own -drive8type name', async () => {
  const { hardware } = resolveHardware(loadCatalog('pet'), { overrides: { drive: '8050' } });
  const invocation = await emulatorInvocation('pet', { pal: false, hardware });
  assert.ok(invocation.emulatorArgs.includes('-drive8type'));
  assert.equal(invocation.emulatorArgs[invocation.emulatorArgs.indexOf('-drive8type') + 1], '8050');
});

test('emulatorInvocation names a target with no emulator wired up', async () => {
  const invocation = await emulatorInvocation('made-up', { pal: false, hardware: { run: {} } });
  assert.equal(invocation.ok, false);
  assert.match(invocation.error, /no emulator wired up for target 'made-up'/);
});

test('boot() returns 2 and writes the error when --hardware/--profile parsing fails', async () => {
  const { result, stderr } = await capture(() => boot(['--profile']));
  assert.equal(result, 2);
  assert.match(stderr, /^8bs boot: --profile expects a name/);
});

test('boot() with no target prints usage and returns 2', async () => {
  const { result, stdout, stderr } = await capture(() => boot(['--pal']));
  assert.equal(result, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /^Usage: 8bs boot <pet>/);
});

test('boot() refuses the web target by name — there is no bare emulator to boot without a program', async () => {
  const { result, stderr } = await capture(() => boot(['web']));
  assert.equal(result, 2);
  assert.match(stderr, /^8bs boot: the web target has no bare emulator/);
});

test('boot() refuses an unknown target, naming every real one', async () => {
  const { result, stderr } = await capture(() => boot(['not-a-machine']));
  assert.equal(result, 2);
  assert.match(stderr, /^8bs boot: unknown target 'not-a-machine'/);
});

// There are no parked targets left — every machine the toolchain knows now
// builds — so the refusal this used to check is unreachable, and naming any
// real machine here would LAUNCH ITS EMULATOR and wait for a human to close
// it. That is not hypothetical: it is what this test did the moment the NES
// un-parked, and it turned a 30-second suite into a 30-minute one. An
// unknown name is the case that will always exist, and it is already
// covered by the test above; what is left to check here is that the parked
// branch still refuses when RELEASE_MACHINES does not list something.
test('boot() refuses a target the release does not build, without launching anything', async () => {
  const { result, stderr } = await capture(() => boot(['zx81']));
  assert.equal(result, 2);
  assert.match(stderr, /^8bs boot: unknown target 'zx81'/);
});

test('boot() prints the PET region note but still boots — its refresh is the model\'s, not a --pal/--ntsc flag', async () => {
  const { stderr } = await capture(() => boot(['pet', '--pal', '--profile', 'made-up-nonexistent-preset']));
  assert.match(stderr, /the PET has no --pal\/--ntsc/);
  // The made-up preset is refused by resolveHardware right after — proof
  // this ran past the region note and into real hardware resolution, not
  // just an early return.
  assert.match(stderr, /made-up-nonexistent-preset/);
});

test('atari800CleanDisplayConfig returns null when there is no ~/.atari800.cfg', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-home-test-'));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = dir;
    assert.equal(await atari800CleanDisplayConfig(), null);
  } finally {
    process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test('atari800CleanDisplayConfig zeroes the CRT knobs, replacing existing keys and appending missing ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-home-test-'));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = dir;
    await writeFile(
      join(dir, '.atari800.cfg'),
      'REFRESH_RATE=1\nCRT_BEAM_SHAPE=1\nCRT_PHOSPHOR_GLOW=50\n',
    );
    const outPath = await atari800CleanDisplayConfig();
    assert.ok(outPath, 'expected a cleaned config path');
    assert.ok(existsSync(outPath));
    const cleaned = await readFile(outPath, 'utf8');
    assert.match(cleaned, /^REFRESH_RATE=1$/m, 'unrelated keys are left alone');
    assert.match(cleaned, /^CRT_BEAM_SHAPE=0$/m, 'an existing key is replaced in place');
    assert.match(cleaned, /^CRT_PHOSPHOR_GLOW=0$/m);
    assert.match(cleaned, /^SCANLINES_PERCENTAGE=0$/m, 'a missing key is appended');
    assert.match(cleaned, /^INTERPOLATE_SCANLINES=0$/m);
    await rm(outPath, { force: true });
  } finally {
    process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test('run() --size prints the breakdown before the emulator path, and writes it into last-run', async () => {
  const { lastRunPath } = await import('../src/last-run.mjs');
  const dir = await mkdtemp(join(tmpdir(), '8bs-run-size-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), SUM);
    process.chdir(dir);
    const badPath = join(dir, 'does-not-exist', 'out.png');
    const { result, stdout, stderr } = await capture(() => run([
      'pet', 'main.8bs', '--size', '--screenshot', badPath, '--no-open',
    ]));
    assert.equal(result, 1);
    assert.match(stdout, /size breakdown:/);
    assert.match(stdout, /^built /, 'the breakdown is under the memory line, before screenshot/emulator');
    const report = JSON.parse(await readFile(lastRunPath('pet', dir), 'utf8'));
    assert.ok(report.size.length > 0);
    assert.ok(stderr.length > 0, 'screenshot still fails after the report is written');
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

// The controller profile's own path through run.mjs: resolveController()
// reading the project's config, and emulatorInvocation() placing the
// adapter's flags. Argument vectors only — controllers.test.mjs covers
// what each adapter decides, and nothing on either side starts an
// emulator.

test('emulatorInvocation is byte-identical when the project has no controller profile', async () => {
  const { hardware } = resolveHardware(loadCatalog('pet'), { profile: '8032' });
  const without = await emulatorInvocation('pet', { pal: false, hardware, outFile: '/tmp/x.prg' });
  const empty = await emulatorInvocation('pet', {
    pal: false, hardware, outFile: '/tmp/x.prg', controller: { args: [], files: [], notes: [] },
  });
  assert.deepEqual(empty.emulatorArgs, without.emulatorArgs, 'the default and an empty profile are the same launch');
});

test('emulatorInvocation puts the controller flags after the catalog\'s own, before the file', async () => {
  const { hardware } = resolveHardware(loadCatalog('c64'), {});
  const invocation = await emulatorInvocation('c64', {
    pal: false,
    hardware,
    outFile: '/tmp/x.prg',
    controller: { args: ['-joydev2', '4'], leadingArgs: ['-config', '/tmp/j.vicerc'], files: [], notes: [] },
  });
  assert.equal(invocation.ok, true);
  const args = invocation.emulatorArgs;
  // The catalog says what is *in* the port (-controlport2device 1); the
  // adapter says what drives it (-joydev2 4). The catalog's comes first,
  // so the more specific thing is said last.
  assert.deepEqual(args.slice(0, 2), ['-config', '/tmp/j.vicerc'], 'VICE reads -config only as the first argument');
  const catalogPort = args.indexOf('-controlport2device');
  const joydev = args.indexOf('-joydev2');
  assert.ok(catalogPort >= 0, 'packages/c64\'s port2 option is still the one naming the device');
  assert.ok(joydev > catalogPort, 'controller flags follow hardware.run[emulator]');
  assert.ok(args.indexOf('-autostart') > joydev, 'and the file is still last');
});

test('resolveController is empty without the panel\'s file, and reads one when it is there', async () => {
  const { hardware } = resolveHardware(loadCatalog('c64'), {});
  const dir = await mkdtemp(join(tmpdir(), '8bs-controllers-test-'));
  try {
    assert.deepEqual(
      await resolveController('c64', { hardware, dir }),
      { ok: true, args: [], leadingArgs: [], files: [], notes: [] },
      'no 8bitscript.controllers.json is every project written before this release',
    );

    await writeFile(join(dir, '8bitscript.controllers.json'), JSON.stringify({
      version: 1,
      controllers: {
        devices: [{ id: 'pad-a', name: 'SN30 Pro', player: 1, mode: 'standard', mapping: { a: 'button:0' } }],
      },
    }));
    const resolved = await resolveController('c64', { hardware, dir });
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.args, ['-joydev2', '4'], 'player 1 is port 2 on a C64, driven by host joystick 0');
    assert.equal(resolved.leadingArgs[0], '-config', 'VICE reads -config only when it leads the line');
    assert.equal(resolved.files.length, 2, 'a joystick map and the vicerc that names it');
    assert.ok(resolved.files[0].path.endsWith('.vjm'));
    assert.ok(resolved.files[0].path.includes(String(process.pid)), 'pid-named: pnpm test runs these in parallel');
    assert.match(resolved.files[1].contents, /^\[C64SC\]$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveController reports a profile this machine cannot honour instead of launching it', async () => {
  const { hardware } = resolveHardware(loadCatalog('c64'), {});
  const dir = await mkdtemp(join(tmpdir(), '8bs-controllers-test-'));
  try {
    // Player 2 lands in port 1, which a stock C64 has nothing in.
    await writeFile(join(dir, '8bitscript.controllers.json'), JSON.stringify({
      controllers: {
        devices: [
          { id: 'a', name: 'One', player: 1, mapping: { a: 'button:0' } },
          { id: 'b', name: 'Two', player: 2, mapping: { a: 'button:0' } },
        ],
      },
    }));
    const resolved = await resolveController('c64', { hardware, dir });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /Add --hardware port1=joystick/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveController names an unreadable controllers file rather than launching without it', async () => {
  const { hardware } = resolveHardware(loadCatalog('c64'), {});
  const dir = await mkdtemp(join(tmpdir(), '8bs-controllers-test-'));
  try {
    await writeFile(join(dir, '8bitscript.controllers.json'), '{ not json');
    const resolved = await resolveController('c64', { hardware, dir });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /cannot read 8bitscript\.controllers\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('atari800\'s controller config replaces the display one rather than passing -config twice', async () => {
  const { hardware } = resolveHardware(loadCatalog('atari8'), {});
  const invocation = await emulatorInvocation('atari8', {
    pal: false,
    hardware,
    controller: {
      args: ['-kbdjoy0'],
      leadingArgs: ['-config', '/tmp/a.cfg', '-no-autosave-config'],
      files: [{ path: '/tmp/a.cfg', contents: '' }],
      notes: [],
    },
  });
  assert.equal(invocation.ok, true);
  assert.equal(
    invocation.emulatorArgs.filter((arg) => arg === '-config').length,
    1,
    'atari800 takes one -config, and the controller\'s file already holds the cleaned display keys',
  );
  const args = invocation.emulatorArgs;
  assert.deepEqual(args.slice(0, 3), ['-config', '/tmp/a.cfg', '-no-autosave-config'], 'the config leads');
  // The catalog's own atari800 flags (the model, the mouse) still come
  // before the controller's ordinary flags.
  assert.ok(args.indexOf('-kbdjoy0') > args.indexOf('-xl'), 'controller flags follow hardware.run.atari800');
});

test('atari800CleanDisplayText is the display half on its own, for the file the controller adapter extends', () => {
  const cleaned = atari800CleanDisplayText('ROM_OS_B=/roms/os.rom\nCRT_BEAM_SHAPE=10\n');
  assert.match(cleaned, /^ROM_OS_B=\/roms\/os\.rom$/m);
  assert.match(cleaned, /^CRT_BEAM_SHAPE=0$/m);
  assert.match(cleaned, /^SCANLINES_PERCENTAGE=0$/m);
});

test('a pad-only atari800 profile writes no config, so the display-only one is still the file passed', async () => {
  const { hardware } = resolveHardware(loadCatalog('atari8'), {});
  // What atari800Controller returns for a pad: flags, and nothing to
  // write, because the only keys it has are for a keyboard stick. The
  // CRT-knob config must still be the one atari800 is pointed at.
  const invocation = await emulatorInvocation('atari8', {
    pal: false,
    hardware,
    controller: { args: ['-no-kbdjoy0'], leadingArgs: [], files: [], notes: [] },
  });
  assert.equal(invocation.ok, true);
  const args = invocation.emulatorArgs;
  assert.ok(args.includes('-no-kbdjoy0'));
  const configs = args.filter((arg) => arg === '-config');
  assert.equal(configs.length, existsSync(join(process.env.HOME ?? '', '.atari800.cfg')) ? 1 : 0,
    'exactly the display config when the user has one, and none when they do not');
  if (configs.length === 1) {
    assert.ok(args.indexOf('-config') < args.indexOf('-no-kbdjoy0'), 'the display config still leads');
  }
});
