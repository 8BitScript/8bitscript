// Regenerates fixtures/media-elaborate.json. Run from the repo root:
//   node crates/media/tests/gen/media-elaborate.mjs
// Runs the JS `elaborateMedia` on small .8bg / .8ba modules with real PNG and WAV sources written
// to a scratch directory, for every machine and for no machine. A row is a sequence of modules
// that share one `mediaSlots`; `<dir>` stands for the scratch directory and `<root>` for the repo.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { elaborateMedia, parseMediaModule } from '../../../../packages/compiler/src/media/index.mjs';
import { encodeWav } from '../../../../packages/audio-tools/src/index.mjs';
import { write } from './util.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'elab-'));

// A minimal RGBA PNG encoder: the fixtures carry their own pictures.
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = pixel(x, y);
      raw.set(p, y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const four = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]];
const tiles = (w, h) => png(w, h, (x, y) => four[(x + 2 * y + (x >= 8 ? 1 : 0)) % 4]);
const wave = (n) => Buffer.from(encodeWav(Float32Array.from({ length: n }, (_, i) => Math.sin(i / 3)), 8000));

const assets = {
  'a.png': tiles(8, 8),
  'two.png': tiles(16, 8),
  'small.png': tiles(4, 4),
  'bad.png': Buffer.from('not a png'),
  'a.wav': wave(400),
  'bad.wav': Buffer.from('not a wav'),
  'x.flac': Buffer.from('fLaC'),
};

const gfx = (name, size = '8x8', extra = '') => `sprite ${name} { source "a.png" size ${size} ${extra} }`;
const inst = 'instrument lead { waveform pulse }\ninstrument hiss { waveform noise }';
const longSong = (name, rows) => `song ${name} { tempo 120 speed 6 pattern p length 128 { track t { ${Array.from({ length: rows }, (_, i) => `row ${i} { note C4 instrument lead }`).join(' ')} } } }`;

const machines = [undefined, 'atari8', 'c64', 'cx16', 'nes', 'pet', 'vic20', 'web', 'atari5200', 'nosuch'];
const cases = [];
const add = (name, steps, options = {}, extra = {}) => cases.push({ name, steps, options, ...extra });

for (const machine of machines) {
  const label = machine ?? 'none';
  const o = { machine };
  add(`${label}: sprite`, [{ file: '<dir>/a.8bg', kind: '.8bg', text: gfx('s') }], o);
  add(`${label}: two sprites, animation`, [{ file: '<dir>/a.8bg', kind: '.8bg', text: `${gfx('s')}\nsprite t { source "two.png" size 8x8 animation w { frames 0, 1 every 3 } }` }], o);
  add(`${label}: song and sample`, [{ file: '<dir>/a.8ba', kind: '.8ba', text: `${inst}\nsample b { source "a.wav" fallback { synth noise } }\nsong s { tempo 120 speed 6 pattern p length 8 { track t { row 0 { note C4 instrument lead } row 4 { note E4 instrument hiss } } } }` }], o);
}
add('media slots shared over two files', [
  { file: '<dir>/a.8bg', kind: '.8bg', text: gfx('s') },
  { file: '<dir>/b.8bg', kind: '.8bg', text: `${gfx('t')}\n${gfx('u')}` },
  { file: '<dir>/a.8ba', kind: '.8ba', text: `${inst}\nsong s { tempo 100 speed 4 pattern p length 4 { track t { row 0 { note C4 instrument lead } } } }` },
  { file: '<dir>/b.8ba', kind: '.8ba', text: `${inst}\nsong u { tempo 100 speed 4 pattern p length 4 { track t { row 0 { note D4 instrument lead } } } }` },
], { machine: 'c64', mediaSlots: { graphics: 0, audio: 0, audioBytes: 0 } });
add('media slots shared, pet', [
  { file: '<dir>/a.8bg', kind: '.8bg', text: gfx('s') },
  { file: '<dir>/b.8bg', kind: '.8bg', text: gfx('t') },
], { machine: 'pet', mediaSlots: { graphics: 0, audio: 0, audioBytes: 0 } });
add('media slots shared, nes', [
  { file: '<dir>/a.8bg', kind: '.8bg', text: gfx('s') },
  { file: '<dir>/b.8bg', kind: '.8bg', text: gfx('t') },
], { machine: 'nes', mediaSlots: { graphics: 3, audio: 0, audioBytes: 0 } });
add('media slots, web', [
  { file: '<dir>/a.8bg', kind: '.8bg', text: gfx('s') },
  { file: '<dir>/b.8bg', kind: '.8bg', text: gfx('t', '16x8') },
], { machine: 'web', mediaSlots: { graphics: 0, audio: 0, audioBytes: 0 } });
add('cx16 web build redirects to the web module', [{ file: '<dir>/a.8bg', kind: '.8bg', text: gfx('s') }], { machine: 'cx16', tags: ['web'] });
add('cx16 web build redirects, tags kept', [{ file: '<dir>/a.8bg', kind: '.8bg', text: gfx('s') }], { machine: 'cx16', tags: ['web', 'x'] });
add('tags without web', [{ file: '<dir>/a.8bg', kind: '.8bg', text: gfx('s') }], { machine: 'cx16', tags: ['x'] });
add('bank full', [
  { file: '<dir>/a.8ba', kind: '.8ba', text: `${inst}\n${longSong('s', 40)}` },
  { file: '<dir>/b.8ba', kind: '.8ba', text: `${inst}\n${longSong('t', 40)}` },
], { machine: 'c64', mediaSlots: { graphics: 0, audio: 0, audioBytes: 0 } });
add('bank full, no slots', [{ file: '<dir>/a.8ba', kind: '.8ba', text: `${inst}\n${longSong('s', 70)}` }], { machine: 'c64' });
add('missing source', [{ file: '<dir>/a.8bg', kind: '.8bg', text: 'sprite s { source "gone.png" size 8x8 }' }], {});
add('missing source, nes', [{ file: '<dir>/a.8bg', kind: '.8bg', text: 'sprite s { source "gone.png" size 8x8 }' }], { machine: 'nes' });
add('no source at all', [{ file: '<dir>/a.8bg', kind: '.8bg', text: 'sprite s { size 8x8 }' }], {});
add('absolute source', [{ file: '<dir>/a.8bg', kind: '.8bg', text: 'sprite s { source "<dir>/a.png" size 8x8 }' }], {});
add('source in a subdirectory path', [{ file: '<dir>/sub/../a.8bg', kind: '.8bg', text: gfx('s') }], {});
add('source too small', [{ file: '<dir>/a.8bg', kind: '.8bg', text: 'sprite s { source "small.png" size 8x8 }' }], {});
add('source too small, c64', [{ file: '<dir>/a.8bg', kind: '.8bg', text: 'sprite s { source "small.png" size 8x8 }' }], { machine: 'c64' });
add('not a png', [{ file: '<dir>/a.8bg', kind: '.8bg', text: 'sprite s { source "bad.png" size 8x8 }' }], {});
add('png path is a directory', [{ file: '<dir>/a.8bg', kind: '.8bg', text: 'sprite s { source "sub" size 8x8 }' }], {});
add('missing sample', [{ file: '<dir>/a.8ba', kind: '.8ba', text: 'sample b { source "gone.wav" }' }], { machine: 'nes' });
add('not a wav', [{ file: '<dir>/a.8ba', kind: '.8ba', text: 'sample b { source "bad.wav" }' }], { machine: 'nes' });
add('flac without ffmpeg', [{ file: '<dir>/a.8ba', kind: '.8ba', text: 'sample b { source "x.flac" }' }], { machine: 'nes' }, { noPath: true });
add('flac, no machine', [{ file: '<dir>/a.8ba', kind: '.8ba', text: 'sample b { source "x.flac" }' }], {}, { noPath: true });
add('wav sample, nes dpcm', [{ file: '<dir>/a.8ba', kind: '.8ba', text: 'sample b { source "a.wav" }' }], { machine: 'nes' });
add('empty files', [{ file: '<dir>/a.8bg', kind: '.8bg', text: '' }, { file: '<dir>/a.8ba', kind: '.8ba', text: '' }], { machine: 'c64' });
add('instrument only', [{ file: '<dir>/a.8ba', kind: '.8ba', text: inst }], { machine: 'c64' });
add('instrument named like a song', [{ file: '<dir>/a.8ba', kind: '.8ba', text: `instrument s { waveform pulse }\nsong s { tempo 100 speed 4 }` }], { machine: 'c64' });
add('non-ascii names', [{ file: '<dir>/a.8bg', kind: '.8bg', text: gfx('é') }, { file: '<dir>/a.8ba', kind: '.8ba', text: 'song ü { tempo 100 speed 4 }' }], { machine: 'c64' });
add('facts', [{ file: '<dir>/a.8bg', kind: '.8bg', text: gfx('s') }], { machine: 'c64', facts: { scale: 2 } });
add('checkout from a file outside it', [{ file: '<dir>/a.8bg', kind: '.8bg', text: gfx('s') }], { machine: 'c64', checkout: '<root>' });
add('a stray token still elaborates', [{ file: '<dir>/a.8bg', kind: '.8bg', text: 'sprite s { source "a.png" size 8x8 | }' }], {});

const rows = [];
for (const c of cases) {
  if (process.env.ONLY && c.name !== process.env.ONLY) continue;
  if (process.env.TRACE) console.error(c.name);
  mkdirSync(join(dir, 'sub'), { recursive: true });
  for (const [name, bytes] of Object.entries(assets)) writeFileSync(join(dir, name), bytes);
  const un = (s) => s.replaceAll('<dir>', dir).replaceAll('<root>', root);
  const options = { checkout: root, ...c.options };
  if (options.checkout === '<root>') options.checkout = root;
  const diagnostics = [];
  const slots = options.mediaSlots ? { ...options.mediaSlots } : undefined;
  if (slots) options.mediaSlots = slots;
  const savedPath = process.env.PATH;
  if (c.noPath) process.env.PATH = '';
  const out = [];
  for (const step of c.steps) {
    const mod = parseMediaModule(un(step.file), un(step.text), diagnostics, step.kind);
    try {
      elaborateMedia(mod, diagnostics, options);
      out.push({ ir: mod.ir });
    } catch (e) {
      out.push({ throw: e.message });
    }
  }
  process.env.PATH = savedPath;
  rows.push({
    name: c.name,
    files: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, v.toString('hex')])),
    steps: c.steps,
    options: { ...c.options, ...(c.options.machine === undefined ? {} : {}) },
    noPath: Boolean(c.noPath),
    result: { steps: out, diagnostics, slots: slots ?? null },
  });
}
rmSync(dir, { recursive: true, force: true });
// Strings in the rows carry the scratch directory; swap it for the token.
const text = JSON.stringify(rows).replaceAll(dir, '<dir>').replaceAll(root, '<root>');
const parsed = JSON.parse(text);
for (const r of parsed) {
  // The asset bytes are the same in every row: keep them once, in the first.
  if (r !== parsed[0]) delete r.files;
}
write('media-elaborate', parsed);
