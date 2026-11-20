// Web media lowering. A PNG becomes a 4bpp pixel sprite the page draws, with
// its own palette; a song or sample becomes the web host's one oscillator.
//
// What the graphics twin (@8bitscript/graphics' index.web.8bs and
// index.cx16.web.8bs) is handed, byte by byte through graphics.bind:
//
//   bytes 0..1    where this sprite's frames start in the shared pool, low byte
//                 then high byte: the build counts the pool across every
//                 picture of the link, in the order the program declares them
//   bytes 2..33   the sprite's palette: sixteen 12-bit colours in VERA's order
//                 (GGGGBBBB, then 0000RRRR); entry 0 is the clear one
//   bytes 34..    every animation frame, one after another, each a linear 4bpp
//                 bitmap (width/2 bytes a row, the LEFT pixel in the HIGH nibble)
//
// Bytes 2.. are the Commander X16's own lowering, byte for byte: the picture
// is quantized the same way on both, so a program looks the same on either.
// The three limits come from the build's facts (packages/web/package.json
// hardware): video.sprites slots, video.spriteWidth x video.spriteHeight bytes
// of window per sprite, and video.spriteKib KiB of pool every picture shares.
//
// Audio: the web host plays songs and samples through its one oscillator (audio.tone's voice),
// square, triangle or sawtooth; noise has no oscillator here, so it plays as the square.
'use strict';

const KIND_WEB = 6;
const PALETTE_COLORS = 15;
const SIZES = [8, 16, 32, 64];
const PALETTE_BYTES = 32;

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

function empty(sprite, diagnostics, every) {
  return {
    kind: KIND_WEB, data: [], frames: 0, every, width: 8, height: 8, chrPatches: [], diagnostics,
  };
}

function lowerGraphics(sprite, frames, facts, file, diagnostic, tally) {
  const diagnostics = [];
  const warn = (code, text) => diagnostics.push(diagnostic(code, text, file, sprite.start, sprite.length, 'warning'));
  const anim = sprite.animations?.[0];
  const every = anim?.every ?? 8;
  const slot = tally ? tally.graphics - 1 : 0;
  const max = facts?.['video.sprites'] ?? 0;
  if (slot >= max) {
    warn('8BS2111', `sprite '${sprite.name}' is slot ${slot}; this build has ${max} sprites, so it is never drawn`);
    return empty(sprite, diagnostics, every);
  }
  // A source with no picture is one white 8x8 block.
  const source = frames?.[0] ? frames : [{ width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4).fill(255) }];
  const width = legalSize(source[0].width);
  const height = legalSize(source[0].height);
  if (source[0].width > 64 || source[0].height > 64) {
    warn('8BS2111', `sprite '${sprite.name}' is ${source[0].width}x${source[0].height}; a web sprite is at most 64x64 — the rest was cut`);
  }
  let order = anim?.frames?.length && frames?.[0] ? [...anim.frames] : [0];
  const frameBytes = (width * height) / 2;
  const window = (facts?.['video.spriteWidth'] ?? 0) * (facts?.['video.spriteHeight'] ?? 0);
  const fit = Math.max(1, Math.floor(window / frameBytes));
  if (order.length > fit) {
    warn('8BS2111', `sprite '${sprite.name}': ${order.length} frames of ${width}x${height} do not fit its ${window}-byte window; the first ${fit} are kept`);
    order = order.slice(0, fit);
  }
  const pool = (facts?.['video.spriteKib'] ?? 0) * 1024;
  const at = tally?.webSpriteBytes ?? 0;
  const kept = Math.min(order.length, Math.max(0, Math.floor((pool - at) / frameBytes)));
  if (kept < order.length) {
    warn('8BS2111', `sprite '${sprite.name}': the ${pool}-byte sprite pool has ${Math.max(0, pool - at)} bytes left; ${kept} of ${order.length} frames kept`);
  }
  if (tally) tally.webSpriteBytes = at + kept * frameBytes;
  const used = order.slice(0, kept).map((i) => source[i] ?? source[0]);
  const { colors, distinct } = buildPalette(used);
  if (distinct > PALETTE_COLORS) {
    warn('8BS2110', `sprite '${sprite.name}' has ${distinct} colours; a web sprite holds ${PALETTE_COLORS} plus transparent — the rarest were mapped to the nearest kept`);
  }
  const data = [at & 255, at >> 8, ...new Array(PALETTE_BYTES).fill(0)];
  colors.forEach((key, i) => {
    data[2 + (i + 1) * 2] = (((key >> 4) & 15) << 4) | (key & 15);
    data[2 + (i + 1) * 2 + 1] = (key >> 8) & 15;
  });
  for (const frame of used) data.push(...packFrame(frame, colors, width, height));
  return {
    kind: KIND_WEB,
    data,
    frames: used.length,
    every,
    width,
    height,
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

module.exports = { lowerGraphics, lowerAudio };
