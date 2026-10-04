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

const KIND_CX16 = 5;
const KIND_GLYPH = 0;
const PALETTE_COLORS = 15;
const WINDOW_BYTES = 4096;
const SIZES = [8, 16, 32, 64];

function legalSize(n) {
  for (const s of SIZES) if (n <= s) return s;
  return 64;
}

function rgb12(rgba, o) {
  return [rgba[o] >> 4, rgba[o + 1] >> 4, rgba[o + 2] >> 4];
}

// The palette is the sprite's own picture colors, most-used first, quantized
// to VERA's 12 bits — not the machine's default palette, which a sprite that
// merely numbered its colors 1..3 would have inherited.
function buildPalette(frames) {
  const counts = new Map();
  for (const frame of frames) {
    for (let o = 0; o < frame.width * frame.height * 4; o += 4) {
      if (frame.rgba[o + 3] < 16) continue;
      const [r, g, b] = rgb12(frame.rgba, o);
      const key = (r << 8) | (g << 4) | b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return { colors: ordered.slice(0, PALETTE_COLORS).map(([key]) => key), distinct: ordered.length };
}

function nearest(colors, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  colors.forEach((key, i) => {
    const dr = ((key >> 8) & 15) - r;
    const dg = ((key >> 4) & 15) - g;
    const db = (key & 15) - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best + 1;
}

function packFrame(frame, colors, width, height) {
  const index = new Map(colors.map((key, i) => [key, i + 1]));
  const out = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 2) {
      const pair = [0, 0];
      for (let k = 0; k < 2; k += 1) {
        const px = x + k;
        if (px >= frame.width || y >= frame.height) continue;
        const o = (y * frame.width + px) * 4;
        if (frame.rgba[o + 3] < 16) continue;
        const [r, g, b] = rgb12(frame.rgba, o);
        pair[k] = index.get((r << 8) | (g << 4) | b) ?? nearest(colors, r, g, b);
      }
      out.push((pair[0] << 4) | pair[1]);
    }
  }
  return out;
}

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
