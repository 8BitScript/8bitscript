// Regenerates fixtures/machine-media-<machine>.json. Run from the repo root:
//   node crates/media/tests/gen/machine-media.mjs <machine>
// Runs the machine's JS `lowerGraphics` / `lowerAudio` on every corpus
// sprite (frames decoded by JS) and AIR, plus the inputs in
// `machine-media/<machine>.mjs`, which trigger each diagnostic of the module.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, sliceFrames } from '../../../../packages/graphics-tools/src/index.mjs';
import { decodeWav, encodeDpcm } from '../../../../packages/audio-tools/src/index.mjs';
import { analyzeMedia } from '../../../../packages/compiler/src/media/index.mjs';
import { encodeSong } from '../../../../packages/compiler/src/media/audio/song.mjs';
import { diagnostic } from '../../../../packages/compiler/src/diagnostics/index.mjs';
import { write } from './util.mjs';

const machine = process.argv[2];
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(import.meta.url);
const module_ = require(join(root, 'packages', machine, 'media', 'index.cjs'));
const extra = (await import(`./machine-media/${machine}.mjs`)).default;

const wrap = (code, message, file, start, length, severity = 'error') => diagnostic(code, message, file, start, length, severity);
const hex = (rgba) => Buffer.from(rgba).toString('hex');
const frameJson = (f) => ({ width: f.width, height: f.height, rgba: hex(f.rgba) });

/** All corpus media files, sorted by path. */
function corpus(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === '.git' || name === 'target') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) corpus(path, out);
    else if (name.endsWith('.8bg') || name.endsWith('.8ba')) out.push(path);
  }
  return out;
}

// The same decode as elaborate.mjs `decodeSpriteSource`, minus diagnostics.
function decode(sprite, path) {
  const png = join(dirname(path), sprite.source ?? '');
  if (!sprite.source || !existsSync(png)) return [];
  let decoded;
  try { decoded = decodePng(readFileSync(png)); } catch { return []; }
  if (decoded.width < sprite.width || decoded.height < sprite.height) return [];
  return sliceFrames(decoded.rgba, decoded.width, decoded.height, sprite.width, sprite.height)
    .map((rgba) => ({ rgba, width: sprite.width, height: sprite.height }));
}

const rows = [];
const counts = { lowerGraphics: 0, lowerAudio: 0 };

function graphics(name, text, spriteIndex, frames, facts = {}, slots = null) {
  const file = 'a.8bg';
  const { gir } = analyzeMedia(text, file, { sourceKind: '.8bg' });
  const sprite = gir.sprites[spriteIndex];
  const mediaSlots = slots ? { ...slots } : undefined;
  const result = module_.lowerGraphics(sprite, frames, facts, file, wrap, mediaSlots);
  rows.push({
    fn: 'lowerGraphics',
    name,
    args: { text, file, sprite: spriteIndex, frames: frames.map(frameJson), facts, slots },
    result,
    slotsAfter: mediaSlots ?? null,
  });
  counts.lowerGraphics += 1;
}

// The same decode as elaborate.mjs `decodeSampleSource` for a WAV, minus
// diagnostics; only machines that read `pcm.dpcm` (nes) record it.
function decodePcm(air, path) {
  const pcm = {};
  for (const sample of air.samples) {
    if (!sample.source || !sample.source.toLowerCase().endsWith('.wav')) continue;
    const wav = join(dirname(path), sample.source);
    if (!existsSync(wav)) continue;
    try {
      const decoded = decodeWav(readFileSync(wav));
      pcm[sample.name] = { dpcm: encodeDpcm(decoded.samples, decoded.sampleRate) };
    } catch { /* no entry, as in elaborate */ }
  }
  return pcm;
}

const dpcmJson = (d) => (d ? { bytes: Array.from(d.bytes), rate: d.rate, length: d.length } : null);

function audio(name, text, facts = {}, opts = {}) {
  const file = 'a.8ba';
  const { air } = analyzeMedia(text, file, { sourceKind: '.8ba' });
  const helpers = { encodeSong: (song) => encodeSong(air, song) };
  let pcm = {};
  if (extra.pcm) pcm = opts.pcm ?? (opts.path ? decodePcm(air, opts.path) : {});
  const pcmBySample = new Map(Object.entries(pcm));
  const result = module_.lowerAudio(air, pcmBySample, facts, file, wrap, helpers);
  const pcmOut = Object.fromEntries(Object.entries(pcm).map(([k, v]) => [k, { dpcm: dpcmJson(v.dpcm) }]));
  rows.push({ fn: 'lowerAudio', name, args: { text, file, facts, pcm: pcmOut }, result });
  counts.lowerAudio += 1;
}

// Every corpus file, decoded by JS.
for (const path of corpus(join(root, 'packages'))) {
  const text = readFileSync(path, 'utf8');
  const rel = relative(root, path);
  if (path.endsWith('.8bg')) {
    const { gir } = analyzeMedia(text, 'a.8bg', { sourceKind: '.8bg' });
    gir.sprites.forEach((sprite, i) => (extra.corpusGraphics ?? [{}]).forEach(({ label, facts, slots }) => graphics(label ? `${rel} / ${sprite.name} / ${label}` : `${rel} / ${sprite.name}`, text, i, decode(sprite, path), facts, slots)));
  } else {
    (extra.corpusFacts ?? [{}]).forEach((facts) => audio(`${rel} / ${JSON.stringify(facts)}`, text, facts, { path }));
  }
}

// The module's own diagnostics.
const h = {
  frame: (width, height, pixel) => {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) rgba.set(pixel(x, y), (y * width + x) * 4);
    }
    return { width, height, rgba };
  },
  solid: (width, height, color) => h.frame(width, height, () => color),
  sprite: (size, extra_ = '') => `sprite s { source "s.png" size ${size} ${extra_} }`,
  anim: (size, frames, every = 4) => `sprite s { source "s.png" size ${size} animation a { frames ${frames} every ${every} } }`,
};
extra.cases({ graphics, audio, h });

write(`machine-media-${machine}`, rows);
console.log(JSON.stringify(counts));
