// PET media lowering. PNG → 4×4 quadrant-block shape, or a single glyph
// if the picture cannot survive that. Song → VIA square wave when the
// build has a voice; otherwise omitted.
'use strict';

const KIND_PET = 3;
const KIND_GLYPH = 0;
// Rows of a 4×4 shape, bit 3 the left pixel: the middle two by two.
const CENTRE_BLOCK = [0, 6, 6, 0];

// `byAlpha`: the picture has transparent pixels, so transparency is what
// separates the shape from the paper, as on the C64 — a white sprite on a
// clear background is a white sprite. A fully opaque picture has only its
// colours to go on, and bright is taken for paper.
function downsample(rgba, width, height, dstW, dstH, byAlpha) {
  const bits = [];
  for (let y = 0; y < dstH; y += 1) {
    let row = 0;
    for (let x = 0; x < dstW; x += 1) {
      const x0 = Math.floor((x * width) / dstW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / dstW));
      const y0 = Math.floor((y * height) / dstH);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / dstH));
      let ink = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < width; sx += 1) {
          const o = (sy * width + sx) * 4;
          n += 1;
          if (rgba[o + 3] >= 16 && (byAlpha || (rgba[o] + rgba[o + 1] + rgba[o + 2]) < 500)) ink += 1;
        }
      }
      if (n && ink / n >= 0.3) row |= 1 << (dstW - 1 - x);
    }
    bits.push(row);
  }
  return bits;
}

// The sprite layer holds this many shapes in all (`sprites.SHAPES` in
// packages/sprites/src/index.pet.8bs), and an animation spends one shape
// a frame, so one picture cannot have more frames than that.
const MAX_FRAMES = 7;

// `shared` is the per-build tally the linker hands every `.8bg` in turn
// (`mediaSlots`): the shapes spent so far, counted in the order the
// pictures are bound, so a picture that finds none left is told at build
// time rather than discovered as a missing sprite. Absent (a lone call from
// a test or an editor), the whole budget is there.
function lowerGraphics(sprite, frames, _facts, file, diagnostic, shared) {
  const diagnostics = [];
  const anim = sprite.animations?.[0];
  if (!frames.length) {
    return {
      kind: KIND_GLYPH, data: [0x2A], frames: 1, every: 8, width: 8, height: 8, chrPatches: [], diagnostics,
    };
  }
  const left = MAX_FRAMES - (shared?.petShapes ?? 0);
  if (left <= 0) {
    diagnostics.push(diagnostic(
      '8BS2111',
      `sprite '${sprite.name}' is not drawn: the PET holds ${MAX_FRAMES} shapes in all and earlier pictures have taken them`,
      file, sprite.start, sprite.length, 'warning',
    ));
    return {
      kind: KIND_PET, data: [], frames: 0, every: anim?.every ?? 8, width: 16, height: 16, chrPatches: [], diagnostics,
    };
  }
  const wanted = anim?.frames?.length ? anim.frames : [0];
  const indexes = wanted.slice(0, left);
  const picked = indexes.map((index) => frames[index] ?? frames[0]);
  const byAlpha = picked.some((frame) => {
    for (let o = 3; o < frame.rgba.length; o += 4) if (frame.rgba[o] < 16) return true;
    return false;
  });
  const rows = picked.map((frame) => downsample(frame.rgba, frame.width, frame.height, 4, 4, byAlpha));
  const ink = rows.flat().reduce((n, row) => n + (row.toString(2).split('1').length - 1), 0);
  if (ink < 2) {
    // A picture of one lit quadrant or none: all it can show is a mark, so
    // it becomes a small block in the middle of the 4×4 — still a shape
    // the sprite layer places and restores like any other.
    diagnostics.push(diagnostic(
      '8BS2111',
      `sprite '${sprite.name}' cannot survive as a 4×4 quadrant-block; using a small centre block`,
      file, sprite.start, sprite.length, 'warning',
    ));
    if (shared) shared.petShapes = (shared.petShapes ?? 0) + 1;
    return {
      kind: KIND_PET, data: CENTRE_BLOCK, frames: 1, every: anim?.every ?? 8, width: 16, height: 16, chrPatches: [], diagnostics,
    };
  }
  const dropped = wanted.length - indexes.length;
  diagnostics.push(diagnostic(
    '8BS2111',
    `sprite '${sprite.name}' is a 4×4 quadrant-block object on the PET`
      + (indexes.length > 1 ? `, ${indexes.length} frames` : '')
      + (dropped ? `; the last ${dropped} frame${dropped === 1 ? '' : 's'} dropped (the PET holds ${MAX_FRAMES} shapes in all)` : ''),
    file, sprite.start, sprite.length, 'warning',
  ));
  if (shared) shared.petShapes = (shared.petShapes ?? 0) + indexes.length;
  return {
    kind: KIND_PET,
    data: rows.flat(),
    frames: indexes.length,
    every: anim?.every ?? 8,
    width: 16,
    height: 16,
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
  for (const sample of air.samples ?? []) {
    if (!voices) {
      diagnostics.push(diagnostic(
        '8BS2211',
        `target 'pet' has no audio driver yet; playback omitted`,
        file, sample.start, sample.length, 'warning',
      ));
      samples.push({ name: sample.name, data: [], events: [] });
      continue;
    }
    const fallback = sample.fallback?.synth ?? 'pulse';
    if (fallback === 'noise') {
      diagnostics.push(diagnostic(
        '8BS2210',
        `sample '${sample.name}' cannot play noise on the PET's one square wave; omitted`,
        file, sample.start, sample.length, 'warning',
      ));
      samples.push({ name: sample.name, data: [], events: [] });
    } else {
      samples.push({ name: sample.name, data: [WAVE.pulse, 60], events: [] });
    }
  }
  for (const song of air.songs ?? []) {
    if (!voices) {
      diagnostics.push(diagnostic(
        '8BS2211',
        `target 'pet' has no audio driver yet; playback omitted`,
        file, song.start, song.length, 'warning',
      ));
      songs.push({ name: song.name, data: [], events: [] });
      continue;
    }
    const { data, events } = helpers.encodeSong(song);
    songs.push({ name: song.name, data, events });
  }
  return { samples, songs, diagnostics };
}

module.exports = { lowerGraphics, lowerAudio };
