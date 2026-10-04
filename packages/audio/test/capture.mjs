// Headless audio capture for the @8bitscript/audio tests.
//
// Nothing here opens a window or makes a sound worth hearing (VICE runs in
// `-console` mode, x16emu on SDL's dummy video and audio drivers):
//   * VICE (xpet, xvic, x64sc) records a WAV only through a real output
//     device — `-sounddev dummy` and `-sounddev dump` record nothing — so the
//     capture plays through the host device at 2% volume, and a volume of 0
//     is recorded as silence. The SID and the VIC-I are also logged register
//     by register by the `dump` device, which needs no audio device at all
//     and is exact; the PET's CB2 wave is not a register write and has no
//     dump, so it is the only chip that needs the WAV.
//   * x16emu records `-wav` itself; SDL_AUDIODRIVER=dummy keeps it off the
//     speakers and SDL_VIDEODRIVER=dummy keeps its window from opening.
// A test skips when the emulator is not installed.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function haveBinary(name) {
  return spawnSync('which', [name], { stdio: 'ignore' }).status === 0;
}

// ---- WAV ---------------------------------------------------------------------

// Split a 16-bit PCM WAV into tone segments and measure each one. A segment
// is a run of 10 ms blocks whose peak is at least a quarter of the file's;
// runs closer than `gap` seconds are one tone. The frequency is the count of
// rising zero crossings of the mean-removed first channel over the segment.
export function analyzeWav(buffer, options) {
  const { rate, channels, samples } = decodeWav(buffer);
  return { ...analyzeSamples(samples, rate, options), channels };
}

// The first channel of a 16-bit PCM WAV, in the file's own units.
export function decodeWav(buffer) {
  const channels = buffer.readUInt16LE(22);
  const rate = buffer.readUInt32LE(24);
  const bits = buffer.readUInt16LE(34);
  if (bits !== 16) throw new Error(`analyzeWav: ${bits}-bit PCM is not handled`);
  const frames = Math.floor((buffer.length - 44) / (2 * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) samples[i] = buffer.readInt16LE(44 + i * 2 * channels);
  return { rate, channels, samples };
}

// The pitch inside [from, to) seconds: rising zero crossings of the
// mean-removed samples, counted between the first and the last. `cycles` says
// how many it saw, which is how far to trust the number (a 30 ms note has
// fewer than ten cycles at 300 Hz).
export function measureWindow(samples, rate, from, to) {
  const start = Math.max(0, Math.round(from * rate));
  const end = Math.min(samples.length, Math.round(to * rate));
  let mean = 0;
  let peak = 0;
  for (let i = start; i < end; i += 1) mean += samples[i];
  mean /= Math.max(1, end - start);
  for (let i = start; i < end; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
  let crossings = 0;
  let first = -1;
  let last = -1;
  let previous = (samples[start] ?? 0) - mean;
  for (let i = start + 1; i < end; i += 1) {
    const value = samples[i] - mean;
    if (previous < 0 && value >= 0) {
      crossings += 1;
      if (first < 0) first = i;
      last = i;
    }
    previous = value;
  }
  const cycles = Math.max(0, crossings - 1);
  return { frequency: cycles > 0 ? (cycles * rate) / (last - first) : 0, cycles, peak };
}

// Tone segments in mono samples at `rate`.
export function analyzeSamples(samples, rate, { gap = 0.03 } = {}) {
  const frames = samples.length;
  const sample = (i) => samples[i];
  let peak = 0;
  for (let i = 0; i < frames; i += 1) peak = Math.max(peak, Math.abs(sample(i)));
  const result = {
    rate, seconds: frames / rate, peak, segments: [], samples,
    measure: (from, to) => measureWindow(samples, rate, from, to),
  };
  if (peak === 0) return result;
  const threshold = peak / 4;
  const block = Math.max(1, Math.round(rate / 100));
  const active = [];
  for (let start = 0; start < frames; start += block) {
    let blockPeak = 0;
    const end = Math.min(frames, start + block);
    for (let i = start; i < end; i += 1) blockPeak = Math.max(blockPeak, Math.abs(sample(i)));
    active.push(blockPeak >= threshold);
  }
  const runs = [];
  active.forEach((on, b) => {
    if (!on) return;
    const last = runs[runs.length - 1];
    if (last && (b - last.end) * block / rate <= gap) last.end = b + 1;
    else runs.push({ start: b, end: b + 1 });
  });
  for (const run of runs) {
    const from = run.start * block;
    const to = Math.min(frames, run.end * block);
    let mean = 0;
    for (let i = from; i < to; i += 1) mean += sample(i);
    mean /= Math.max(1, to - from);
    let crossings = 0;
    let previous = sample(from) - mean;
    let firstCrossing = -1;
    let lastCrossing = -1;
    for (let i = from + 1; i < to; i += 1) {
      const value = sample(i) - mean;
      if (previous < 0 && value >= 0) {
        crossings += 1;
        if (firstCrossing < 0) firstCrossing = i;
        lastCrossing = i;
      }
      previous = value;
    }
    // Count cycles between the first and last crossing, not the padded window.
    const frequency = crossings > 1 ? ((crossings - 1) * rate) / (lastCrossing - firstCrossing) : 0;
    result.segments.push({ start: from / rate, end: to / rate, seconds: (to - from) / rate, crossings, frequency });
  }
  return result;
}

export const cents = (measured, expected) => 1200 * Math.log2(measured / expected);
export const noteHz = (note) => 440 * 2 ** ((note - 57) / 12);

// ---- VICE --------------------------------------------------------------------

const VICE_CLOCK = { c64: 1022727, vic20: 1022727 };

function viceRun(emulator, prg, { cycles, modelArgs = [], soundArgs }) {
  const result = spawnSync(
    emulator,
    ['-default', '-console', '-silent', ...soundArgs, '+autostart-delay-random', '-autostartprgmode', '1', ...modelArgs,
      '-limitcycles', String(cycles), '+confirmonexit', '-autostart', prg],
    // A real-time recording (the PET's, through the sound device) lasts as long as the emulated time
    // does, about a second for every 1,000,000 cycles; the dump runs at warp speed and needs far less.
    { stdio: 'ignore', timeout: Math.max(120000, Math.round(cycles / 1000 * 1.4) + 30000) },
  );
  if (result.error) throw result.error;
}

// The chip's register writes, as { clock, reg, value } with the clock counted
// from the start of the run. SID and VIC-I only.
export function viceDump(emulator, prg, { cycles = 9_000_000, modelArgs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-vice-dump-'));
  const file = join(dir, 'sound.dump');
  try {
    viceRun(emulator, prg, { cycles, modelArgs, soundArgs: ['-warp', '-soundwarpmode', '1', '-sound', '-sounddev', 'dump', '-soundarg', file] });
    const events = [];
    let clock = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const [delta, reg, value] = line.trim().split(/\s+/).map(Number);
      if (Number.isNaN(value)) continue;
      clock += delta;
      events.push({ clock, reg, value });
    }
    return events;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A real-time WAV (the run lasts `cycles` of emulated time) analysed.
export function viceWav(emulator, prg, { cycles = 6_000_000, modelArgs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-vice-wav-'));
  const file = join(dir, 'sound.wav');
  try {
    viceRun(emulator, prg, {
      cycles, modelArgs,
      soundArgs: ['-sound', '-sounddev', 'coreaudio', '-soundvolume', '2', '-soundrecdev', 'wav', '-soundrecarg', file],
    });
    return analyzeWav(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- SID / VIC-I register readings ------------------------------------------

// Tones the SID's voice 0 played: from each gate-on to the next gate-off,
// with the frequency its Fn register pair named, at the NTSC or PAL clock.
export function sidTones(events, clock = VICE_CLOCK.c64) {
  const tones = [];
  let low = 0;
  let high = 0;
  let open = null;
  for (const { clock: at, reg, value } of events) {
    if (reg === 0) low = value;
    if (reg === 1) high = value;
    if (reg === 4) {
      const gate = (value & 1) !== 0;
      if (gate && !open) open = { at, fn: low + high * 256 };
      if (!gate && open) {
        tones.push({ at: open.at, cycles: at - open.at, fn: open.fn, hz: (open.fn * clock) / 16777216 });
        open = null;
      }
    }
  }
  return tones;
}

// The VIC-I's voice registers 10..13 ($900A..$900D): a tone is a run with the
// enable bit (128) set, until the register is written below 128.
export function vicTones(events, reg = 12, clock = VICE_CLOCK.vic20, divisor = 64) {
  const tones = [];
  let open = null;
  for (const { clock: at, reg: r, value } of events) {
    if (r !== reg) continue;
    if (value >= 128) {
      if (open) tones.push({ ...open, cycles: at - open.at });
      const a = 255 - value;
      open = { at, a, hz: a === 0 ? Infinity : clock / (divisor * a) };
    } else if (open) {
      tones.push({ ...open, cycles: at - open.at });
      open = null;
    }
  }
  return tones;
}

// ---- x16emu ------------------------------------------------------------------

// Runs the program for `ms` of wall time, records its audio, and analyses the
// WAV. x16emu runs in real time, so the program should start sounding within
// the first second or so.
export async function x16Wav(prg, { ms = 7000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-x16-wav-'));
  const file = join(dir, 'sound.wav');
  try {
    const child = spawn('x16emu', ['-prg', prg, '-run', '-wav', file], {
      stdio: 'ignore',
      env: { ...process.env, SDL_AUDIODRIVER: 'dummy', SDL_VIDEODRIVER: 'dummy' },
    });
    await new Promise((resolve) => setTimeout(resolve, ms));
    child.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!existsSync(file)) throw new Error('x16emu wrote no WAV');
    return analyzeWav(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
