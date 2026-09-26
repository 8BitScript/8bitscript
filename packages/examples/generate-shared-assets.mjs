// Writes minimal mark.8bg/mark.png and chime.8ba/chime.wav into the
// examples that can actually drive them: the ones with a frame loop.
//
// Both kinds of media need a frame. audio.play() arms a voice and it is
// audio.update(), counted down over the following frames, that releases it
// again. graphics.place() records where an object is and leaves the drawing
// to the next update too, on every machine but the VIC-20. So a program
// that draws once and returns gets no picture out of an object and a stuck
// voice out of a sample — hello-world measured 1587 bytes on the PET to
// show nothing but its greeting, against 108 without the media.
//
// hello-world and hello-bx are that shape deliberately (they are the same
// program written two ways, and the 8BX gate compares their bytes), so they
// carry neither. The four that loop carry both.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../graphics-tools/src/index.mjs';
import { encodeWav } from '../audio-tools/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const EXAMPLES = ['hello-world', 'hello-bx', 'joystick', 'fancy', 'swarm', 'media-walk'];

/** The two that draw once and return: no frame, so no media. */
export const NO_FRAME_LOOP = ['hello-world', 'hello-bx'];
export const MEDIA_EXAMPLES = EXAMPLES.filter((name) => !NO_FRAME_LOOP.includes(name));

/** Those that reach the object through the shared component rather than their own code. */
export const MARK_COMPONENT_EXAMPLES = MEDIA_EXAMPLES.filter((name) => name !== 'swarm' && name !== 'media-walk');

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

export function writeSharedAssets() {
  for (const name of MEDIA_EXAMPLES) {
    const src = join(HERE, name, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'mark.png'), markPng);
    writeFileSync(join(src, 'mark.8bg'), mark8bg);
    writeFileSync(join(src, 'chime.wav'), chimeWav);
    writeFileSync(join(src, 'chime.8ba'), chime8ba);
    if (MARK_COMPONENT_EXAMPLES.includes(name)) {
      writeFileSync(join(src, 'Mark.8bx'), mark8bx);
    }
  }
  return MEDIA_EXAMPLES.length;
}

// Importing this module must not write anything — the test beside it reads
// the lists above to check which examples carry media, and a top-level
// write would have it rewriting the tree just by asking.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = writeSharedAssets();
  console.log(`wrote shared mark/chime into ${count} examples; ${NO_FRAME_LOOP.join(' and ')} carry none`);
}
