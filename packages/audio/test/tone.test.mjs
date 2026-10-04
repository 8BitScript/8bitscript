// What each machine actually plays for audio.tone(), measured headlessly
// (capture.mjs). A test skips when its emulator is not installed, which is
// every CI run: the gate for the same promise there is
// packages/compiler/test/audio-tone.test.mjs, which checks the pitch tables
// against the chip formulas these tests confirmed on the emulators.
//
// The program plays A4 (note 57) for 30 frames, waits, then A5 (note 69) for
// 20 frames. Measured under VICE 3.10 and x16emu r50, 2026-10-04:
//   C64     SID Fn 7218 -> 440.0 Hz, 14436 -> 879.9 Hz   (register dump)
//   VIC-20  soprano divisor 36 -> 443.5 Hz, 18 -> 887.6  (dump and recorded WAV)
//   PET     T2 140 -> 441.0 Hz, 880.5 Hz                  (recorded WAV)
//   X16     PSG word 1181 -> 439.9 Hz, 881.0 Hz           (recorded WAV)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { haveBinary, viceDump, viceWav, x16Wav, sidTones, vicTones, cents, noteHz } from './capture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, '..', '..', '..');
const CLI = join(CHECKOUT, 'packages', 'cli', 'bin', '8bs.mjs');
const darwin = process.platform === 'darwin';

const PROGRAM = `import { audio } from "@8bitscript/audio";
import { screen } from "@8bitscript/screen";

export function main(): void {
    screen.blank();
    audio.tone(57, 30);
    let n: utinyint = 0;
    while (true) {
        waitFrame();
        audio.update();
        n = n + 1;
        if (n == 90) {
            audio.tone(69, 20);
        }
    }
}
`;

// Builds the program for `target` in a scratch directory and returns the .prg.
function build(target, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-audio-tone-'));
  writeFileSync(join(dir, 'tone.8bs'), PROGRAM);
  const result = spawnSync('node', [CLI, 'build', '--target', target, '--checkout', CHECKOUT, ...extra, 'tone.8bs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, `${target} build:\n${result.stderr}`);
  const prg = readdirSync(join(dir, 'dist')).find((f) => f.endsWith('.prg'));
  assert.ok(prg, `${target}: a .prg was built`);
  return { dir, prg: join(dir, 'dist', prg) };
}

function within(measured, note, limit, label) {
  assert.ok(Math.abs(cents(measured, noteHz(note))) <= limit, `${label}: ${measured.toFixed(1)} Hz is ${cents(measured, noteHz(note)).toFixed(0)} cents from ${noteHz(note).toFixed(1)} Hz (limit ${limit})`);
}

test('C64: two SID tones, A4 then A5, from the register dump, 30 and 20 frames long', { skip: !haveBinary('x64sc'), timeout: 120000 }, () => {
  const { dir, prg } = build('c64');
  try {
    const tones = sidTones(viceDump('x64sc', prg, { cycles: 10_000_000, modelArgs: ['-model', 'ntsc'] }));
    assert.ok(tones.length >= 2, `two tones (saw ${tones.length})`);
    within(tones[0].hz, 57, 1, 'first tone');
    within(tones[1].hz, 69, 1, 'second tone');
    // A frame is about 17,0xx cycles on NTSC; the gate stays open for `frames` calls of update().
    const frames = tones.slice(0, 2).map((t) => t.cycles / 17090);
    assert.ok(Math.abs(frames[0] - 30) <= 2 && Math.abs(frames[1] - 20) <= 2, `lengths in frames: ${frames}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('VIC-20: two soprano tones from the register dump, one octave apart, to within 25 cents', { skip: !haveBinary('xvic'), timeout: 120000 }, () => {
  const { dir, prg } = build('vic20');
  try {
    const events = viceDump('xvic', prg, { cycles: 7_000_000, modelArgs: ['-model', 'vic20ntsc'] });
    const tones = vicTones(events, 12);
    assert.ok(tones.length >= 2, `two tones (saw ${tones.length})`);
    within(tones[0].hz, 57, 25, 'first tone');
    within(tones[1].hz, 69, 25, 'second tone');
    assert.ok(Math.abs(cents(tones[1].hz, tones[0].hz) - 1200) <= 40, 'an octave apart');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('VIC-20: the recorded waveform plays the pitch the register dump predicts', { skip: !haveBinary('xvic') || !darwin, timeout: 120000 }, () => {
  const { dir, prg } = build('vic20');
  try {
    const wave = viceWav('xvic', prg, { cycles: 7_000_000, modelArgs: ['-model', 'vic20ntsc'] });
    assert.ok(wave.peak > 50, `audible (peak ${wave.peak})`);
    assert.ok(wave.segments.length >= 2, `two tones (saw ${wave.segments.length})`);
    within(wave.segments[0].frequency, 57, 25, 'first tone');
    within(wave.segments[1].frequency, 69, 25, 'second tone');
    assert.ok(Math.abs(wave.segments[0].seconds - 0.5) <= 0.1 && Math.abs(wave.segments[1].seconds - 0.33) <= 0.1, `lengths ${wave.segments.map((s) => s.seconds)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PET 4032 with a speaker: the CB2 square wave plays A4 then A5, to within 15 cents', { skip: !haveBinary('xpet') || !darwin, timeout: 120000 }, () => {
  const { dir, prg } = build('pet', ['--profile', '4032']);
  try {
    const wave = viceWav('xpet', prg, { cycles: 7_000_000, modelArgs: ['-model', '4032', '-ramsize', '32'] });
    assert.ok(wave.peak > 20, `audible (peak ${wave.peak})`);
    assert.ok(wave.segments.length >= 2, `two tones (saw ${wave.segments.length})`);
    within(wave.segments[0].frequency, 57, 15, 'first tone');
    within(wave.segments[1].frequency, 69, 15, 'second tone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('X16: the VERA PSG plays A4 then A5, to within 10 cents', { skip: !haveBinary('x16emu'), timeout: 120000 }, async () => {
  const { dir, prg } = build('cx16');
  try {
    const wave = await x16Wav(prg, { ms: 6500 });
    assert.ok(wave.peak > 1000, `audible (peak ${wave.peak})`);
    assert.ok(wave.segments.length >= 2, `two tones (saw ${wave.segments.length})`);
    within(wave.segments[0].frequency, 57, 10, 'first tone');
    within(wave.segments[1].frequency, 69, 10, 'second tone');
    assert.ok(Math.abs(wave.segments[0].seconds - 0.5) <= 0.1 && Math.abs(wave.segments[1].seconds - 0.33) <= 0.1, `lengths ${wave.segments.map((s) => s.seconds)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
