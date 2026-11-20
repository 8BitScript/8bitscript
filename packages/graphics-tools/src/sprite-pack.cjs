// The 4bpp sprite packing the Commander X16 and the web share: a legal
// sprite size, a palette of the picture's own most-used colours in 12 bits,
// and linear frames (two pixels a byte, the left one in the high nibble).
// Both machines' media lowerings require this; the target image never
// contains it.
'use strict';

const PALETTE_COLORS = 15;
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

module.exports = { legalSize, rgb12, buildPalette, nearest, packFrame };
