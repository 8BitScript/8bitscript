// CX16 media lowering. PNG → a VERA 4bpp hardware sprite with its own
// palette; song → the VERA PSG at $1F9C0.
//
// What the graphics driver (@8bitscript/graphics' index.cx16.8bs) is handed,
// byte by byte through graphics.bind:
//
//   bytes 0..31   the sprite's palette: sixteen 12-bit colors, two bytes each
//                 in VERA's own order (GGGGBBBB, then 0000RRRR); entry 0 is
//                 the transparent one and is always zero
//   bytes 32..    every animation frame, one after another, each a linear
//                 4bpp bitmap — width/2 bytes a row, the LEFT pixel in the
//                 HIGH nibble — which is what VERA's sprite renderer reads,
//                 not the 8x8 tiles the layers use
//
// The size is the next legal VERA sprite size (8, 16, 32 or 64 a side) at or
// above the .8bg's, padded with transparent pixels. A sprite owns a 4096-byte
// window of video memory in the driver, so a frame count that does not fit it
// is cut and says so.
'use strict';

const { legalSize, buildPalette, packFrame } = require('@8bitscript/graphics-tools/sprite-pack');

const KIND_CX16 = 5;
const KIND_GLYPH = 0;
const PALETTE_COLORS = 15;
const WINDOW_BYTES = 4096;

function lowerGraphics(sprite, frames, _facts, file, diagnostic) {
  const diagnostics = [];
  const anim = sprite.animations?.[0];
  if (!frames[0]) {
    return {
      kind: KIND_GLYPH, data: [0x2A], frames: 1, every: 8, width: 8, height: 8, chrPatches: [], diagnostics,
    };
  }
  const width = legalSize(frames[0].width);
  const height = legalSize(frames[0].height);
  if (frames[0].width > 64 || frames[0].height > 64) {
    diagnostics.push(diagnostic(
      '8BS2111',
      `sprite '${sprite.name}' is ${frames[0].width}x${frames[0].height}; a VERA sprite is at most 64x64 — the rest was cut`,
      file, sprite.start, sprite.length, 'warning',
    ));
  }
  let order = anim?.frames?.length ? [...anim.frames] : [0];
  const frameBytes = (width * height) / 2;
  const fit = Math.max(1, Math.floor(WINDOW_BYTES / frameBytes));
  if (order.length > fit) {
    diagnostics.push(diagnostic(
      '8BS2111',
      `sprite '${sprite.name}': ${order.length} frames of ${width}x${height} do not fit its ${WINDOW_BYTES}-byte window of video memory; the first ${fit} are kept`,
      file, sprite.start, sprite.length, 'warning',
    ));
    order = order.slice(0, fit);
  }
  const used = order.map((i) => frames[i] ?? frames[0]);
  const { colors, distinct } = buildPalette(used);
  if (distinct > PALETTE_COLORS) {
    diagnostics.push(diagnostic(
      '8BS2110',
      `sprite '${sprite.name}' has ${distinct} colours; a VERA 4bpp sprite holds ${PALETTE_COLORS} plus transparent — the rarest were mapped to the nearest kept`,
      file, sprite.start, sprite.length, 'warning',
    ));
  }
  diagnostics.push(diagnostic(
    '8BS2111',
    `sprite '${sprite.name}' is a ${width}x${height} VERA hardware sprite on the Commander X16`,
    file, sprite.start, sprite.length, 'warning',
  ));
  const data = new Array(32).fill(0);
  colors.forEach((key, i) => {
    data[(i + 1) * 2] = (((key >> 4) & 15) << 4) | (key & 15);
    data[(i + 1) * 2 + 1] = (key >> 8) & 15;
  });
  for (const frame of used) data.push(...packFrame(frame, colors, width, height));
  return {
    kind: KIND_CX16,
    data,
    frames: used.length,
    every: anim?.every ?? 8,
    width,
    height,
    chrPatches: [],
    diagnostics,
  };
}

const WAVE = { pulse: 0, noise: 1, triangle: 2, saw: 3 };



function lowerAudio(air, _pcm, facts, file, diagnostic, helpers) {
  const diagnostics = [];
  const samples = [];
  const songs = [];
  const voices = Number(facts?.['audio.voices'] ?? 0);
  if (!voices) {
    for (const sample of air.samples ?? []) {
      diagnostics.push(diagnostic(
        '8BS2211',
        `target 'cx16' has no audio driver yet; playback omitted`,
        file, sample.start, sample.length, 'warning',
      ));
      samples.push({ name: sample.name, data: [], events: [] });
    }
    for (const song of air.songs ?? []) {
      diagnostics.push(diagnostic(
        '8BS2211',
        `target 'cx16' has no audio driver yet; playback omitted`,
        file, song.start, song.length, 'warning',
      ));
      songs.push({ name: song.name, data: [], events: [] });
    }
    return { samples, songs, diagnostics };
  }
  for (const sample of air.samples ?? []) {
    const fallback = sample.fallback?.synth ?? 'noise';
    diagnostics.push(diagnostic(
      '8BS2210',
      `sample '${sample.name}' is not PCM in this slice; using fallback { synth ${fallback} }`,
      file, sample.start, sample.length, 'warning',
    ));
    samples.push({ name: sample.name, data: [WAVE[fallback] ?? 1, 60], events: [] });
  }
  for (const song of air.songs ?? []) {
    const { data, events } = helpers.encodeSong(song);
    songs.push({ name: song.name, data, events });
  }
  return { samples, songs, diagnostics };
}

module.exports = { lowerGraphics, lowerAudio };
