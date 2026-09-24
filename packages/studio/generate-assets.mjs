import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../graphics-tools/src/index.mjs';
import { encodeWav } from '../audio-tools/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Pixel-8 mark: cream on transparent, 8×8 (matches the extension icon idea).
const size = 8;
const rgba = new Uint8Array(size * size * 4);
const on = [
  '01111110',
  '10000001',
  '10000001',
  '10000001',
  '10000001',
  '10000001',
  '10000001',
  '01111110',
];
for (let y = 0; y < size; y += 1) {
  const row = on[y];
  for (let x = 0; x < size; x += 1) {
    const o = (y * size + x) * 4;
    if (row[x] === '1') {
      rgba[o] = 255;
      rgba[o + 1] = 248;
      rgba[o + 2] = 220;
      rgba[o + 3] = 255;
    }
  }
}
writeFileSync(join(HERE, 'src', 'mark.png'), encodePng(size, size, rgba));

const samples = new Float32Array(400);
for (let i = 0; i < samples.length; i += 1) {
  samples[i] = Math.sin(i / 8) * Math.exp(-i / 120);
}
writeFileSync(join(HERE, 'src', 'chime.wav'), encodeWav(samples, 8000));

console.log('wrote mark.png and chime.wav');
