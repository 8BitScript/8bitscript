// C64 media lowering. PNG → 24×21 VIC-II sprite bytes (16×16 is padded).
// The sample does not become a $D418 digi: fallback { synth } is what plays.
'use strict';

const KIND_C64 = 1;

// graphics.meta's `kind` byte is this machine's to define: the low nibble is
// KIND_C64, the high nibble the sprite's VIC-II colour (0-15), so the driver
// (packages/graphics/src/index.c64.8bs) colours the sprite without a new
// parameter that every other machine's twin would then have to take.
//
// A graphics sprite owns FRAME_BLOCKS shape blocks in the driver's layout
// (slot * FRAME_BLOCKS), and bind() takes its byte index as a utinyint, so
// 4 frames x 63 bytes = 252 is the most one sprite can hold.
const FRAME_BLOCKS = 4;

// The 16 VIC-II colours, as the Pepto palette (the one VICE defaults to).
const PALETTE = [
  [0x00, 0x00, 0x00], [0xff, 0xff, 0xff], [0x81, 0x33, 0x38], [0x75, 0xce, 0xc8],
  [0x8e, 0x3c, 0x97], [0x56, 0xac, 0x4d], [0x2e, 0x2c, 0x9b], [0xed, 0xf1, 0x71],
  [0x8e, 0x50, 0x29], [0x55, 0x38, 0x00], [0xc4, 0x6c, 0x71], [0x4a, 0x4a, 0x4a],
  [0x7b, 0x7b, 0x7b], [0xa9, 0xff, 0x9f], [0x70, 0x6d, 0xeb], [0xb2, 0xb2, 0xb2],
];

function nearestColor(r, g, b) {
  let best = 1;
  let bestDistance = Infinity;
  PALETTE.forEach(([pr, pg, pb], index) => {
    const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

// The VIC-II sprite is one colour: the palette entry nearest the colour most
// of the opaque pixels (over every kept frame) have.
function dominantColor(frameList) {
  const votes = new Array(PALETTE.length).fill(0);
  for (const frame of frameList) {
    for (let i = 0; i < frame.width * frame.height; i += 1) {
      const o = i * 4;
      if (frame.rgba[o + 3] < 16) continue;
      votes[nearestColor(frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2])] += 1;
    }
  }
  let best = 1;
  votes.forEach((count, index) => {
    if (count > votes[best]) best = index;
  });
  return best;
}

function packSprite(indices, width, height) {
  const bytes = new Uint8Array(63);
  for (let y = 0; y < 21; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      if (x >= width || y >= height) continue;
      if (indices[y * width + x] === 255) continue;
      bytes[y * 3 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return [...bytes];
}

function quantize1bit(rgba, width, height) {
  const indices = new Uint8Array(width * height);
  let colors = 0;
  const seen = new Set();
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    if (rgba[o + 3] < 16) {
      indices[i] = 255;
      continue;
    }
    const key = `${rgba[o] >> 4},${rgba[o + 1] >> 4},${rgba[o + 2] >> 4}`;
    seen.add(key);
    indices[i] = 1;
  }
  colors = seen.size;
  return { indices, colors };
}

function lowerGraphics(sprite, frames, _facts, file, diagnostic) {
  const diagnostics = [];
  const anim = sprite.animations?.[0];
  const wanted = anim?.frames?.length ? anim.frames : [0];
  const frameIndexes = wanted.slice(0, FRAME_BLOCKS);
  if (wanted.length > FRAME_BLOCKS) {
    diagnostics.push(diagnostic(
      '8BS2111',
      `sprite '${sprite.name}' has ${wanted.length} animation frames; a C64 graphics sprite keeps ${FRAME_BLOCKS} — frames collapsed to the first ${FRAME_BLOCKS}`,
      file, sprite.start, sprite.length, 'warning',
    ));
  }
  const kept = frameIndexes.map((index) => frames[index] ?? frames[0]).filter(Boolean);
  const color = dominantColor(kept);
  const data = [];
  for (const index of frameIndexes) {
    const frame = frames[index] ?? frames[0];
    if (!frame) continue;
    const { indices, colors } = quantize1bit(frame.rgba, frame.width, frame.height);
    if (colors > 1) {
      diagnostics.push(diagnostic(
        '8BS2110',
        `sprite '${sprite.name}' has ${colors} colours; the VIC-II sprite holds one plus transparent — extra colours were quantized`,
        file, sprite.start, sprite.length, 'warning',
      ));
    }
    data.push(...packSprite(indices, frame.width, frame.height));
  }
  if (!data.length) data.push(...new Array(63).fill(0));
  return {
    kind: KIND_C64 | (color << 4),
    data,
    frames: frameIndexes.length,
    every: anim?.every ?? 8,
    width: 24,
    height: 21,
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
    const fallback = sample.fallback?.synth ?? 'noise';
    diagnostics.push(diagnostic(
      '8BS2210',
      `sample '${sample.name}' is not a $D418 digi in this slice; using fallback { synth ${fallback} }`,
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
