// What each machine actually does for audio.setLevel() and audio.blip(), measured headlessly
// (capture.mjs). A test skips when its emulator is not installed, which is every CI run: the CI
// gate for the same promise is packages/compiler/test/audio-tone.test.mjs (every twin states
// LEVEL_MAX and the plucked envelope / fade in its source) and packages/cli/test/web-audio.test.mjs
// (the web voice's timeline, run end to end).
//
// The program: level 6; a 6-frame blip of A4 (frame 30, after an emulator's start-up); a 3-frame
// blip of A5 (frame 70); level 15 and a plain 10-frame tone of A4 (frame 110); level 0 and a plain
// tone (frame 170), which must make no sound at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { haveBinary, viceDump, viceWav, x16Wav } from './capture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, '..', '..', '..');
const CLI = join(CHECKOUT, 'packages', 'cli', 'bin', '8bs.mjs');
const darwin = process.platform === 'darwin';

const PROGRAM = `import { audio } from "@8bitscript/audio";
import { screen } from "@8bitscript/screen";

export function main(): void {
    screen.blank();
    audio.setLevel(6);
    let n: usmallint = 0;
    while (true) {
        waitFrame();
        audio.update();
        n = n + 1;
        if (n == 30) {
            audio.blip(57, 6);
        }
        if (n == 70) {
            audio.blip(69, 3);
        }
        if (n == 110) {
            audio.setLevel(15);
            audio.tone(57, 10);
        }
        if (n == 170) {
            audio.setLevel(0);
            audio.tone(57, 10);
        }
    }
}
`;

function build(target, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-audio-level-'));
  writeFileSync(join(dir, 'level.8bs'), PROGRAM);
  const result = spawnSync('node', [CLI, 'build', '--target', target, '--checkout', CHECKOUT, ...extra, 'level.8bs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, `${target} build:\n${result.stderr}`);
  const prg = readdirSync(join(dir, 'dist')).find((f) => f.endsWith('.prg'));
  assert.ok(prg, `${target}: a .prg was built`);
  return { dir, prg: join(dir, 'dist', prg) };
}

// The values a register was written with, in order, collapsing repeats.
const writes = (events, reg) => events.filter((e) => e.reg === reg).map((e) => e.value).filter((v, i, all) => i === 0 || v !== all[i - 1]);

test('C64: the master volume follows setLevel; a blip has no sustain and a plain tone puts the sustained envelope back', { skip: !haveBinary('x64sc'), timeout: 120000 }, () => {
  const { dir, prg } = build('c64');
  try {
    const events = viceDump('x64sc', prg, { cycles: 12_000_000, modelArgs: ['-model', 'ntsc'] });
    const volume = writes(events, 24).map((v) => v & 15);
    assert.deepEqual(volume.slice(volume.indexOf(6)), [6, 15, 0], 'volume 6, then 15, then 0');
    // Voice 0 attack/decay (register 5) and sustain/release (register 6): the blip of 6 frames decays at rate 4,
    // the blip of 3 at rate 3, both with sustain 0 and release 2; the plain tone is the sustained 0/9, 8/6.
    const ad = writes(events, 5);
    const sr = writes(events, 6);
    assert.deepEqual(ad.slice(ad.indexOf(0x04)), [0x04, 0x03, 0x09], 'attack 0, decay by length, then the tone\'s 9');
    assert.deepEqual(sr.slice(sr.indexOf(0x02)), [0x02, 0x86], 'sustain 0 release 2 for a blip, sustain 8 release 6 for a tone');
    // Every note is a gate on and a gate off: nothing is left open at the end.
    const gates = events.filter((e) => e.reg === 4).map((e) => e.value & 1);
    assert.equal(gates.at(-1), 0, 'the gate is closed when the run ends');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('VIC-20: setLevel sets the one volume; a blip walks it down a step a frame and puts the level back', { skip: !haveBinary('xvic'), timeout: 120000 }, () => {
  const { dir, prg } = build('vic20');
  try {
    const events = viceDump('xvic', prg, { cycles: 12_000_000, modelArgs: ['-model', 'vic20ntsc'] });
    const volume = events.filter((e) => e.reg === 14).map((e) => e.value & 15);
    // First blip: 6 (the call), then 5 4 3 2 1 (one a frame), then 6 (the level, put back).
    const at = volume.indexOf(5);
    assert.ok(at > 0, `the fade starts (saw ${volume})`);
    assert.deepEqual(volume.slice(at, at + 5), [5, 4, 3, 2, 1], 'one step a frame');
    assert.equal(volume[at + 5], 6, 'the level is put back when the blip ends');
    assert.ok(volume.includes(15), 'setLevel(15) is heard');
    assert.equal(volume.at(-1), 0, 'and setLevel(0) is the last volume');
    const voice = events.filter((e) => e.reg === 12).map((e) => e.value >= 128);
    assert.equal(voice.at(-1), false, 'the voice is off when the run ends');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('X16: a level-6 blip is quieter than a level-15 tone, and level 0 plays nothing', { skip: !haveBinary('x16emu'), timeout: 120000 }, async () => {
  const { dir, prg } = build('cx16');
  try {
    const wave = await x16Wav(prg, { ms: 9000 });
    // The recording's own segmenter ignores anything under a quarter of the loudest sound, which is
    // exactly what a quiet blip is, so look at the peak in 0.1 s windows instead and group them.
    const windows = [];
    for (let t = 0; t + 0.1 <= wave.seconds; t += 0.1) windows.push({ t, peak: wave.measure(t, t + 0.1).peak });
    const sounding = windows.filter((w) => w.peak > 100);
    const groups = [];
    for (const w of sounding) {
      const last = groups.at(-1);
      if (last && w.t - last.end <= 0.25) { last.end = w.t; last.peak = Math.max(last.peak, w.peak); } else groups.push({ start: w.t, end: w.t, peak: w.peak });
    }
    assert.equal(groups.length, 3, `three sounds, the fourth is muted (saw ${JSON.stringify(groups)})`);
    const [blip, second, tone] = groups;
    assert.ok(blip.peak < 0.4 * tone.peak, `a level-6 blip (${blip.peak}) is much quieter than a level-15 tone (${tone.peak})`);
    assert.ok(second.peak < 0.4 * tone.peak, `and so is the second (${second.peak})`);
    assert.ok(wave.seconds - tone.end > 1, 'nothing sounds after the tone: level 0 is silence and the tone was over');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PET 4032: one bit has two levels, so a blip is a tone, and level 0 plays nothing', { skip: !haveBinary('xpet') || !darwin, timeout: 120000 }, () => {
  const { dir, prg } = build('pet', ['--profile', '4032']);
  try {
    const wave = viceWav('xpet', prg, { cycles: 12_000_000, modelArgs: ['-model', '4032', '-ramsize', '32'] });
    assert.equal(wave.segments.length, 3, `three sounds, the fourth is muted (saw ${wave.segments.length})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
