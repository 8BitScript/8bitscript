// The WAV analyser the emulator tests measure pitch with (capture.mjs),
// proved on WAVs this file builds itself, so it is checked without an
// emulator and a test that passes cannot be a broken measurement.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeWav, cents, noteHz } from './capture.mjs';

const RATE = 48000;

// A 16-bit PCM WAV of `seconds` of silence with tones laid into it:
// { at, seconds, hz, amp, shape }. `channels` copies the signal to each channel.
function wav(seconds, tones, channels = 1) {
  const frames = Math.round(seconds * RATE);
  const data = Buffer.alloc(frames * 2 * channels);
  for (const { at, seconds: length, hz, amp = 8000, shape = 'square' } of tones) {
    const from = Math.round(at * RATE);
    const to = Math.min(frames, from + Math.round(length * RATE));
    for (let i = from; i < to; i += 1) {
      const phase = ((i - from) * hz) / RATE;
      const value = shape === 'sine' ? Math.sin(2 * Math.PI * phase) : (phase % 1 < 0.5 ? 1 : -1);
      for (let c = 0; c < channels; c += 1) data.writeInt16LE(Math.round(value * amp), (i * channels + c) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2 * channels, 28);
  header.writeUInt16LE(2 * channels, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('silence has no segments and a peak of zero', () => {
  const result = analyzeWav(wav(1, []));
  assert.equal(result.peak, 0);
  assert.deepEqual(result.segments, []);
  assert.equal(result.seconds, 1);
});

test('one tone is one segment at its pitch, to a cent, and its length', () => {
  const result = analyzeWav(wav(2, [{ at: 0.5, seconds: 0.5, hz: noteHz(57) }]));
  assert.equal(result.segments.length, 1);
  const [segment] = result.segments;
  assert.ok(Math.abs(cents(segment.frequency, 440)) < 2, `440 Hz measured ${segment.frequency}`);
  assert.ok(Math.abs(segment.start - 0.5) < 0.02 && Math.abs(segment.seconds - 0.5) < 0.03, `${segment.start} +${segment.seconds}`);
});

test('two tones with a gap are two segments, in order, each at its own pitch', () => {
  const result = analyzeWav(wav(3, [
    { at: 0.2, seconds: 0.5, hz: noteHz(57) },
    { at: 1.5, seconds: 0.35, hz: noteHz(69) },
  ]));
  assert.equal(result.segments.length, 2);
  assert.ok(Math.abs(cents(result.segments[0].frequency, 440)) < 2);
  assert.ok(Math.abs(cents(result.segments[1].frequency, 880)) < 2);
  assert.ok(result.segments[1].start > result.segments[0].end);
});

test('a sine is measured as well as a square, and a second channel changes nothing', () => {
  const result = analyzeWav(wav(1, [{ at: 0.1, seconds: 0.6, hz: 523.25, shape: 'sine' }], 2));
  assert.equal(result.channels, 2);
  assert.equal(result.segments.length, 1);
  assert.ok(Math.abs(cents(result.segments[0].frequency, 523.25)) < 2);
});

test('a quiet tone beside a loud one is not a segment of its own (the threshold is a quarter of the peak)', () => {
  const result = analyzeWav(wav(2, [
    { at: 0.2, seconds: 0.4, hz: 440, amp: 20000 },
    { at: 1.2, seconds: 0.4, hz: 660, amp: 2000 },
  ]));
  assert.equal(result.segments.length, 1);
});

test('a DC offset does not move the measured pitch', () => {
  const buffer = wav(1, [{ at: 0, seconds: 1, hz: 330 }]);
  for (let i = 44; i < buffer.length; i += 2) buffer.writeInt16LE(Math.max(-32768, Math.min(32767, buffer.readInt16LE(i) + 3000)), i);
  const result = analyzeWav(buffer);
  assert.ok(Math.abs(cents(result.segments[0].frequency, 330)) < 2);
});

test('a window of a recording is measured on its own: two notes run together are told apart', () => {
  const result = analyzeWav(wav(1, [
    { at: 0.1, seconds: 0.2, hz: 440 },
    { at: 0.3, seconds: 0.2, hz: 660 },
  ]));
  assert.equal(result.segments.length, 1, 'with no gap they are one segment');
  const first = result.measure(0.12, 0.28);
  const second = result.measure(0.32, 0.48);
  assert.ok(Math.abs(cents(first.frequency, 440)) < 3, `first window ${first.frequency}`);
  assert.ok(Math.abs(cents(second.frequency, 660)) < 3, `second window ${second.frequency}`);
  assert.ok(first.cycles >= 60 && second.cycles >= 90, `cycles ${first.cycles} ${second.cycles}`);
  const quiet = result.measure(0.6, 0.9);
  assert.equal(quiet.frequency, 0);
  assert.equal(quiet.cycles, 0);
});

test('only 16-bit PCM is accepted', () => {
  const buffer = wav(1, [{ at: 0, seconds: 1, hz: 440 }]);
  buffer.writeUInt16LE(8, 34);
  assert.throws(() => analyzeWav(buffer), /8-bit PCM is not handled/);
});

test('cents and noteHz agree with A4 = 440 Hz', () => {
  assert.equal(noteHz(57), 440);
  assert.equal(noteHz(69), 880);
  assert.ok(Math.abs(cents(880, 440) - 1200) < 1e-9);
});
