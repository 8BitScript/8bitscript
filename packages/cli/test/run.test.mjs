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

import { run, boot, atari800CleanDisplayConfig, emulatorInvocation } from '../src/run.mjs';
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

test('boot() refuses a parked target by name, the same as build()/run() do', async () => {
  const { result, stderr } = await capture(() => boot(['c64']));
  assert.equal(result, 2);
  assert.match(stderr, /^8bs boot: 'c64' is not a target in this release\. 0\.2\.0 builds for pet and web only/);
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
