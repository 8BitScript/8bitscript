// One test per target for `8bs run <target> --screenshot <file>` — the
// real CLI path (not screenshot.mjs's internals directly), against a real
// build, confirming an actual PNG lands on disk. See
// docs/setup/verify.md#screenshots for what this feature is and why each
// target's mechanism differs; see emulator-smoke.test.mjs for the same
// skip convention this file follows.
//
// pet, c64, vic20, cx16, and web build in this release (RELEASE_MACHINES).
// Remaining
// machines compile too; `--screenshot` is wired (VICE, MAME `-str`,
// openMSX Tcl, or macOS window capture) and skip-if-missing when the
// host binary or ROM set is not there. web is a genuine skip: its native
// WebAssembly backend isn't implemented yet, so `8bs run web` cannot
// build at all (captureScreenshot's own logic is covered directly,
// against a hand-built wasm fixture, in web-screenshot.test.mjs and
// wasm-host.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emulatorFor } from '../src/hardware.mjs';
import { releaseTargetList } from '../src/release.mjs';
import { mameCaptureArgs, openmsxCaptureScript, waitSeconds } from '../src/screenshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(HERE, '..', 'bin', '8bs.mjs');
const NATIVE_BACKEND_PENDING = 'Bare Metal: waiting on the native backend';

// A self-contained program (no package imports, so it builds from any
// scratch directory without workspace resolution): sums 0..9 into RAM.
// Matches the SUM fixture compile.test.mjs already uses for the same reason.
const PROBE_SOURCE = [
  'let sum: utinyint = 0;',
  'export function main(): void {',
  '    for (let i: utinyint = 0; i < 10; i++) {',
  '        sum = sum + i;',
  '    }',
  '    memory.write(0x8000, sum);',
  '}',
  '',
].join('\n');

function onPath(name) {
  const binary = process.platform === 'win32' ? `${name}.exe` : name;
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, binary)));
}

function runCli(args, { cwd = HERE, timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

function isPng(path) {
  const buf = readFileSync(path);
  return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

async function withProbe(fn) {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-shot-test-'));
  try {
    const entry = join(scratch, 'main.8bs');
    await writeFile(entry, PROBE_SOURCE);
    return await fn(scratch, entry);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const PARKED_TARGETS = ['c128', 'plus4', 'mega65', 'atari8', 'nes', 'gb'];

for (const target of PARKED_TARGETS) {
  test(`${target}: --screenshot refuses to build — parked until a later release`, async () => {
    await withProbe(async (scratch, entry) => {
      const shot = join(scratch, 'out.png');
      const { code, stdout, stderr } = await runCli(['run', target, entry, '--screenshot', shot]);
      assert.notEqual(code, 0, `expected ${target} to refuse:\n${stdout}${stderr}`);
      assert.match(
        stderr,
        new RegExp(`is not a target in this release\\. This release builds for ${releaseTargetList().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        `unexpected refusal message for ${target}:\n${stderr}`,
      );
      assert.equal(existsSync(shot), false, `${target} should not have written a screenshot`);
    });
  });
}

for (const [target, emulator] of [['c64', 'x64sc'], ['vic20', 'xvic'], ['cx16', 'x16emu']]) {
  test(`${target}: --screenshot produces a PNG via ${emulator}`, async (t) => {
    if (!onPath(emulator)) { t.skip(`${emulator} not on PATH`); return; }
    await withProbe(async (scratch, entry) => {
      const shot = join(scratch, 'out.png');
      const { code, stdout, stderr } = await runCli(['run', target, entry, '--screenshot', shot], { timeoutMs: 120_000 });
      assert.equal(code, 0, `8bs run ${target} --screenshot failed:\n${stdout}${stderr}`);
      assert.ok(existsSync(shot), `no screenshot written:\n${stdout}${stderr}`);
      assert.ok(isPng(shot), 'output is not a valid PNG');
    });
  });
}

test('pet: --screenshot produces a PNG via xpet', async (t) => {
  if (!onPath('xpet')) { t.skip('xpet not on PATH'); return; }
  await withProbe(async (scratch, entry) => {
    const shot = join(scratch, 'out.png');
    const { code, stdout, stderr } = await runCli(['run', 'pet', entry, '--screenshot', shot]);
    assert.equal(code, 0, `8bs run pet --screenshot failed:\n${stdout}${stderr}`);
    assert.ok(existsSync(shot), `no screenshot written:\n${stdout}${stderr}`);
    assert.ok(isPng(shot), 'output is not a valid PNG');
  });
});

// atari8 is parked (see PARKED_TARGETS above), so its cartridge/media
// handling can't be exercised through the real CLI right now — kept here,
// skipped for that specific reason, as the regression guard for once it
// un-parks: the XEGS build is a cartridge image, not an executable, and the
// catalog's `load` swapping `-run <xex>` for `-cart <rom> -cart-type 23`
// once regressed silently (without the cart type atari800 stops at its
// cartridge menu and the screenshot shows the menu instead of the program).
test(
  'atari8: --hardware media=xegs256 builds a cartridge and screenshots it',
  { skip: 'atari8 is parked until a later release — restore once it un-parks' },
  async (t) => {
    if (!onPath('atari800')) { t.skip('atari800 not on PATH'); return; }
    await withProbe(async (scratch, entry) => {
      const shot = join(scratch, 'out.png');
      const { code, stdout, stderr } = await runCli(
        ['run', 'atari8', entry, '--hardware', 'media=xegs256', '--screenshot', shot],
        { timeoutMs: 30_000 },
      );
      assert.equal(code, 0, `8bs run atari8 --hardware media=xegs256 --screenshot failed:\n${stdout}${stderr}`);
      assert.match(stdout, /built .*-atari8-xegs256-ntsc\.rom/, 'XEGS build did not produce a .rom named for the medium');
      assert.ok(isPng(shot), 'output is not a valid PNG');
    });
  },
);

test('web: --screenshot produces a PNG with no emulator at all', { skip: NATIVE_BACKEND_PENDING }, async () => {
  await withProbe(async (scratch, entry) => {
    const shot = join(scratch, 'out.png');
    const { code, stdout, stderr } = await runCli(['run', 'web', entry, '--screenshot', shot]);
    assert.equal(code, 0, `8bs run web --screenshot failed:\n${stdout}${stderr}`);
    assert.ok(isPng(shot), 'output is not a valid PNG');
  });
});

test('mameCaptureArgs puts a cartridge on -cart and never a software-list positional', () => {
  const { seconds, args } = mameCaptureArgs('coleco', '/tmp/game.col', '/tmp/scratch');
  assert.equal(seconds, emulatorFor('coleco').defaultFrames);
  assert.equal(args[0], 'coleco');
  assert.ok(args.includes('-cart'));
  assert.equal(args[args.indexOf('-cart') + 1], '/tmp/game.col');
  assert.ok(args.includes('-seconds_to_run'));
  assert.ok(!args.includes('/tmp/game.col') || args[args.indexOf('/tmp/game.col') - 1] === '-cart');
});

test('mameCaptureArgs for apple2 boots the system without a host-file positional', () => {
  const { args } = mameCaptureArgs('apple2', '/tmp/game.bin', '/tmp/scratch');
  assert.equal(args[0], 'apple2e');
  assert.ok(!args.includes('/tmp/game.bin'));
  assert.ok(!args.includes('-cart'));
});

test('mameCaptureArgs for oric uses -cass', () => {
  const { args } = mameCaptureArgs('oric', '/tmp/game.tap', '/tmp/scratch');
  assert.equal(args[args.indexOf('-cass') + 1], '/tmp/game.tap');
});

test('openmsxCaptureScript writes a raw screenshot then exits', () => {
  const tcl = openmsxCaptureScript('/tmp/out.png', 3);
  assert.match(tcl, /screenshot -raw \{\/tmp\/out\.png\}/);
  assert.match(tcl, /after realtime 3/);
  assert.match(tcl, /exit/);
});

test('waitSeconds converts catalog frames at 60 Hz', () => {
  assert.equal(waitSeconds('coleco', undefined), 8);
  assert.equal(waitSeconds('msx', 180), 3);
});

test('window screenshot names macOS when the host is not darwin', async (t) => {
  if (process.platform === 'darwin') {
    t.skip('this host is macOS; the error is for other platforms');
    return;
  }
  await assert.rejects(
    async () => {
      const { captureScreenshot } = await import('../src/screenshot.mjs');
      await captureScreenshot('atari2600', '/tmp/x.a26', '/tmp/x.png');
    },
    /macOS/,
  );
});
