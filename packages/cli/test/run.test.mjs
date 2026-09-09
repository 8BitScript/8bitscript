// `run()`'s own logic — argument parsing failures, the atari800 display
// config helper, and the screenshot-throws path — as opposed to the VICE
// flags themselves (run-model.test.mjs) or the real CLI path against actual
// emulators (screenshot.test.mjs). The emulator-dispatch branches below
// (VICE/atari8/nes/cx16/mega65's argv construction and the child_process
// spawn) are currently unreachable: every one of those targets is parked in
// this release (build.mjs's RELEASE_MACHINES), so compile() always refuses
// before run() ever reaches them — see screenshot.test.mjs's parked-target
// tests for that refusal. Nothing here fakes past that; it comes back once
// a target un-parks for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, atari800CleanDisplayConfig } from '../src/run.mjs';

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
