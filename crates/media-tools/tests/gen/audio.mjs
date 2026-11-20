// Regenerates fixtures/audio.json and fixtures/flac.json
// from packages/audio-tools (the JS oracle).
// Run from the repo root: node crates/media-tools/tests/gen/audio.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decodeWav, decodeFlac, encodeDpcm, encodeWav, ffmpegAvailable,
} from '../../../../packages/audio-tools/src/index.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const hex = (b) => Buffer.from(b).toString('hex');
const rows = [];

function wavBytes({ format = 1, channels = 1, rate = 8000, bits = 8, data, fmtSize = 16, pad = [], fmtBody }) {
  const fmt = fmtBody ?? (() => {
    const f = Buffer.alloc(fmtSize);
    f.writeUInt16LE(format, 0);
    f.writeUInt16LE(channels, 2);
    f.writeUInt32LE(rate, 4);
    f.writeUInt32LE(rate * channels * (bits / 8), 8);
    f.writeUInt16LE(channels * (bits / 8), 12);
    if (fmtSize >= 16) f.writeUInt16LE(bits, 14);
    return f;
  })();
  const ck = (id, d, declared = d.length) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'latin1');
    h.writeUInt32LE(declared, 4);
    return Buffer.concat([h, d, d.length & 1 && declared === d.length ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([Buffer.from('WAVE'), ck('fmt ', fmt), ...pad, data === null ? Buffer.alloc(0) : ck('data', Buffer.from(data))]);
  const h = Buffer.alloc(8);
  h.write('RIFF', 0);
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}
function decodeRow(name, bytes) {
  const row = { fn: 'decodeWav', name, args: [hex(bytes)] };
  try {
    const r = decodeWav(bytes);
    row.result = { sampleRate: r.sampleRate, samples: [...r.samples] };
  } catch (e) {
    row.error = e.message;
  }
  rows.push(row);
}
const i16 = (...v) => { const b = Buffer.alloc(v.length * 2); v.forEach((x, i) => b.writeInt16LE(x, i * 2)); return b; };
const f32 = (...v) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };

decodeRow('8bit-mono', wavBytes({ bits: 8, data: [0, 64, 128, 192, 255] }));
decodeRow('8bit-stereo', wavBytes({ bits: 8, channels: 2, data: [0, 255, 128, 128, 10, 20, 7] }));
decodeRow('16bit-mono', wavBytes({ bits: 16, rate: 22050, data: i16(0, 1, -1, 32767, -32768, 12345) }));
decodeRow('16bit-stereo', wavBytes({ bits: 16, channels: 2, rate: 44100, data: i16(100, 200, -300, 300, 32767, 32767, 5) }));
decodeRow('16bit-3ch', wavBytes({ bits: 16, channels: 3, data: i16(1, 2, 3, 4, 5, 6, 7) }));
decodeRow('float32-mono', wavBytes({ format: 3, bits: 32, data: f32(0, 0.5, -0.25, 1, 0.1) }));
decodeRow('float32-stereo', wavBytes({ format: 3, bits: 32, channels: 2, data: f32(0.1, 0.2, 0.3, 0.7, 1, 1) }));
decodeRow('float32-labelled-pcm-is-error', wavBytes({ format: 1, bits: 32, data: f32(0, 1) }));
decodeRow('8bit-format-3', wavBytes({ format: 3, bits: 8, data: [1, 2, 3] }));
decodeRow('empty-data', wavBytes({ bits: 8, data: [] }));
decodeRow('odd-chunk-padding-before-data', wavBytes({ bits: 8, data: [10, 20, 30], pad: [Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from([1, 2, 3, 0])])] }));
decodeRow('data-size-beyond-file', (() => {
  const b = wavBytes({ bits: 8, data: [1, 2, 3, 4] });
  b.writeUInt32LE(1000, b.length - 4 - 4);
  return b;
})());
decodeRow('fmt-18-bytes', wavBytes({ bits: 16, fmtSize: 18, data: i16(1, 2) }));
decodeRow('fmt-short-4-bytes', wavBytes({ fmtBody: Buffer.from([1, 0, 1, 0]), data: [1, 2] }));
decodeRow('fmt-8-bytes', wavBytes({ fmtBody: Buffer.from([1, 0, 1, 0, 64, 31, 0, 0]), data: [1, 2] }));
decodeRow('fmt-empty', wavBytes({ fmtBody: Buffer.alloc(0), data: [1, 2] }));
decodeRow('data-before-fmt', (() => {
  const b = wavBytes({ bits: 8, data: [9, 9] });
  const fmtAt = 12;
  const fmt = b.subarray(fmtAt, fmtAt + 24);
  const data = b.subarray(fmtAt + 24);
  return Buffer.concat([b.subarray(0, 12), data, fmt]);
})());

decodeRow('err-empty', Buffer.alloc(0));
decodeRow('err-short', Buffer.from('RIFF....WAV'));
decodeRow('err-not-riff', Buffer.concat([Buffer.from('RIFX'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(20)]));
decodeRow('err-not-wave', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI '), Buffer.alloc(20)]));
decodeRow('err-no-chunks', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]));
decodeRow('err-no-data', wavBytes({ data: null }));
decodeRow('err-24-bit', wavBytes({ bits: 24, data: [1, 2, 3, 4, 5, 6] }));
decodeRow('err-32-bit-int', wavBytes({ bits: 32, data: [1, 2, 3, 4] }));
decodeRow('err-4-bit', wavBytes({ bits: 4, data: [1, 2] }));
decodeRow('err-fmt-14-bytes-bits-0', wavBytes({ fmtBody: Buffer.alloc(14), data: [1, 2] }));

// encodeWav output is a WAV too
decodeRow('encodeWav-roundtrip', encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1, 0.123]), 11025));

// encodeDpcm
function sine(n, hz, rate) {
  return Float32Array.from({ length: n }, (_, i) => Math.fround(Math.sin((2 * Math.PI * hz * i) / rate)));
}
const dpcm = [
  [sine(800, 440, 8000), 8000],
  [sine(8000, 220, 8000), 8000],
  [Float32Array.from({ length: 1000 }, (_, i) => Math.fround(((i * 7) % 9) / 10)), 1],
  [sine(1, 1, 8000), 8000],
  [sine(7, 1, 33143.9), 33143.9],
  [new Float32Array(0), 8000],
  [new Float32Array(8000).fill(0.5), 8000],
  [Float32Array.from([0.9, 0.9, 0.9, -0.9, -0.9, -0.9, 0.9, -0.9, 0.5, 0.25, 0, -1, 1, 1]), 16000],
  [Float32Array.from({ length: 256 }, (_, i) => Math.fround(((i * 37) % 200) / 100 - 1)), 44100],
  [Float32Array.from({ length: 32648 }, (_, i) => Math.fround(((i * 37) % 9) / 10)), 33143.9],
  [Float32Array.from({ length: 32649 }, (_, i) => Math.fround(((i * 37) % 9) / 10)), 33143.9],
  [Float32Array.from({ length: 65296 }, (_, i) => Math.fround(((i * 5) % 7) / 10 - 0.3)), 66287.8],
  [Float32Array.from([NaN, 0.5, NaN]), 8000],
];
for (const [s, rate] of dpcm) {
  const r = encodeDpcm(s, rate);
  rows.push({
    fn: 'encodeDpcm',
    args: [[...s].map((x) => (Number.isNaN(x) ? 'NaN' : x)), rate],
    result: r === null ? null : { bytes: [...r.bytes], rate: r.rate, length: r.length },
  });
}

// decodeFlac: the one real-ffmpeg row. Written only when ffmpeg is on PATH.
const flacPath = here('../fixtures/.sample.flac');
const flac = { ffmpeg: false };
if (ffmpegAvailable()) {
  const wav = encodeWav(Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 7) * 0.8), 8000);
  const wavPath = here('../fixtures/.sample.wav');
  writeFileSync(wavPath, wav);
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', wavPath, flacPath]);
  if (r.status !== 0) throw new Error(`ffmpeg could not make the FLAC: ${r.stderr}`);
  const d = decodeFlac(flacPath);
  flac.ffmpeg = true;
  flac.sampleRate = d.sampleRate;
  flac.samples = [...d.samples];
  flac.flacHex = hex(readFileSync(flacPath));
  unlinkSync(wavPath);
  unlinkSync(flacPath);
}
writeFileSync(here('../fixtures/flac.json'), `${JSON.stringify(flac)}\n`);
writeFileSync(here('../fixtures/audio.json'), `${JSON.stringify(rows)}\n`);
console.log(`audio.json: ${rows.length} rows, ${rows.filter((r) => r.error).length} errors; flac ffmpeg=${flac.ffmpeg}`);
