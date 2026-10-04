// Web media lowering. A PNG becomes, per animation step, one 8×8 glyph:
// eight row bytes (bit 0 the leftmost pixel, the order every font on this
// target uses) that packages/graphics/src/index.web.8bs writes into the
// redefinable glyph table (packages/cli/src/web-layout.mjs GLYPH_*, the
// character codes 176-255) and draws as a cell. The picture is sampled at
// build time, so the program carries eight bytes per step and the machine
// does no image work.
//
// Before this module drew real art it sampled each picture to one of the
// sixteen 2×2 quadrant-block codes (128-143) — a 16×16 source became four
// lit-or-dark quadrants. The glyph table is the redefinable character set
// the web roadmap lists (packages/web/AGENTS.md, "What a superset runtime
// would add", item 3), so a picture can now be what it is: 64 pixels of one
// ink. A source of 8×8 pixels is carried exactly; a larger one is reduced by
// area (each glyph pixel is lit when at least half of the source pixels it
// covers are opaque, and the inkiest one is lit if none reaches that, so a
// thin picture does not vanish). Colour is still dropped — a cell has one
// ink; `graphics.color()` tints it — and the lowering says so with 8BS2111.
//
// The default lowering (packages/compiler/src/media/lower-default.mjs)
// picks PETSCII-ish codes — 0xA0 "reverse space", 0x51 "ball" — which the
// web does not draw: its font holds ASCII 32-122, the blocks at 128-143 and
// nothing else (font8x8.mjs `glyphRows`), so before there was a module of
// its own a mostly-filled picture was an empty cell and a mostly-clear one
// the letter Q. The web is the one release target with its own font, so it
// names its own data.
//
// Audio: the web host plays songs and samples through its one oscillator (audio.tone's voice),
// square, triangle or sawtooth; noise has no oscillator here, so it plays as the square.
'use strict';

const KIND_GLYPH = 0;
// graphics/src/index.web.8bs holds this many animation steps per picture.
const MAX_STEPS = 8;
// The glyph is eight rows of eight pixels.
const GLYPH_SIZE = 8;
// A glyph pixel is lit when at least this share of the source pixels it
// covers is opaque.
const LIT_SHARE = 0.5;
const OPAQUE_ALPHA = 16;

/** The opaque share (0..1) of the source box behind glyph pixel (gx, gy). */
function boxShare(frame, gx, gy) {
  const { rgba, width, height } = frame;
  const x0 = Math.floor((gx * width) / GLYPH_SIZE);
  const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / GLYPH_SIZE));
  const y0 = Math.floor((gy * height) / GLYPH_SIZE);
  const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / GLYPH_SIZE));
  let ink = 0;
  let area = 0;
  for (let y = y0; y < y1 && y < height; y += 1) {
    for (let x = x0; x < x1 && x < width; x += 1) {
      area += 1;
      if (rgba[(y * width + x) * 4 + 3] >= OPAQUE_ALPHA) ink += 1;
    }
  }
  return area === 0 ? 0 : ink / area;
}

/**
 * The eight row bytes for one frame. A frame with ink always shows some: if
 * no glyph pixel reaches the share, the inkiest are lit. A frame with none is
 * the empty glyph (eight zero bytes: an undefined glyph, which draws blank).
 */
function glyphOf(frame) {
  const shares = [];
  let best = 0;
  for (let gy = 0; gy < GLYPH_SIZE; gy += 1) {
    for (let gx = 0; gx < GLYPH_SIZE; gx += 1) {
      const share = boxShare(frame, gx, gy);
      shares.push(share);
      if (share > best) best = share;
    }
  }
  const rows = new Array(GLYPH_SIZE).fill(0);
  if (best === 0) return rows;
  const threshold = best >= LIT_SHARE ? LIT_SHARE : best;
  shares.forEach((share, i) => {
    if (share >= threshold) rows[Math.floor(i / GLYPH_SIZE)] |= 1 << (i % GLYPH_SIZE);
  });
  return rows;
}

/** How many distinct opaque colours a frame has (alpha-blind: the RGB triple). */
function opaqueColours(frame) {
  const seen = new Set();
  const { rgba, width, height } = frame;
  for (let i = 0; i < width * height; i += 1) {
    if (rgba[i * 4 + 3] >= OPAQUE_ALPHA) {
      seen.add((rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]);
    }
  }
  return seen.size;
}

function lowerGraphics(sprite, frames, _facts, file, diagnostic) {
  const diagnostics = [];
  const anim = sprite.animations?.[0];
  if (!frames || frames.length === 0) {
    return {
      kind: KIND_GLYPH, data: new Array(GLYPH_SIZE).fill(255), frames: 1, every: anim?.every ?? 8, width: GLYPH_SIZE, height: GLYPH_SIZE, chrPatches: [], diagnostics,
    };
  }
  const sequence = anim?.frames?.length ? anim.frames : [0];
  const kept = sequence.slice(0, MAX_STEPS);
  const used = kept.map((index) => frames[index] ?? frames[0]);
  const data = used.flatMap((frame) => glyphOf(frame));
  const notes = [];
  if (used.some((frame) => opaqueColours(frame) > 1)) notes.push('colours dropped');
  if (used.some((frame) => frame.width !== GLYPH_SIZE || frame.height !== GLYPH_SIZE)) {
    notes.push(`${used[0].width}×${used[0].height} reduced to ${GLYPH_SIZE}×${GLYPH_SIZE}`);
  }
  if (kept.length > 1) notes.push(`${kept.length} animation steps kept`);
  if (sequence.length > MAX_STEPS) notes.push(`steps past ${MAX_STEPS} dropped`);
  if (notes.length > 0) {
    diagnostics.push(diagnostic(
      '8BS2111',
      `sprite '${sprite.name}' is an 8×8 one-ink glyph on the web; ${notes.join('; ')}`,
      file, sprite.start, sprite.length, 'warning',
    ));
  }
  return {
    kind: KIND_GLYPH,
    data,
    frames: kept.length,
    every: anim?.every ?? 8,
    width: GLYPH_SIZE,
    height: GLYPH_SIZE,
    chrPatches: [],
    diagnostics,
  };
}

const WAVE = { pulse: 0, noise: 1, triangle: 2, saw: 3 };

function lowerAudio(air, _pcm, _facts, file, diagnostic, helpers) {
  const diagnostics = [];
  const samples = [];
  const songs = [];
  for (const sample of air.samples ?? []) {
    const fallback = sample.fallback?.synth ?? 'pulse';
    diagnostics.push(diagnostic(
      '8BS2210',
      `sample '${sample.name}' is not PCM on the web; using fallback { synth ${fallback} }`,
      file, sample.start, sample.length, 'warning',
    ));
    samples.push({ name: sample.name, data: [WAVE[fallback] ?? 0, 60], events: [] });
  }
  for (const song of air.songs ?? []) {
    const { data, events } = helpers.encodeSong(song);
    if (events.some((e) => e.waveform === 'noise')) {
      diagnostics.push(diagnostic(
        '8BS2212',
        `waveform 'noise' cannot route on 'web': the oscillator plays it as a square`,
        file, song.start, song.length, 'warning',
      ));
    }
    songs.push({ name: song.name, data, events });
  }
  return { samples, songs, diagnostics };
}

module.exports = { lowerGraphics, lowerAudio, glyphOf, GLYPH_SIZE, MAX_STEPS };
