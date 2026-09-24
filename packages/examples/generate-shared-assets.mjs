// Writes minimal mark.8bg/mark.png and chime.8ba/chime.wav into every
// example's src/ — the four-pillar baseline every program shares.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../graphics-tools/src/index.mjs';
import { encodeWav } from '../audio-tools/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const EXAMPLES = ['hello-world', 'hello-bx', 'joystick', 'fancy', 'swarm', 'media-walk'];

const width = 8;
const height = 8;
const rgba = new Uint8Array(width * height * 4);
for (let y = 1; y < 7; y += 1) {
  for (let x = 1; x < 7; x += 1) {
    const o = (y * width + x) * 4;
    rgba[o] = 0xff;
    rgba[o + 1] = 0xcc;
    rgba[o + 2] = 0;
    rgba[o + 3] = 0xff;
  }
}
const markPng = encodePng(width, height, rgba);

const samples = new Float32Array(400);
for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 8) * Math.exp(-i / 120);
const chimeWav = encodeWav(samples, 8000);

const mark8bg = `sprite mark {
  source "./mark.png"
  size 8x8
  transparent auto
}
`;

const chime8ba = `sample chime {
  source "./chime.wav"
  fallback { synth noise }
}
`;

const mark8bx = `import { mark } from "./mark.8bg";
import { graphics } from "@8bitscript/graphics";
import { sprites } from "@8bitscript/sprites";

export component Mark() {
    graphics.place(mark, sprites.ORIGIN_X + 120, sprites.ORIGIN_Y);
}
`;

for (const name of EXAMPLES) {
  const src = join(HERE, name, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'mark.png'), markPng);
  writeFileSync(join(src, 'mark.8bg'), mark8bg);
  writeFileSync(join(src, 'chime.wav'), chimeWav);
  writeFileSync(join(src, 'chime.8ba'), chime8ba);
  if (name !== 'hello-bx' && name !== 'swarm' && name !== 'media-walk') {
    writeFileSync(join(src, 'Mark.8bx'), mark8bx);
  }
}

console.log(`wrote shared mark/chime into ${EXAMPLES.length} examples`);
