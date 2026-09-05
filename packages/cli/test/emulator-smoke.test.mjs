// One smoke test per target emulator: build examples/borders for real
// through the actual `8bs` CLI (not the internal compile() function — this
// is meant to exercise exactly what a user's `8bs run <target>` does), then
// launch that target's real emulator headlessly and confirm it actually
// boots and runs the program, rather than merely existing on PATH.
//
// This closes, for every target, the same gap doctor.mjs's own "VIC-20
// boot" check exists to close for one target (see its file header): a
// version string is not proof a build is usable, and an emulator that
// starts is not proof it loaded anything. Skipped, not failed, on a machine
// missing the relevant emulator or SDK driver — `8bs doctor` is what
// reports that gap; this suite is meant to run wherever doctor reports a
// target ready, not to gate CI on hardware nobody installed.
//
// Every emulator here is a real GUI program with no CI-style "assert and
// exit" mode this project could find for atari800/xmega65/fceux (x16emu is
// the one exception — see its own test below), so every one of them is
// bounded by a hard timeout, and "still running when the timeout hit" is
// the SUCCESS case for anything without its own clean-exit flag (atari800,
// mega65), not a failure. The timeout stops the emulator in two stages:
// SIGTERM first, then SIGKILL a moment later if it is still alive. Both
// stages are needed. xmega65 block-buffers its log when stdout is a pipe
// and only flushes it on a clean exit, so a bare SIGKILL (what doctor.mjs's
// own `run()` helper uses — it never boots xmega65) throws away every line
// the mega65 test below asserts on; observed in this project's own testing
// as zero bytes of output under SIGKILL versus the full log, with exit code
// 0, well under 100ms after a SIGTERM. And SIGTERM alone was found
// unreliable (fceux especially — observed hanging well past a
// `timeout`-sent SIGTERM), hence the SIGKILL backstop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(HERE, '..', 'bin', '8bs.mjs');
const BORDERS_DIR = join(HERE, '..', '..', '..', 'examples', 'borders');

function onPath(name) {
  const binary = process.platform === 'win32' ? `${name}.exe` : name;
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, binary)));
}

const HAS_SDK = Boolean(process.env.LLVM_MOS_HOME);

/**
 * Build examples/borders for `target` through the real CLI, exactly the
 * way `8bs build --target <target> [--profile <profile>]` would from that
 * project's own directory. Returns the built file's path, parsed from the
 * CLI's own "built <path>" line rather than reconstructed here, so this
 * test can't drift out of sync with build.mjs's naming rules.
 */
function build(target, { profile } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ['build', '--target', target, ...(profile ? ['--profile', profile] : [])];
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: BORDERS_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`8bs build --target ${target} failed (exit ${code}):\n${stdout}${stderr}`));
        return;
      }
      const match = /^built (.+)$/m.exec(stdout);
      if (!match) {
        rejectPromise(new Error(`8bs build --target ${target}: could not find a "built <path>" line:\n${stdout}`));
        return;
      }
      resolvePromise(match[1]);
    });
    child.on('error', rejectPromise);
  });
}

/** How long a SIGTERMed emulator gets to flush and exit before SIGKILL. */
const KILL_GRACE_MS = 2000;

/**
 * Spawn an emulator, collect all output, and stop it after `timeoutMs`:
 * SIGTERM, then SIGKILL after KILL_GRACE_MS if it is still running (see the
 * file header for why both).
 */
function runEmulator(command, args, { timeoutMs = 4000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolvePromise({ missing: true, output: '', timedOut: false, code: null });
      return;
    }
    let output = '';
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    const clearTimers = () => { clearTimeout(timer); clearTimeout(killTimer); };
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', () => {
      clearTimers();
      resolvePromise({ missing: true, output, timedOut, code: null });
    });
    child.on('close', (code) => {
      clearTimers();
      resolvePromise({ missing: false, output, timedOut, code });
    });
  });
}

// ---- VIC-20 / C64 / PET / C128 (VICE) --------------------------------------
//
// The exact technique doctor.mjs's own VIC-20 boot check uses (see its file
// header for the two GTK3-vs-SDL build gotchas this depends on), applied to
// all four VICE machines rather than just one, and against a real built
// program instead of a synthetic one.

const VICE_EMULATOR = { vic20: 'xvic', c64: 'x64sc', pet: 'xpet', c128: 'x128' };

for (const [target, emulator] of Object.entries(VICE_EMULATOR)) {
  test(`${target}: ${emulator} boots and loads a real build`, { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async (t) => {
    if (!onPath(emulator)) {
      t.skip(`${emulator} not on PATH`);
      return;
    }
    const outFile = await build(target);
    const help = await runEmulator(emulator, ['-help'], { timeoutMs: 5000 });
    const screenshotFlag = /-exitscreenshot\b/.test(help.output)
      ? '-exitscreenshot'
      : /-exitscreenshotname\b/.test(help.output) ? '-exitscreenshotname' : null;

    const scratch = await mkdtemp(join(tmpdir(), '8bs-emu-test-'));
    try {
      const shot = join(scratch, 'boot.png');
      const args = [
        '-default', '-warp', '+sound', '-limitcycles', '8000000',
        '-autostartprgmode', '1', '+confirmonexit', '-autostart', outFile,
      ];
      if (screenshotFlag) args.push(screenshotFlag, shot);
      const result = await runEmulator(emulator, args, { timeoutMs: 30_000 });
      assert.ok(!result.missing, `${emulator} is not installed`);
      assert.ok(!result.timedOut, `${emulator} did not reach its cycle limit within 30s`);
      assert.doesNotMatch(result.output, /cannot load system file|sysfile.*error/i, result.output.slice(-500));
      const booted = (screenshotFlag && existsSync(shot)) || /cycle limit reached/i.test(result.output);
      assert.ok(booted, `${emulator} did not reach the cycle limit or produce a screenshot:\n${result.output.slice(-500)}`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

// ---- Atari 8-bit (atari800) -------------------------------------------------
//
// atari800 has no documented "run N frames then exit cleanly" flag this
// project found (see docs/setup/atari8.md), so this test just confirms it
// launches, actually finds/loads the built .xex (a bad load prints a
// distinct error line — verified against a real "unknown/invalid" file in
// this project's own testing), and is still running — not crashed back to
// a shell prompt — when the timeout kills it.

test('atari8: atari800 boots and loads a real build', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async (t) => {
  if (!onPath('atari800')) { t.skip('atari800 not on PATH'); return; }
  const outFile = await build('atari8');
  const result = await runEmulator('atari800', ['-xl', '-ntsc', '-run', outFile], { timeoutMs: 4000 });
  assert.ok(!result.missing, 'atari800 is not installed');
  assert.ok(result.timedOut, `atari800 exited on its own instead of still running:\n${result.output.slice(-500)}`);
  assert.doesNotMatch(result.output, /error|invalid|cannot (open|load)/i, result.output.slice(-500));
});

// ---- Commander X16 (x16emu) -------------------------------------------------
//
// x16emu is the one emulator here with a documented headless flag
// (`-testbench`), but this project could not confirm its external-test-
// runner protocol from `x16emu -h` alone, so this test instead uses
// `-echo raw`, which echoes the emulated text screen to stdout — verified
// in this project's own testing to print the BASIC boot banner and a
// "READY." prompt right after the built .prg is loaded and RUN, which is
// enough to prove the ROM/emulator pairing works and the program actually
// loaded, without needing the testbench protocol.

test('cx16: x16emu boots and loads a real build', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async (t) => {
  if (!onPath('x16emu')) { t.skip('x16emu not on PATH'); return; }
  const outFile = await build('cx16');
  const result = await runEmulator('x16emu', ['-prg', outFile, '-run', '-echo', 'raw'], { timeoutMs: 4000 });
  assert.ok(!result.missing, 'x16emu is not installed');
  assert.doesNotMatch(result.output, /error|usage:/i, result.output.slice(-500));
  assert.match(result.output, /READY\./, `x16emu never reached a READY. prompt:\n${result.output.slice(-500)}`);
});

// ---- MEGA65 (Xemu's xmega65) ------------------------------------------------
//
// `-headless` plus `-prg` autoloads the built .prg the same way `8bs run
// mega65` does; Xemu's own logging (verified in this project's own testing)
// announces the autoload by registering an 'READY.' injection event for the
// file, naming its load address and byte count straight from the .prg
// header — proof the build is a well-formed, loadable program, not just
// that a file exists — and, given enough boot time within the timeout,
// reports actually firing that event once BASIC reaches READY. (observed
// in this project's own testing to sometimes not happen within 6s, which
// is why "registering" alone is accepted and "hit" isn't required).
test('mega65: xmega65 boots and loads a real build', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async (t) => {
  if (!onPath('xmega65')) { t.skip('xmega65 not on PATH'); return; }
  const outFile = await build('mega65');
  const result = await runEmulator('xmega65', ['-headless', '-prg', outFile], { timeoutMs: 8000 });
  assert.ok(!result.missing, 'xmega65 is not installed');
  assert.doesNotMatch(result.output, /PANIC|abort|segmentation fault/i, result.output.slice(-500));
  assert.match(
    result.output,
    /INJECT: (registering 'READY\.' event|hit 'READY\.' trigger)/,
    `xmega65 never recognized the build as a loadable PRG:\n${result.output.slice(-500)}`,
  );
});

// ---- NES (FCEUX) -------------------------------------------------------------
//
// KNOWN GAP: unlike every emulator above, this project found no output from
// FCEUX — success or failure — that distinguishes a loaded ROM from a
// missing one: a nonexistent filename was observed, in this project's own
// testing, to leave FCEUX sitting open exactly as it does for a real ROM,
// with no stderr message either way. So this check only proves FCEUX
// itself launches and doesn't crash against the file; the real correctness
// check for the NES build is the static iNES-header assertion below, which
// needs no emulator at all.

test('nes: the build is a well-formed iNES ROM (NROM: 32K PRG, 8K CHR)', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async () => {
  const outFile = await build('nes');
  const rom = readFileSync(outFile);
  assert.equal(rom.slice(0, 4).toString('latin1'), 'NES\x1a', 'missing the iNES magic number');
  assert.equal(rom[4], 2, 'expected 2 x 16K PRG-ROM banks (32K, this NROM build)');
  assert.equal(rom[5], 1, 'expected 1 x 8K CHR-ROM bank');
});

test('nes: fceux launches against a real build without crashing', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async (t) => {
  if (!onPath('fceux')) { t.skip('fceux not on PATH'); return; }
  const outFile = await build('nes');
  const result = await runEmulator('fceux', [outFile], { timeoutMs: 3000 });
  assert.ok(!result.missing, 'fceux is not installed');
  assert.ok(result.timedOut, `fceux exited on its own instead of still running:\n${result.output.slice(-500)}`);
  assert.doesNotMatch(result.output, /segmentation fault|core dumped/i, result.output.slice(-500));
});

// ---- Web (Node's own WebAssembly runtime) -----------------------------------
//
// Not an emulator — the web target's runtime IS a WebAssembly host, so this
// exercises the .wasm build directly the way `8bs run web --screenshot`
// does: run the program's one exported function with a bounded waitFrame()
// (packages/cli/src/wasm-host.mjs) for a few frames and check the exported
// `ticks` global actually moved — the same observable behaviour every other
// target's screen shows.

test('web: the build runs in Node\'s WebAssembly runtime and waitFrame() paces it', async () => {
  const outFile = await build('web');
  const bytes = readFileSync(outFile);
  const { runProgram } = await import('../src/wasm-host.mjs');
  const { instance, entryName, usesWaitFrame, memory } = await runProgram(bytes, { frames: 31 });
  assert.equal(entryName, 'main');
  assert.equal(usesWaitFrame, true);
  assert.ok(memory.buffer instanceof SharedArrayBuffer, 'a waitFrame() program has shared memory');
  // 31 frames is one tick (seconds(0.5) = 30 at the default 60Hz) plus one.
  assert.equal(instance.exports.ticks.value, 1, 'ticks did not advance after 31 waitFrame() calls');
});
