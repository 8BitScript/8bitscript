import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../../graphics-tools/src/index.mjs';
import { encodeWav } from '../../audio-tools/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const width = 64;
const height = 16;
const rgba = new Uint8Array(width * height * 4);
for (let f = 0; f < 4; f += 1) {
  for (let y = 2; y < 14; y += 1) {
    for (let x = 3; x < 13; x += 1) {
      const px = f * 16 + ((x + (f % 2)) % 16);
      const o = (y * width + px) * 4;
      rgba[o] = 0;
      rgba[o + 1] = 0;
      rgba[o + 2] = 0;
      rgba[o + 3] = 255;
    }
  }
}
writeFileSync(join(HERE, 'src', 'player.png'), encodePng(width, height, rgba));

const samples = new Float32Array(800);
for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 5) * Math.exp(-i / 250);
writeFileSync(join(HERE, 'src', 'blip.wav'), encodeWav(samples, 8000));

console.log('wrote player.png and blip.wav');
