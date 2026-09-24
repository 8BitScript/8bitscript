import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeWav, encodeWav, encodeDpcm, ffmpegAvailable, decodeFlac } from '../src/index.mjs';

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
