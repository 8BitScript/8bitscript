// Web media lowering. A PNG becomes, per animation step, one 2×2
// quadrant-block code (128-143) — the sixteen block glyphs both renderers
// draw (packages/web/AGENTS.md, "Pseudo-pixels"). The picture is sampled
// at build time, so the program carries one byte per step and the machine
// does no image work.
//
// The default lowering (packages/compiler/src/media/lower-default.mjs)
// picks PETSCII-ish codes — 0xA0 "reverse space", 0x51 "ball" — which the
// web does not draw: its font holds ASCII 32-122 and the blocks at 128-143,
// and nothing else (font8x8.mjs `glyphRows`), so a mostly-filled picture
// came out as an empty cell and a mostly-clear one as the letter Q. The web
// is the one release target with its own font, so it names its own codes.
//
// Audio has no web driver; this module exports no lowerAudio, so the
// compiler's default (silence, 8BS2211) stays.
'use strict';

// The block codes are the sixteen 2×2 patterns, indexed
// topLeft<<3 | topRight<<2 | bottomLeft<<1 | bottomRight
// (packages/cli/src/font8x8.mjs BLOCK_CODE_BASE).
const BLOCK_CODE_BASE = 128;
const KIND_GLYPH = 0;
// graphics/src/index.web.8bs holds this many animation steps per picture.
const MAX_STEPS = 8;
// A quadrant is lit when at least this share of its pixels is opaque.
const LIT_SHARE = 0.3;
const OPAQUE_ALPHA = 16;

/** Opaque-pixel count in each quadrant of a frame: [tl, tr, bl, br]. */
function quadrantInk(frame) {
  const { rgba, width, height } = frame;
  const halfW = width / 2;
  const halfH = height / 2;
  const ink = [0, 0, 0, 0];
  const area = [0, 0, 0, 0];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const q = (y >= halfH ? 2 : 0) + (x >= halfW ? 1 : 0);
      area[q] += 1;
      if (rgba[(y * width + x) * 4 + 3] >= OPAQUE_ALPHA) ink[q] += 1;
    }
  }
  return ink.map((n, q) => (area[q] ? n / area[q] : 0));
}

/**
 * The block code for one frame. A frame with ink always shows some: if no
 * quadrant reaches the share, the inkiest one is lit, so a thin picture
 * does not vanish. A frame with none is the empty block.
 */
function blockOf(frame) {
  const share = quadrantInk(frame);
  const best = Math.max(...share);
  if (best === 0) return BLOCK_CODE_BASE;
  const threshold = best >= LIT_SHARE ? LIT_SHARE : best;
  let pattern = 0;
  for (let q = 0; q < 4; q += 1) {
    if (share[q] >= threshold) pattern |= 8 >> q;
  }
  return BLOCK_CODE_BASE + pattern;
}

function lowerGraphics(sprite, frames, _facts, file, diagnostic) {
  const diagnostics = [];
  const anim = sprite.animations?.[0];
  if (!frames || frames.length === 0) {
    return {
      kind: KIND_GLYPH, data: [BLOCK_CODE_BASE + 15], frames: 1, every: anim?.every ?? 8, width: 8, height: 8, chrPatches: [], diagnostics,
    };
  }
  const sequence = anim?.frames?.length ? anim.frames : [0];
  const kept = sequence.slice(0, MAX_STEPS);
  const data = kept.map((index) => blockOf(frames[index] ?? frames[0]));
  const notes = ['colours dropped'];
  if (kept.length > 1) notes.push(`${kept.length} animation steps kept`);
  if (sequence.length > MAX_STEPS) notes.push(`steps past ${MAX_STEPS} dropped`);
  diagnostics.push(diagnostic(
    '8BS2111',
    `sprite '${sprite.name}' is a 2×2 quadrant-block glyph on the web; ${notes.join('; ')}`,
    file, sprite.start, sprite.length, 'warning',
  ));
  return {
    kind: KIND_GLYPH,
    data,
    frames: kept.length,
    every: anim?.every ?? 8,
    width: 8,
    height: 8,
    chrPatches: [],
    diagnostics,
  };
}

module.exports = { lowerGraphics, blockOf, MAX_STEPS };
