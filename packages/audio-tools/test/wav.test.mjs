import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeWav, encodeWav, encodeDpcm, ffmpegAvailable, decodeFlac } from '../src/index.mjs';

test('ffmpegAvailable is false when ffmpeg is not on PATH', () => {
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.equal(ffmpegAvailable(), false);
  } finally {
    process.env.PATH = saved;
  }
});

test('encode then decode round-trips an 8-bit WAV', () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1]);
  const wav = encodeWav(samples, 8000);
  const decoded = decodeWav(wav);
  assert.equal(decoded.sampleRate, 8000);
  assert.equal(decoded.samples.length, 5);
  assert.ok(Math.abs(decoded.samples[1] - 0.5) < 0.02);
});

test('encodeDpcm produces 16-byte-aligned bytes or null', () => {
  const samples = new Float32Array(2000);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 20);
  const dpcm = encodeDpcm(samples, 8000);
  assert.ok(dpcm);
  assert.equal(dpcm.bytes.length % 16, 0);
  assert.ok(dpcm.bytes.length <= 4081 + 15);
  assert.equal(encodeDpcm(new Float32Array(0), 8000), null);
});

test('decodeFlac reports missing ffmpeg as FLAC_NEEDS_FFMPEG, or decodes when present', () => {
  const dir = mkdtempSync(join(tmpdir(), '8ba-flac-'));
  try {
    const path = join(dir, 'none.flac');
    writeFileSync(path, 'not flac');
    if (!ffmpegAvailable()) {
      try {
        decodeFlac(path);
        assert.fail('expected throw');
      } catch (error) {
        assert.equal(error.code, 'FLAC_NEEDS_FFMPEG');
      }
      return;
    }
    // A garbage file with ffmpeg present is a decode error, not a missing-binary one.
    assert.throws(() => decodeFlac(path), /ffmpeg could not decode/);
    const wavPath = join(dir, 'tone.wav');
    const flacPath = join(dir, 'tone.flac');
    writeFileSync(wavPath, encodeWav(Float32Array.from([0, 0.5, -0.5]), 8000));
    const conv = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', wavPath, flacPath], { encoding: 'utf8' });
    if (conv.status === 0) {
      const pcm = decodeFlac(flacPath);
      assert.equal(pcm.sampleRate, 48000);
      assert.ok(pcm.samples.length > 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function wavBytes({ format = 1, channels, bits, data }) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(format, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(8000, 4);
  fmt.writeUInt32LE(8000, 8);
  fmt.writeUInt16LE(1, 12);
  fmt.writeUInt16LE(bits, 14);
  const chunk = (id, body) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('data', Buffer.from(data))]);
  return Buffer.concat([Buffer.from('RIFF'), chunk('', body).subarray(4)]);
}

test('decodeWav throws for a WAV with zero channels instead of looping', () => {
  assert.throws(() => decodeWav(wavBytes({ channels: 0, bits: 8, data: [1, 2, 3] })), /WAV has zero channels/);
  assert.throws(() => decodeWav(wavBytes({ channels: 0, bits: 16, data: [1, 2] })), /WAV has zero channels/);
  assert.throws(() => decodeWav(wavBytes({ format: 3, channels: 0, bits: 32, data: [0, 0, 0, 0] })), /WAV has zero channels/);
  // a format that reads no samples keeps its own message
  assert.throws(() => decodeWav(wavBytes({ channels: 0, bits: 24, data: [1, 2, 3] })), /24-bit/);
});
