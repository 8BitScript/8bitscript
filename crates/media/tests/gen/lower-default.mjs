// Regenerates fixtures/lower-default.json. Run from the repo root:
//   node crates/media/tests/gen/lower-default.mjs
// Runs every export of `media/lower-default.mjs` on small inputs. The `constructor` case of
// `waveIndex` is left out on purpose: the port declares that deviation in its module comment.
import * as ld from '../../../../packages/compiler/src/media/lower-default.mjs';
import { analyzeMedia } from '../../../../packages/compiler/src/media/index.mjs';
import { write } from './util.mjs';

const rows = [];
const hex = (rgba) => Buffer.from(rgba).toString('hex');
const frameJson = (f) => ({ width: f.width, height: f.height, rgba: hex(f.rgba) });
const frame = (width, height, pixel) => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) rgba.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, rgba };
};
const solid = (w, h, c) => frame(w, h, () => c);
const clear = [0, 0, 0, 0];
const red = [255, 0, 0, 255];
const dim = [30, 30, 30, 255];
const light = [220, 220, 220, 255];

rows.push({ fn: 'constants', name: 'constants', result: { KIND_GLYPH: ld.KIND_GLYPH, KIND_C64: ld.KIND_C64, KIND_NES: ld.KIND_NES, KIND_PET: ld.KIND_PET, WAVE_PULSE: ld.WAVE_PULSE, WAVE_NOISE: ld.WAVE_NOISE, WAVE_TRIANGLE: ld.WAVE_TRIANGLE, WAVE_SAW: ld.WAVE_SAW, DEFAULT_MAX_STEPS: ld.DEFAULT_MAX_STEPS } });

for (const name of ['pulse', 'noise', 'triangle', 'saw', 'other', '', 'Pulse']) {
  rows.push({ fn: 'waveIndex', name: `waveIndex ${name}`, args: { name }, result: ld.waveIndex(name) });
}

const frames = {
  'solid ink': solid(8, 8, red),
  'all clear': solid(8, 8, clear),
  'sparse bright': frame(8, 8, (x, y) => (x === 0 && y < 2 ? light : clear)),
  'sparse dim': frame(8, 8, (x, y) => (x === 0 && y < 2 ? dim : clear)),
  'half ink': frame(8, 8, (x) => (x < 4 ? red : clear)),
  'just over': frame(10, 10, (x, y) => (x + y * 10 < 46 ? red : clear)),
  'empty frame': { width: 0, height: 0, rgba: new Uint8Array(0) },
};
for (const [name, f] of Object.entries(frames)) rows.push({ fn: 'glyphOf', name: `glyphOf ${name}`, args: { frame: frameJson(f) }, result: ld.glyphOf(f) });

const sprite = (name, extra = '') => `sprite ${name} { source "s.png" size 8x8 ${extra} }`;
const anim = (frames, every = 4) => `sprite s { source "s.png" size 8x8 animation a { frames ${frames} every ${every} } }`;
const gfxCase = (name, text, index, fs) => {
  const file = 'a.8bg';
  const sp = analyzeMedia(text, file, { sourceKind: '.8bg' }).gir.sprites[index];
  rows.push({ fn: 'lowerGraphicsDefault', name, args: { text, file, sprite: index, frames: fs.map(frameJson) }, result: ld.lowerGraphicsDefault(sp, fs, file) });
};
const set = [solid(8, 8, red), frames['sparse bright'], frames['sparse dim']];
gfxCase('plain sprite', sprite('s'), 0, [solid(8, 8, red)]);
gfxCase('no frames', sprite('s'), 0, []);
gfxCase('second sprite', `${sprite('a')}\n${sprite('b')}`, 1, set);
gfxCase('animation of three', anim('0, 1, 2', 3), 0, set);
gfxCase('animation, two steps', anim('0, 1', 5), 0, set);
gfxCase('animation, five steps', anim('0, 1, 2, 0, 1', 2), 0, set);
gfxCase('animation, many steps', anim('0, 1, 2, 0, 1, 2, 0', 2), 0, set);
gfxCase('animation, index past the frames', anim('0, 7', 2), 0, set);
gfxCase('animation without frames', 'sprite s { source "s.png" size 8x8 animation a { every 6 } }', 0, set);
gfxCase('animation, no frames decoded', anim('0, 1', 2), 0, []);
gfxCase('non-ascii name', sprite('é'), 0, set);

const inst = 'instrument lead { waveform pulse }\ninstrument hiss { waveform noise }\ninstrument tri { waveform triangle }\ninstrument saw { waveform saw }';
const pat = (name, i, len = 8) => `pattern ${name} length ${len} { track t { row 0 { note C4 instrument ${i} } row 4 { note E4 } } }`;
const song = (name, body, head = 'tempo 120 speed 6') => `song ${name} { ${head} ${body} }`;
const audioCases = [
  ['no assets', ''],
  ['samples only', 'sample a { source "a.wav" }\nsample b { source "b.wav" }'],
  ['song, one pattern, no order', `${inst}\n${song('s', pat('a', 'lead'))}`],
  ['song, order', `${inst}\n${song('s', `order { a } ${pat('a', 'lead')}`)}`],
  ['song, order repeats and skips', `${inst}\n${song('s', `order { b a z a } ${pat('a', 'lead')} ${pat('b', 'hiss', 4)}`)}`],
  ['song, no order, two patterns', `${inst}\n${song('s', `${pat('a', 'hiss')} ${pat('b', 'lead', 4)}`)}`],
  ['song, pattern names repeat', `${inst}\n${song('s', `${pat('a', 'hiss')} ${pat('a', 'lead', 4)}`)}`],
  ['song, no patterns', 'song s { tempo 90 speed 3 }'],
  ['song, empty order', `${inst}\n${song('s', `order { } ${pat('a', 'lead')}`)}`],
  ['song, waveforms', `${inst}\n${song('s', 'pattern a length 16 { track t { row 0 { note C4 instrument tri } row 2 { note D4 } row 4 { note E4 instrument saw } row 6 { note F4 instrument lead } row 8 { note G4 instrument hiss } } }')}`],
  ['song, rows without a note', `${inst}\n${song('s', 'pattern a length 4 { track t { row 0 { instrument saw } row 1 { note C4 } row 2 { } } }')}`],
  ['song, unknown instrument keeps the last', `${inst}\n${song('s', 'pattern a length 4 { track t { row 0 { note C4 instrument hiss } row 1 { note D4 instrument ghost } } }')}`],
  ['song, no instrument', song('s', 'pattern a length 4 { track t { row 0 { note C4 } } }')],
  ['song, two tracks', `${inst}\n${song('s', 'pattern a length 4 { track x { row 0 { note C4 instrument tri } } track y { row 1 { note D4 } } }')}`],
  ['song, large rows, tempo and speed', `${inst}\n${song('s', 'pattern a length 300 { track t { row 256 { note C4 } row 299 { note B8 } } }', 'tempo 300 speed 999')}`],
  ['two songs and a sample', `${inst}\nsample b { source "b.wav" }\n${song('s', pat('a', 'saw'))}\n${song('t', pat('b', 'lead'))}`],
  ['non-ascii names', 'sample é { source "a.wav" }\nsong ü { }'],
];
const eventsOf = (air, i) => ld.songEvents(air, air.songs[i]);
for (const [name, text] of audioCases) {
  const file = 'a.8ba';
  const { air } = analyzeMedia(text, file, { sourceKind: '.8ba' });
  air.songs.forEach((_, i) => {
    const events = eventsOf(air, i);
    rows.push({ fn: 'songEvents', name: `songEvents ${name} / ${i}`, args: { text, file, song: i }, result: events });
    rows.push({ fn: 'encodeSong', name: `encodeSong ${name} / ${i}`, args: { text, file, song: i }, result: ld.encodeSong(air.songs[i], events.events, events.length) });
  });
  for (const machine of [undefined, 'pce', 'atari5200']) {
    rows.push({ fn: 'lowerAudioDefault', name: `lowerAudioDefault ${name} / ${machine ?? 'none'}`, args: { text, file, machine: machine ?? null }, result: ld.lowerAudioDefault(air, new Map(), file, machine === undefined ? {} : { machine }) });
  }
}
rows.push({ fn: 'lowerAudioDefault', name: 'lowerAudioDefault no options', args: { text: 'song s { }', file: 'a.8ba', machine: null }, result: ld.lowerAudioDefault(analyzeMedia('song s { }', 'a.8ba', { sourceKind: '.8ba' }).air, new Map(), 'a.8ba') });
write('lower-default', rows);
