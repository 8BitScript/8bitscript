// What each machine does with a `.8ba` song, measured headlessly (capture.mjs). A test skips when its
// emulator is not installed, which is every CI run: the CI gates for the same promises are
// packages/cli/test/web-audio.test.mjs (the sequencer frame by frame on the web host) and
// packages/compiler/test/media-songs.test.mjs (the bytes, the handles, the bank).
//
// The song: 3 frames a row, a C4 held for rows 0-1 (a triangle at volume 9), an E4 on row 2, a rest on
// row 3, a G4 on rows 4-5 (a saw at volume 15), rests, and then it is over. It is played ONCE at frame 30
// (after an emulator's start-up) and the program then sits in its loop. Everything after the song
// is silence, and the harness checks that the chip really is quiet at the end.
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

const songsText = (bright) => `instrument chime { waveform triangle volume 9 }
instrument saw { waveform ${bright} volume 15 }

song win {
  speed 3
  loop false
  order { main }
  pattern main length 8 {
    track lead {
      row 0 { note C4; instrument chime; length 2; }
      row 2 { note E4; }
      row 4 { note G4; instrument saw; length 2; }
    }
  }
}
`;

const PROGRAM = `import { win } from "./songs.8ba";
import { audio } from "@8bitscript/audio";
import { screen } from "@8bitscript/screen";

export function main(): void {
    screen.blank();
    let n: usmallint = 0;
    while (true) {
        waitFrame();
        audio.update();
        n = n + 1;
        if (n == 30) {
            audio.play(win);
        }
    }
}
`;

// The VIC-I has three squares and a noise voice: no saw, and the build says so (8BS2212), so its G4 is a pulse.
function build(target, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-audio-songs-'));
  writeFileSync(join(dir, 'songs.8ba'), songsText(target === 'vic20' ? 'pulse' : 'saw'));
  writeFileSync(join(dir, 'song.8bs'), PROGRAM);
  const result = spawnSync('node', [CLI, 'build', '--target', target, '--checkout', CHECKOUT, ...extra, 'song.8bs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, `${target} build:\n${result.stderr}`);
  const prg = readdirSync(join(dir, 'dist')).find((f) => f.endsWith('.prg'));
  assert.ok(prg, `${target}: a .prg was built`);
  return { dir, prg: join(dir, 'dist', prg) };
}

const within = (measured, note, limit, label) => assert.ok(Math.abs(cents(measured, noteHz(note))) <= limit, `${label}: ${measured.toFixed(1)} Hz is ${cents(measured, noteHz(note)).toFixed(0)} cents from ${noteHz(note).toFixed(1)} Hz`);

test('C64: three notes on SID, each its pitch, waveform and volume, for its rows, then the gate stays shut', { skip: !haveBinary('x64sc'), timeout: 120000 }, () => {
  const { dir, prg } = build('c64');
  try {
    const events = viceDump('x64sc', prg, { cycles: 12_000_000, modelArgs: ['-model', 'ntsc'] });
    const tones = sidTones(events);
    assert.equal(tones.length, 3, `three notes (saw ${tones.length})`);
    [57 - 9, 57 - 5, 57 - 2].forEach((note, i) => within(tones[i].hz, note, 3, `note ${i}`)); // C4, E4, G4
    // Lengths: the C4 holds 2 rows of 3 frames, the E4 and the G4... measured in frames of about 17,0xx cycles.
    const frames = tones.map((t) => t.cycles / 17090);
    assert.ok(Math.abs(frames[0] - 6) <= 1.2 && Math.abs(frames[1] - 3) <= 1.2 && Math.abs(frames[2] - 6) <= 1.2, `lengths in frames: ${frames.map((f) => f.toFixed(1))}`);
    // The master volume follows each note's volume (9, 9, 15 under level 15).
    const volume = events.filter((e) => e.reg === 24).map((e) => e.value & 15);
    assert.ok(volume.includes(9) && volume.includes(15), `volumes 9 and 15 were set (saw ${[...new Set(volume)]})`);
    // Waveforms: the control register's waveform bits, 0x10 triangle for the chime, 0x20 saw for the saw.
    const control = events.filter((e) => e.reg === 4).map((e) => e.value & 0xf0);
    assert.ok(control.includes(0x10) && control.includes(0x20), `triangle and saw were selected (saw ${[...new Set(control)].map((v) => v.toString(16))})`);
    assert.equal(events.filter((e) => e.reg === 4).at(-1).value & 1, 0, 'the gate is shut when the run ends');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('VIC-20: three notes on the soprano, then it falls silent', { skip: !haveBinary('xvic'), timeout: 120000 }, () => {
  const { dir, prg } = build('vic20');
  try {
    const events = viceDump('xvic', prg, { cycles: 12_000_000, modelArgs: ['-model', 'vic20ntsc'] });
    const tones = vicTones(events, 12);
    assert.equal(tones.length, 3, `three notes (saw ${tones.length})`);
    [48, 52, 55].forEach((note, i) => within(tones[i].hz, note, 60, `note ${i}`));
    const frames = tones.map((t) => t.cycles / 17050);
    assert.ok(Math.abs(frames[0] - 6) <= 1.2 && Math.abs(frames[1] - 3) <= 1.2 && Math.abs(frames[2] - 6) <= 1.2, `lengths in frames: ${frames.map((f) => f.toFixed(1))}`);
    const volume = events.filter((e) => e.reg === 14).map((e) => e.value & 15);
    assert.ok(volume.includes(9) && volume.includes(15), `the volume follows each note (saw ${[...new Set(volume)]})`);
    assert.equal(events.filter((e) => e.reg === 12).at(-1).value < 128, true, 'the voice is off when the run ends');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The notes a recording plays, in order: the pitch in short sliding windows, a note a pitch that holds for
// three windows in a row, runs of one note counted once (as scripts/slot-sound.mjs in vegas-nights does).
function plateaus(wave) {
  const heard = [];
  let run = 0;
  let previous = null;
  for (let t = 0; t + 0.02 <= wave.seconds; t += 0.006) {
    const got = wave.measure(t, t + 0.02);
    const note = got.cycles >= 2 && got.frequency > 50 ? Math.round(57 + 12 * Math.log2(got.frequency / 440)) : null;
    run = note !== null && note === previous ? run + 1 : 1;
    previous = note;
    if (note !== null && run === 3 && heard.at(-1) !== note) heard.push(note);
  }
  return heard;
}

test('X16: the song is C4, E4, G4 in that order, a bounded sound, and then silence', { skip: !haveBinary('x16emu'), timeout: 120000 }, async () => {
  const { dir, prg } = build('cx16');
  try {
    const wave = await x16Wav(prg, { ms: 9000 });
    assert.deepEqual(plateaus(wave), [48, 52, 55], 'the three notes of the song, in order');
    const last = wave.segments.at(-1);
    assert.ok(last, 'something was heard');
    assert.ok(wave.seconds - last.end > 1, 'silence after the song');
    assert.ok(last.seconds < 0.6, `the song is short (${last.seconds.toFixed(2)} s)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PET 4032: the same two sounds on the one-bit speaker, and silence after', { skip: !haveBinary('xpet') || !darwin, timeout: 120000 }, () => {
  const { dir, prg } = build('pet', ['--profile', '4032']);
  try {
    const wave = viceWav('xpet', prg, { cycles: 12_000_000, modelArgs: ['-model', '4032', '-ramsize', '32'] });
    assert.equal(wave.segments.length, 2, `two sounds (saw ${wave.segments.length})`);
    within(wave.segments[1].frequency, 55, 35, 'the G4');
    assert.ok(wave.seconds - wave.segments[1].end > 1, 'silence after the song');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
