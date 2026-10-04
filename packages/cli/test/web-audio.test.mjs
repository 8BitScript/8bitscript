// audio.tone() on the web host, end to end and rule by rule.
//
// The synthetic web host has no speaker in a headless run, and a real browser
// tab was not available to listen to. What is held here instead is every step
// between the program and the speaker, each against its own source of truth:
//   1. the registers' place in the agreement, the layout the page, the CLI and
//      the .8bs geometry files must all state the same way;
//   2. the mapping from four bytes to a frequency, waveform and level
//      (web-audio.mjs), and the loader's hand-copy of it;
//   3. what the page does with that mapping: one oscillator, made when the
//      voice first sounds, re-pitched and re-levelled from the registers,
//      driven here with a stand-in AudioContext;
//   4. a real program, compiled by the native web backend and stepped one
//      logical frame at a time, whose register timeline renders to samples
//      that measure at the pitch and length the program asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { compile } from '../src/build.mjs';
import { instantiateProgram, FrameLimitReached } from '../src/wasm-host.mjs';
import { renderLoader } from '../src/web-loader.mjs';
import { renderVoice, toneHz, voiceState } from '../src/web-audio.mjs';
import {
  AUDIO_BYTES, AudioRegister, DEFAULT_LAYOUT, GLYPH_BYTES, MACHINE_HOST, agreementFor, layoutForRealMachine, layoutFromHardware, sidecarJson,
} from '../src/web-layout.mjs';
import { dataBaseFor } from '@8bitscript/compiler/wasm';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const SRC = join(REPO, 'packages', 'web', 'src');

const CLI_LINE = /^(built |memory: |size breakdown|web bundle: |8bs build: )/;
function silently(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : out(chunk, ...rest));
  process.stderr.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : err(chunk, ...rest));
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  });
}

function loadLoader(options) {
  const self = {};
  runInNewContext(renderLoader(options), { self, console });
  return self.EightBitScript;
}

const cents = (a, b) => 1200 * Math.log2(a / b);
// A value from the loader's VM realm, as plain data (its objects have another realm's prototypes).
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---- 1. the layout ------------------------------------------------------------

test('the tone registers are four bytes right after the glyph table, on the synthetic hosts only', () => {
  assert.equal(AUDIO_BYTES, 4);
  assert.deepEqual(AudioRegister, { GATE: 0, NOTE: 1, WAVE: 2, VOLUME: 3 });
  const without = agreementFor({ resizable: true, userGlyphs: true });
  assert.equal(without.audioBase, -1, 'no region unless asked for');
  assert.equal(without.reservedEnd, 9032);
  const modern = agreementFor({ resizable: true, userGlyphs: true, audio: true });
  assert.equal(modern.audioBase, modern.glyphBase + GLYPH_BYTES);
  assert.equal(modern.audioBase, 9032);
  assert.equal(modern.reservedEnd, 9032 + AUDIO_BYTES);
  const hifi = layoutFromHardware({ facts: {}, options: { machine: 'hifi' } });
  assert.equal(hifi.audioBase, 9032, 'the Modern host');
  assert.equal(dataBaseFor(hifi.reservedEnd), 9216, 'the program data still starts on its 256-byte boundary');
  assert.equal(DEFAULT_LAYOUT.audioBase, DEFAULT_LAYOUT.glyphBase + GLYPH_BYTES, 'the fixed default layout carries it too');
  assert.equal(agreementFor({ audio: true }).audioBase, agreementFor({}).reservedEnd, 'with no glyph table, right after the raster list');
});

test('every synthetic skin has the region and a real machine\'s own build has none', () => {
  for (const machine of Object.keys(MACHINE_HOST)) {
    const layout = layoutFromHardware({ facts: {}, options: { machine } });
    assert.equal(layout.audioBase, layout.glyphBase + GLYPH_BYTES, machine);
    assert.equal(layout.reservedEnd, layout.audioBase + AUDIO_BYTES, machine);
    assert.ok(dataBaseFor(layout.reservedEnd) >= layout.reservedEnd, `${machine}: program data clear of the registers`);
  }
  for (const target of ['pet', 'vic20', 'c64']) {
    assert.equal(layoutForRealMachine(target).audioBase, -1, `${target}'s own --web build`);
  }
  assert.equal(sidecarJson(layoutFromHardware({ facts: {}, options: { machine: 'hifi' } })).audioBase, 9032, 'the page is told where the registers are');
});

test('the .8bs geometry files state the same AUDIO_BASE the layout computes', () => {
  const geometry = {
    hifi: 'geometry.8bs',
    'pet-2001': 'geometry.web.pet-2001.8bs',
    c64: 'geometry.web.c64.8bs',
    vic20: 'geometry.web.vic20.8bs',
  };
  for (const [machine, file] of Object.entries(geometry)) {
    const stated = Number(/const AUDIO_BASE: usmallint = (\d+);/.exec(readFileSync(join(SRC, file), 'utf8'))[1]);
    const layout = layoutFromHardware({ facts: machine === 'hifi' ? {} : MACHINE_FACTS[machine], options: { machine } });
    assert.equal(stated, layout.audioBase, `${machine} (${file})`);
  }
});

// The columns and rows each skin's geometry file was written for.
const MACHINE_FACTS = {
  'pet-2001': { 'video.columns': 40, 'video.rows': 25 },
  c64: { 'video.columns': 40, 'video.rows': 25 },
  vic20: { 'video.columns': 22, 'video.rows': 23 },
};

// ---- 2. the mapping ------------------------------------------------------------

test('toneHz is equal temperament with A4 (note 57) at 440 Hz', () => {
  assert.equal(toneHz(57), 440);
  assert.equal(toneHz(69), 880);
  assert.ok(Math.abs(toneHz(48) - 261.6256) < 0.001, 'C4');
  assert.ok(Math.abs(toneHz(0) - 16.3516) < 0.001, 'C0');
});

test('voiceState: the gate and the volume both have to be on, the wave byte picks the shape, the level scales with the volume', () => {
  const mem = new Uint8Array(16);
  const at = 4;
  assert.deepEqual(voiceState(mem, at), { on: false, hz: toneHz(0), wave: 'square', level: 0 });
  mem[at] = 1; mem[at + 1] = 57; mem[at + 3] = 15;
  assert.deepEqual(voiceState(mem, at), { on: true, hz: 440, wave: 'square', level: 0.5 });
  mem[at + 2] = 1;
  assert.equal(voiceState(mem, at).wave, 'triangle');
  mem[at + 2] = 2;
  assert.equal(voiceState(mem, at).wave, 'sawtooth');
  mem[at + 2] = 9;
  assert.equal(voiceState(mem, at).wave, 'square', 'a wave byte with no meaning is the square');
  mem[at + 3] = 0;
  assert.equal(voiceState(mem, at).on, false, 'volume 0 is silence');
  mem[at + 3] = 7 | 0xF0;
  assert.ok(Math.abs(voiceState(mem, at).level - (7 / 15) * 0.5) < 1e-12, 'only the low four bits of the volume count');
  mem[at] = 0;
  assert.equal(voiceState(mem, at).on, false, 'gate off is silence');
  assert.deepEqual(voiceState(mem, -1), { on: false, hz: 0, wave: 'square', level: 0 }, 'a host with no region is silent');
});

test('renderVoice: a held note is one unbroken wave at its pitch, silence between notes is zeros, and frames are 1/60 s', () => {
  const rate = 48000;
  const A4 = { on: true, hz: 440, wave: 'square', level: 0.5 };
  const rest = { on: false, hz: 0, wave: 'square', level: 0 };
  const samples = renderVoice([...Array(30).fill(A4), ...Array(30).fill(rest)], { sampleRate: rate, frameRate: 60 });
  assert.equal(samples.length, rate, 'sixty frames at 60 Hz is one second');
  const half = rate / 2;
  let crossings = 0;
  for (let i = 1; i < half; i += 1) if (samples[i - 1] < 0 && samples[i] >= 0) crossings += 1;
  assert.ok(Math.abs(crossings - 220) <= 1, `440 Hz for half a second is 220 cycles (${crossings})`);
  assert.equal(Math.max(...samples.slice(half + 10).map(Math.abs)), 0, 'the rest is silent');
  assert.equal(Math.max(...samples.slice(0, half).map(Math.abs)), 0.5, 'the level is the voice level');
  const saw = renderVoice([{ on: true, hz: 100, wave: 'sawtooth', level: 1 }], { sampleRate: 4800, frameRate: 60 });
  assert.ok(saw[0] === -1 && saw[1] > saw[0], 'a sawtooth rises');
  const tri = renderVoice([{ on: true, hz: 100, wave: 'triangle', level: 1 }], { sampleRate: 4800, frameRate: 60 });
  assert.equal(Math.min(...tri), -1);
  assert.equal(Math.max(...tri) > 0.9, true);
});

test('the loader\'s copy of toneHz and voiceState agrees with web-audio.mjs for every note and a spread of registers', () => {
  const page = loadLoader({ frameRate: 60 });
  for (let note = 0; note < 256; note += 1) {
    assert.equal(page.toneHz(note), toneHz(note), `note ${note}`);
  }
  for (const gate of [0, 1, 255]) {
    for (const wave of [0, 1, 2, 3, 255]) {
      for (const volume of [0, 1, 7, 15, 16, 255]) {
        const mem = new Uint8Array([9, gate, 33, wave, volume]);
        assert.deepEqual(plain(page.voiceState(mem, 1)), voiceState(mem, 1), `gate ${gate} wave ${wave} volume ${volume}`);
      }
    }
  }
  assert.deepEqual(plain(page.voiceState(new Uint8Array(8), -1)), voiceState(new Uint8Array(8), -1));
});

// ---- 3. the page ------------------------------------------------------------

// A stand-in AudioContext that records what the page asks of it.
function fakeAudio() {
  const log = [];
  class Param {
    constructor(name) { this.name = name; this.value = 0; }
    setTargetAtTime(value, at, tau) { log.push([`${this.name}.target`, value, tau]); this.value = value; }
  }
  class FakeContext {
    constructor() { log.push(['new']); this.currentTime = 1.5; this.state = 'suspended'; this.destination = { id: 'speaker' }; }
    createOscillator() {
      const osc = { frequency: new Param('frequency'), type: 'sine', connect: (to) => log.push(['osc.connect', to === gain ? 'gain' : 'other']), start: () => log.push(['osc.start']) };
      return osc;
    }
    createGain() { return gain; }
    resume() { log.push(['resume']); this.state = 'running'; return Promise.resolve(); }
  }
  const gain = { gain: new Param('gain'), connect: (to) => log.push(['gain.connect', to.id]) };
  return { log, FakeContext };
}

test('the page makes nothing until the voice first sounds, then one oscillator driven from the registers', () => {
  const page = loadLoader({ frameRate: 60 });
  const base = DEFAULT_LAYOUT.audioBase;
  const mem = new Uint8Array(base + 8);
  const { log, FakeContext } = fakeAudio();
  page.audioStep(mem, FakeContext);
  assert.deepEqual(log, [], 'a program that never sounds anything never makes an audio context');

  mem[base] = 1; mem[base + 1] = 57; mem[base + 2] = 0; mem[base + 3] = 15;
  page.audioStep(mem, FakeContext);
  const names = log.map((entry) => entry[0]);
  assert.deepEqual(names.slice(0, 5), ['new', 'osc.connect', 'gain.connect', 'osc.start', 'frequency.target']);
  assert.ok(log.some((entry) => entry[0] === 'frequency.target' && entry[1] === 440), 'A4 at 440 Hz');
  assert.ok(log.some((entry) => entry[0] === 'gain.target' && entry[1] === 0.5), 'full volume is level 0.5');
  assert.ok(names.includes('resume'), 'a suspended context is asked to resume once the voice is on');

  log.length = 0;
  mem[base + 1] = 69; mem[base + 2] = 2;
  page.audioStep(mem, FakeContext);
  assert.ok(!log.some((entry) => entry[0] === 'new'), 'the same oscillator is re-pitched, not remade');
  assert.ok(log.some((entry) => entry[0] === 'frequency.target' && entry[1] === 880), 'A5 at 880 Hz');

  log.length = 0;
  mem[base] = 0;
  page.audioStep(mem, FakeContext);
  assert.ok(log.some((entry) => entry[0] === 'gain.target' && entry[1] === 0), 'gate off ramps the level to zero');
});

test('a host with no region, or a browser with no AudioContext, does nothing and does not throw', () => {
  const page = loadLoader({ frameRate: 60 });
  const mem = new Uint8Array(DEFAULT_LAYOUT.audioBase + 8);
  mem[DEFAULT_LAYOUT.audioBase] = 1; mem[DEFAULT_LAYOUT.audioBase + 3] = 15;
  assert.doesNotThrow(() => page.audioStep(mem, undefined));
  const real = loadLoader({ frameRate: 60, layout: layoutForRealMachine('c64') });
  const { log, FakeContext } = fakeAudio();
  real.audioStep(mem, FakeContext);
  assert.deepEqual(log, [], "a real machine's own --web build has no tone voice");
});

// ---- 4. a real program ------------------------------------------------------

const PROGRAM = `import { audio } from "@8bitscript/audio";
import { text } from "@8bitscript/text";

export function main(): void {
    text.print(0, "TONE");
    audio.tone(57, 30);
    let n: utinyint = 0;
    while (true) {
        waitFrame();
        audio.update();
        n = n + 1;
        if (n == 60) {
            audio.tone(69, 20);
        }
    }
}
`;

async function runProgramTimeline(machine, frames, source = PROGRAM) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-audio-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), source);
    process.chdir(dir);
    const result = await silently(() => compile('web', join(dir, 'main.8bs'), { checkout: REPO, hardware: machine ? { machine } : {} }));
    assert.equal(result.ok, true, `builds for ${machine ?? 'the Modern host'}`);
    const layout = layoutFromHardware(result.hardware);
    const bytes = await readFile(result.outFile);
    const timeline = [];
    let memory = null;
    let count = 0;
    const program = await instantiateProgram(bytes, {
      waitFrame: () => {
        timeline.push(voiceState(new Uint8Array(memory.buffer), layout.audioBase));
        count += 1;
        if (count >= frames) throw new FrameLimitReached(frames);
      },
    });
    memory = program.memory;
    try { program.entry(); } catch (error) { if (!(error instanceof FrameLimitReached)) throw error; }
    return { timeline, layout };
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
}

for (const machine of [undefined, 'pet-2001']) {
  test(`a program's audio.tone calls sound A4 for 30 frames then A5 for 20, as measured off the rendered register timeline (${machine ?? 'Modern host'})`, async () => {
    const { timeline } = await runProgramTimeline(machine, 100);
    // Frame k's registers are what the page would see after the program has run to its k-th waitFrame.
    const on = timeline.map((state) => state.on);
    const first = on.indexOf(true);
    assert.ok(first >= 0 && first <= 1, `the first tone starts at once (frame ${first})`);
    const lengths = [];
    for (let i = 0, run = 0; i <= on.length; i += 1) {
      if (on[i]) run += 1;
      else if (run) { lengths.push(run); run = 0; }
    }
    assert.deepEqual(lengths.slice(0, 2), [30, 20], `tone lengths in frames: ${lengths}`);
    const tones = timeline.filter((state) => state.on);
    assert.equal(tones[0].hz, 440);
    assert.equal(tones[tones.length - 1].hz, 880);
    // And the samples those registers make.
    const rate = 48000;
    const samples = renderVoice(timeline, { sampleRate: rate, frameRate: 60 });
    const segments = [];
    let start = -1;
    for (let i = 0; i <= samples.length; i += 1) {
      const loud = i < samples.length && samples[i] !== 0;
      if (loud && start < 0) start = i;
      if (!loud && start >= 0 && i - start > 100) { segments.push([start, i]); start = -1; }
    }
    // Merge the zero crossings of a square wave: the run of nonzero samples is the whole tone.
    const measured = segments.map(([from, to]) => {
      let crossings = 0;
      for (let i = from + 1; i < to; i += 1) if (samples[i - 1] < 0 && samples[i] >= 0) crossings += 1;
      return { hz: (crossings * rate) / (to - from), seconds: (to - from) / rate };
    });
    assert.ok(measured.length >= 2, `two tones rendered (${measured.length})`);
    assert.ok(Math.abs(cents(measured[0].hz, 440)) < 30, `first tone ${measured[0].hz} Hz`);
    assert.ok(Math.abs(cents(measured[1].hz, 880)) < 30, `second tone ${measured[1].hz} Hz`);
    assert.ok(Math.abs(measured[0].seconds - 0.5) < 0.02 && Math.abs(measured[1].seconds - 20 / 60) < 0.02, `lengths ${measured.map((m) => m.seconds)}`);
  });
}

// ---- 5. levels and plucked tones ----------------------------------------------

const LEVEL_PROGRAM = `import { audio } from "@8bitscript/audio";
import { text } from "@8bitscript/text";

export function main(): void {
    text.print(0, "LEVEL");
    audio.setLevel(6);
    audio.blip(57, 6);
    let n: utinyint = 0;
    while (true) {
        waitFrame();
        audio.update();
        n = n + 1;
        if (n == 40) {
            audio.setLevel(15);
            audio.tone(57, 5);
        }
        if (n == 80) {
            audio.setLevel(0);
            audio.tone(57, 5);
            audio.blip(69, 3);
        }
    }
}
`;

test("audio.setLevel scales a tone, audio.blip fades to nothing in the frames it is given, and level 0 is silence", async () => {
  const { timeline } = await runProgramTimeline(undefined, 120, LEVEL_PROGRAM);
  const level = (frame) => Number(timeline[frame].level.toFixed(4));
  // The blip: starts at level 6 (6 / 15 of the 0.5 the page plays at), walks down a step a frame, and is over after 6 frames.
  assert.equal(level(0), 0.2, 'the blip starts at the level it was asked for');
  const blip = timeline.slice(0, 12).map((state) => state.level);
  for (let i = 1; i < blip.length; i += 1) assert.ok(blip[i] <= blip[i - 1], `the blip never gets louder (frame ${i})`);
  const over = timeline.slice(0, 12).findIndex((state) => !state.on);
  assert.ok(over >= 1 && over <= 6, `the blip is over within its 6 frames (frame ${over})`);
  assert.ok(timeline.slice(over, 40).every((state) => !state.on), 'and stays over: nothing sounds until the next call');
  // A plain tone after setLevel(15) is at full level, and is not faded.
  assert.equal(level(41), 0.5);
  assert.ok(timeline.slice(41, 45).every((state) => state.on && state.level === 0.5), 'a plain tone holds its level for its frames');
  assert.ok(timeline.slice(46, 80).every((state) => !state.on), 'and ends');
  // Level 0 is silence for tone and for blip.
  assert.ok(timeline.slice(80).every((state) => !state.on), 'at level 0 neither a tone nor a blip makes a sound');
});

test("the web voice's setLevel and volume write the volume register; on() sounds at the level", async () => {
  const src = readFileSync(join(SRC, 'voice.8bs'), 'utf8');
  assert.match(src, /memory\.write\(Video\.AUDIO_BASE \+ 3, level\);\s*memory\.write\(Video\.AUDIO_BASE, 1\);/, 'on() uses the level');
  assert.match(src, /function volume\(amount: utinyint\): void \{\s*memory\.write\(Video\.AUDIO_BASE \+ 3, amount & 15\);/);
});
