// Regenerates fixtures/machine-media-<machine>.json: the machine's
// `lowerGraphics` and `lowerAudio` (packages/<machine>/media/index.cjs) run
// on every corpus sprite and AIR as the JS decodes them, plus inputs that
// trigger each diagnostic in the module. Run from the repo root:
//   node crates/media/tests/gen/machine-media.mjs <machine>
// Each row is { fn, name, args, result }. Frame bytes are hex.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tokenizeMedia } from '../../../../packages/compiler/src/media/lexer.mjs';
import { parseGraphics } from '../../../../packages/compiler/src/media/graphics/parse.mjs';
import { parseAudio } from '../../../../packages/compiler/src/media/audio/parse.mjs';
import { encodeSong } from '../../../../packages/compiler/src/media/audio/song.mjs';
import { decodePng, sliceFrames } from '../../../../packages/graphics-tools/src/index.mjs';
import { diagnostic } from '../../../../packages/compiler/src/diagnostics/index.mjs';
import { write } from './util.mjs';

const machine = process.argv[2];
if (!machine) throw new Error('usage: machine-media.mjs <machine>');
const require = createRequire(import.meta.url);
const mod = require(`../../../../packages/${machine}/media/index.cjs`);

const hex = (b) => Buffer.from(b).toString('hex');
const wrapDiagnostic = (code, message, file, start, length, severity = 'error') =>
  diagnostic(code, message, file, start, length, severity);

const rows = [];

// Facts for the graphics side (the shipped modules ignore them) and the
// `audio.voices` variants `Number(facts?.['audio.voices'] ?? 0)` must read.
const FACT_SETS = [
  ['no facts', {}],
  ['voices 3', { 'audio.voices': 3 }],
  ['voices 0', { 'audio.voices': 0 }],
  ['voices string', { 'audio.voices': '4' }],
  ['voices bad string', { 'audio.voices': 'x' }],
  ['voices null', { 'audio.voices': null }],
  ['voices true', { 'audio.voices': true }],
  ['voices empty array', { 'audio.voices': [] }],
  ['voices array of one', { 'audio.voices': [2] }],
  ['voices array of two', { 'audio.voices': [2, 3] }],
  ['voices object', { 'audio.voices': {} }],
];

function parseSprites(text, file) {
  const { tokens } = tokenizeMedia(text, file, { sourceKind: '.8bg' });
  return parseGraphics(tokens, text, file).gir.sprites;
}

function addGraphics(name, text, file, spriteIndex, frames, facts = {}) {
  if (!mod.lowerGraphics) return;
  const sprite = parseSprites(text, file)[spriteIndex];
  const slots = { graphics: 0, audio: 0, audioBytes: 0 };
  const result = mod.lowerGraphics(sprite, frames, facts, file, wrapDiagnostic, slots);
  rows.push({
    fn: 'lowerGraphics',
    name,
    args: {
      text, file, sprite: spriteIndex, facts,
      frames: frames.map((f) => ({ width: f.width, height: f.height, rgba: hex(f.rgba) })),
    },
    result: { ...result, slots },
  });
}

function addAudio(name, text, file, facts) {
  if (!mod.lowerAudio) return;
  const { tokens } = tokenizeMedia(text, file, { sourceKind: '.8ba' });
  const { air } = parseAudio(tokens, text, file);
  const helpers = { encodeSong: (song) => encodeSong(air, song) };
  const slots = { graphics: 0, audio: 0, audioBytes: 0 };
  const result = mod.lowerAudio(air, new Map(), facts, file, wrapDiagnostic, helpers);
  rows.push({ fn: 'lowerAudio', name, args: { text, file, facts }, result: { ...result, slots } });
}

// Deterministic frames: a small LCG, never Math.random.
let seed = 12345;
const rnd = (n) => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) % n;
};
const frame = (w, h, pixel) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) rgba.set(pixel(x, y), (y * w + x) * 4);
  }
  return { width: w, height: h, rgba };
};
const CLEAR = [0, 0, 0, 0];
const ink = (x, y) => ((x + y) % 3 === 0 ? [20, 30, 40, 255] : CLEAR);
const checker = (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
const noise = (colors) => () => {
  const k = rnd(colors);
  return [(k * 37) % 256, (k * 91) % 256, (k * 151) % 256, 255];
};
const half = (x, y) => (x < 4 ? [255, 0, 0, 255] : y < 4 ? [0, 0, 255, 128] : CLEAR);
const faint = (x, y) => (x === 1 && y === 1 ? [0, 0, 0, 255] : [255, 255, 255, 255 * (x % 2)]);
const sprite = (w, h, extra = '') => `sprite s { source "s.png" size ${w}x${h} ${extra} }`;
const many = (n, f) => Array.from({ length: n }, () => f);

// The corpus: every `.8bg` under packages, its sprites decoded as the compiler does.
const gfx = readdirSync('packages', { recursive: true })
  .filter((f) => f.endsWith('.8bg') && !f.includes('node_modules'))
  .map((f) => `packages/${f}`)
  .sort();
for (const f of gfx) {
  const text = readFileSync(f, 'utf8');
  parseSprites(text, f).forEach((sp, i) => {
    const path = join(dirname(f), sp.source);
    let frames = [];
    if (existsSync(path)) {
      const decoded = decodePng(readFileSync(path));
      if (decoded.width >= sp.width && decoded.height >= sp.height) {
        frames = sliceFrames(decoded.rgba, decoded.width, decoded.height, sp.width, sp.height)
          .map((rgba) => ({ rgba, width: sp.width, height: sp.height }));
      }
    }
    addGraphics(`corpus ${f} / sprite ${i}`, text, f, i, frames);
  });
}

// Synthetic sprites that reach each branch and diagnostic.
const G = 'a.8bg';
const g = (name, text, frames, facts) => addGraphics(name, text, G, 0, frames, facts);
g('no frames', sprite(8, 8), []);
g('no frames with animation', sprite(8, 8, 'animation a { frames 0, 1 every 3 }'), []);
g('one 8x8 frame', sprite(8, 8), [frame(8, 8, checker)]);
g('one 16x16 frame', sprite(16, 16), [frame(16, 16, ink)]);
g('24x21 frame', sprite(24, 21), [frame(24, 21, checker)]);
g('one 12x10 frame', sprite(12, 10), [frame(12, 10, ink)]);
g('transparent frame', sprite(16, 16), [frame(16, 16, () => CLEAR)]);
g('opaque white frame', sprite(8, 8), [frame(8, 8, () => [255, 255, 255, 255])]);
g('two colours', sprite(16, 16), [frame(16, 16, half)]);
g('faint sprite', sprite(8, 8), [frame(8, 8, faint)]);
g('3 ink pixels', sprite(8, 8), [frame(8, 8, (x, y) => (y === 0 && x < 3 ? [0, 0, 0, 255] : CLEAR))]);
g('4 ink pixels', sprite(8, 8), [frame(8, 8, (x, y) => (y === 0 && x < 4 ? [0, 0, 0, 255] : CLEAR))]);
g('light ink only', sprite(8, 8), [frame(8, 8, () => [200, 200, 200, 255])]);
g('colour noise', sprite(16, 16), [frame(16, 16, noise(40))]);
g('colour noise 15', sprite(16, 16), [frame(16, 16, noise(15))]);
g('colour noise 16', sprite(16, 16), [frame(16, 16, noise(16))]);
g('colour noise 3', sprite(16, 16), [frame(16, 16, noise(3))]);
g('animation 2 frames', sprite(16, 16, 'animation w { frames 0, 1 every 5 }'), [frame(16, 16, ink), frame(16, 16, checker)]);
g('animation 4 frames', sprite(16, 16, 'animation w { frames 0, 1, 2, 3 }'), many(4, frame(16, 16, checker)));
g('animation 5 frames', sprite(16, 16, 'animation w { frames 0, 1, 2, 3, 4 every 2 }'), many(5, frame(16, 16, ink)));
g('animation 8 frames', sprite(16, 16, 'animation w { frames 0, 1, 2, 3, 4, 5, 6, 7 }'), many(8, frame(16, 16, ink)));
g('animation 9 frames', sprite(16, 16, 'animation w { frames 0, 1, 2, 3, 4, 5, 6, 7, 8 }'), many(9, frame(16, 16, checker)));
g('animation index past the frames', sprite(8, 8, 'animation w { frames 0, 5, 1 }'), [frame(8, 8, checker), frame(8, 8, ink)]);
g('animation repeated frame', sprite(8, 8, 'animation w { frames 1, 1, 1 }'), [frame(8, 8, checker), frame(8, 8, ink)]);
g('animation with no frames list', sprite(8, 8, 'animation w { every 9 }'), [frame(8, 8, checker)]);
g('two animations', sprite(8, 8, 'animation a { frames 1 every 2 } animation b { frames 0 every 7 }'), [frame(8, 8, checker), frame(8, 8, ink)]);
g('mixed-colour frames', sprite(16, 16, 'animation w { frames 0, 1 }'), [frame(16, 16, half), frame(16, 16, noise(6))]);
g('32x32 frame', sprite(32, 32), [frame(32, 32, noise(5))]);
g('64x64 frame', sprite(64, 64), [frame(64, 64, noise(9))]);
g('64x64 with 3 frames', sprite(64, 64, 'animation w { frames 0, 1, 2 }'), many(3, frame(64, 64, ink)));
g('16x64 frame', sprite(16, 64), [frame(16, 64, ink)]);
g('65x8 frame', sprite(65, 8), [frame(65, 8, ink)]);
g('8x65 frame', sprite(8, 65), [frame(8, 65, checker)]);
g('100x100 frame', sprite(100, 100), [frame(100, 100, ink)]);
g('32x32 with 9 frames', sprite(32, 32, 'animation w { frames 0, 1, 2, 3, 4, 5, 6, 7, 8 }'), many(9, frame(32, 32, ink)));
g('16x16 with 20 frames', sprite(16, 16, 'animation w { frames 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 }'), many(20, frame(16, 16, ink)));
g('with facts', sprite(8, 8), [frame(8, 8, checker)], { 'audio.voices': 3 });

// Audio.
const inst = 'instrument lead { waveform pulse }\ninstrument saw { waveform saw }\n';
const songOf = (name, inst2) => `song ${name} { tempo 100 pattern a length 4 { track t { row 0 { note C4 instrument ${inst2} } row 2 { note E4; length 2 } } } }`;
const audioTexts = [
  ['empty', ''],
  ['instruments only', inst],
  ['one sample', 'sample boom { source "boom.wav" fallback { synth noise } }'],
  ['samples of every synth', 'sample a { source "a.wav" fallback { synth pulse } }\nsample b { source "b.wav" fallback { synth noise } }\nsample c { source "c.wav" fallback { synth triangle } }\nsample d { source "d.wav" fallback { synth saw } }'],
  ['sample without fallback', 'sample boom { source "boom.wav" }'],
  ['sample empty fallback', 'sample boom { source "boom.wav" fallback { } }'],
  ['one song', `${inst}${songOf('s', 'lead')}`],
  ['song with saw', `${inst}${songOf('s', 'saw')}`],
  ['two songs, one saw', `${inst}${songOf('s', 'lead')}\n${songOf('t', 'saw')}`],
  ['song without notes', 'song s { }'],
  ['samples and songs', `${inst}sample boom { source "boom.wav" fallback { synth saw } }\n${songOf('s', 'lead')}`],
];
const A = 'a.8ba';
for (const [name, text] of audioTexts) {
  for (const [fname, facts] of FACT_SETS) addAudio(`${name} / ${fname}`, text, A, facts);
}
// The corpus: every `.8ba` under packages, with the voices fact on and off.
const aud = readdirSync('packages', { recursive: true })
  .filter((f) => f.endsWith('.8ba') && !f.includes('node_modules'))
  .map((f) => `packages/${f}`)
  .sort();
for (const f of aud) {
  const text = readFileSync(f, 'utf8');
  for (const [fname, facts] of FACT_SETS.slice(0, 3)) addAudio(`corpus ${f} / ${fname}`, text, f, facts);
}

write(`machine-media-${machine}`, rows);
