// WAV in-process, FLAC through FFmpeg, canonical 32-bit float PCM.
// The compiler never shells out itself: this package is what does.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function readU16(buf, o) { return buf[o] | (buf[o + 1] << 8); }
function readU32(buf, o) { return (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0; }

function findChunk(bytes, id) {
  let i = 12;
  while (i + 8 <= bytes.length) {
    const name = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = readU32(bytes, i + 4);
    if (name === id) return { offset: i + 8, size, data: bytes.subarray(i + 8, i + 8 + size) };
    i += 8 + size + (size & 1);
  }
  return null;
}

function samplesFromPcm(data, bits, channels, format) {
  const out = [];
  if (format === 3 && bits === 32) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i + 4 * channels <= data.length; i += 4 * channels) {
      let s = 0;
      for (let c = 0; c < channels; c += 1) s += view.getFloat32(i + c * 4, true);
      out.push(s / channels);
    }
    return Float32Array.from(out);
  }
  if (bits === 8) {
    for (let i = 0; i + channels <= data.length; i += channels) {
      let s = 0;
      for (let c = 0; c < channels; c += 1) s += (data[i + c] - 128) / 128;
      out.push(s / channels);
    }
    return Float32Array.from(out);
  }
  if (bits === 16) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i + 2 * channels <= data.length; i += 2 * channels) {
      let s = 0;
      for (let c = 0; c < channels; c += 1) s += view.getInt16(i + c * 2, true) / 32768;
      out.push(s / channels);
    }
    return Float32Array.from(out);
  }
  throw new Error(`WAV PCM ${bits}-bit format ${format} is not supported`);
}

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ sampleRate: number, samples: Float32Array }}
 */
export function decodeWav(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (buf.length < 12 || String.fromCharCode(...buf.subarray(0, 4)) !== 'RIFF'
    || String.fromCharCode(...buf.subarray(8, 12)) !== 'WAVE') {
    throw new Error('not a WAV');
  }
  const fmt = findChunk(buf, 'fmt ');
  const data = findChunk(buf, 'data');
  if (!fmt || !data) throw new Error('WAV is missing fmt or data');
  const format = readU16(fmt.data, 0);
  const channels = readU16(fmt.data, 2);
  const sampleRate = readU32(fmt.data, 4);
  const bits = readU16(fmt.data, 14);
  const samples = samplesFromPcm(data.data, bits, channels, format);
  return { sampleRate, samples };
}

export function ffmpegAvailable() {
  const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return result.status === 0;
}

/**
 * Decode FLAC (or anything FFmpeg reads) to mono float32. Sync, because
 * link() is sync. Missing FFmpeg throws a named error the compiler turns
 * into 8BS2213.
 *
 * @param {string} path
 * @returns {{ sampleRate: number, samples: Float32Array }}
 */
export function decodeFlac(path) {
  if (!existsSync(path)) throw new Error(`cannot read '${path}'`);
  if (!ffmpegAvailable()) {
    const error = new Error('FLAC needs ffmpeg on PATH');
    error.code = 'FLAC_NEEDS_FFMPEG';
    throw error;
  }
  const result = spawnSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-i', path,
    '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg could not decode '${path}': ${String(result.stderr ?? '').slice(-200)}`);
  }
  const buf = result.stdout;
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return { sampleRate: 48000, samples: Float32Array.from(samples) };
}

/**
 * Encode a tiny WAV (8-bit mono PCM) so tests and the example can ship a
 * real sample without a binary blob in git history of guesses.
 */
export function encodeWav(samples, sampleRate = 8000) {
  const data = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data[i] = Math.round((s * 0.5 + 0.5) * 255);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * NES DPCM: 1-bit delta at ~33144 Hz (DMC rate $F), 16-byte aligned,
 * max 4081 bytes. Returns null when the clip cannot be represented as a
 * short sample this slice is willing to ship.
 */
export function encodeDpcm(samples, sampleRate) {
  const targetRate = 33143.9;
  const ratio = sampleRate / targetRate;
  const needed = Math.ceil(samples.length / ratio);
  const bytes = Math.ceil(needed / 8);
  if (bytes < 1 || bytes > 4081) return null;
  const aligned = Math.ceil(bytes / 16) * 16;
  const out = new Uint8Array(aligned);
  let acc = 64;
  let bit = 0;
  let offset = 0;
  let packed = 0;
  for (let i = 0; i < needed; i += 1) {
    const src = Math.min(samples.length - 1, Math.floor(i * ratio));
    const want = Math.round((samples[src] * 0.5 + 0.5) * 127);
    if (want > acc && acc < 126) {
      packed |= 1 << bit;
      acc += 2;
    } else if (acc > 1) {
      acc -= 2;
    }
    bit += 1;
    if (bit === 8) {
      out[offset] = packed;
      offset += 1;
      packed = 0;
      bit = 0;
    }
  }
  if (bit) {
    out[offset] = packed;
    offset += 1;
  }
  return { bytes: out, rate: 0x0f, length: Math.max(1, Math.ceil(offset / 16)) };
}
