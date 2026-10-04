// VIC-20 media lowering. PNG → screen codes, worked out here: the sprite is
// reduced to the ROM's quadrant-block characters while the program is being
// built, so what reaches the machine is one byte per cell per frame and
// nothing for it to compute. Song → the three squares plus noise at
// $900A–$900D with one shared volume at $900E.
//
// The ROM has the sixteen 2×2 on/off patterns of a cell (screen codes 32,
// 97–127 and their reverses — the table below, measured against this
// machine's own character ROM under xvic, see @8bitscript/graphics'
// index.vic20.8bs), which turn the 22 × 23 grid into 44 × 46
// pseudo-pixels. A sprite is reduced onto that grid: one cell for a source
// of 8 pixels or fewer in a direction, two for anything larger (larger
// sources are scaled down to it, as the PET's are), and a pseudo-pixel is
// lit when any opaque dark pixel of the source falls in it. A sprite with
// almost no ink survives no better than one glyph, so it becomes one.
//
// An earlier version packed the four 8×8 tiles of a 16×16 and left the
// reduction to the machine, which then held a 256-byte table of them in
// RAM, ignored the sprite's size (an 8×8 drew three blank cells beside its
// one) and used only its first frame.
'use strict';

const KIND_VIC20 = 4;
const KIND_GLYPH = 0;
const GLYPH = 0x51; // a ball, the screen code a faint sprite is drawn as
// How many frames one sprite may carry. The driver's pool of codes is
// fixed (index.vic20.8bs POOL); a sprite is cut to this and says so.
const MAX_FRAMES = 8;
// The bytes of that pool, shared by every object in the build
// (index.vic20.8bs POOL; packages/graphics/test/vic20-ops.test.mjs holds the
// two together). An object that does not fit is not drawn, and a media
// module sees one sprite at a time, so each sprite says what it takes.
const POOL = 64;

// Screen code for each 2×2 pattern, indexed by TL<<3 | TR<<2 | BL<<1 | BR.
const QUAD = [32, 108, 123, 98, 124, 225, 255, 254, 126, 127, 97, 252, 226, 251, 236, 160];

function isInk(rgba, o) {
  return rgba[o + 3] >= 16 && rgba[o] + rgba[o + 1] + rgba[o + 2] < 500;
}

function inkCount(frame) {
  let n = 0;
  for (let i = 0; i < frame.width * frame.height; i += 1) {
    if (isInk(frame.rgba, i * 4)) n += 1;
  }
  return n;
}

// The frame's pseudo-pixels, `pw` × `ph`, each lit if any ink falls in the
// part of the source it covers.
function pseudoPixels(frame, pw, ph) {
  const bits = [];
  for (let y = 0; y < ph; y += 1) {
    const y0 = Math.floor((y * frame.height) / ph);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * frame.height) / ph));
    for (let x = 0; x < pw; x += 1) {
      const x0 = Math.floor((x * frame.width) / pw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * frame.width) / pw));
      let on = 0;
      for (let sy = y0; sy < y1 && sy < frame.height && !on; sy += 1) {
        for (let sx = x0; sx < x1 && sx < frame.width; sx += 1) {
          if (isInk(frame.rgba, (sy * frame.width + sx) * 4)) { on = 1; break; }
        }
      }
      bits.push(on);
    }
  }
  return bits;
}

function frameCodes(frame, cw, ch) {
  const pw = cw * 2;
  const bits = pseudoPixels(frame, pw, ch * 2);
  const at = (x, y) => bits[y * pw + x];
  const codes = [];
  for (let cy = 0; cy < ch; cy += 1) {
    for (let cx = 0; cx < cw; cx += 1) {
      const x = cx * 2;
      const y = cy * 2;
      codes.push(QUAD[(at(x, y) << 3) | (at(x + 1, y) << 2) | (at(x, y + 1) << 1) | at(x + 1, y + 1)]);
    }
  }
  return codes;
}

function lowerGraphics(sprite, frames, _facts, file, diagnostic) {
  const diagnostics = [];
  const anim = sprite.animations?.[0];
  const every = anim?.every ?? 8;
  const glyph = {
    kind: KIND_GLYPH, data: [GLYPH], frames: 1, every, width: 8, height: 8, chrPatches: [], diagnostics,
  };
  if (!frames[0]) {
    glyph.data = [0x2A];
    return glyph;
  }
  const wanted = anim?.frames?.length ? anim.frames : [0];
  const used = wanted.slice(0, MAX_FRAMES).map((index) => frames[index] ?? frames[0]);
  if (wanted.length > MAX_FRAMES) {
    diagnostics.push(diagnostic(
      '8BS2111',
      `sprite '${sprite.name}' has ${wanted.length} animation frames; the VIC-20 keeps the first ${MAX_FRAMES}`,
      file, sprite.start, sprite.length, 'warning',
    ));
  }
  if (used.reduce((n, frame) => n + inkCount(frame), 0) < 4) {
    diagnostics.push(diagnostic(
      '8BS2111',
      `sprite '${sprite.name}' has too little ink to survive as quadrant blocks; using a software glyph`,
      file, sprite.start, sprite.length, 'warning',
    ));
    return glyph;
  }
  const { width: w, height: h } = used[0];
  const cw = w > 8 ? 2 : 1;
  const ch = h > 8 ? 2 : 1;
  diagnostics.push(diagnostic(
    '8BS2111',
    `sprite '${sprite.name}' is a ${cw}×${ch}-cell quadrant-block object on the VIC-20, `
      + `taking ${used.length * cw * ch} of the ${POOL} pool bytes every object shares; `
      + 'one that does not fit is not drawn',
    file, sprite.start, sprite.length, 'warning',
  ));
  return {
    kind: KIND_VIC20,
    data: used.flatMap((frame) => frameCodes(frame, cw, ch)),
    frames: used.length,
    every,
    width: cw * 8,
    height: ch * 8,
    chrPatches: [],
    diagnostics,
  };
}

const WAVE = { pulse: 0, noise: 1, triangle: 2, saw: 3 };
const VOICE = { pulse: 0, noise: 3, triangle: 1, saw: 2 };

function songEvents(air, song) {
  const instruments = new Map((air.instruments ?? []).map((i) => [i.name, i]));
  const patternByName = new Map((song.patterns ?? []).map((p) => [p.name, p]));
  const events = [];
  let lastInst = null;
  for (const name of song.order.length ? song.order : [...patternByName.keys()].slice(0, 1)) {
    const pattern = patternByName.get(name);
    if (!pattern) continue;
    for (const track of pattern.tracks ?? []) {
      for (const row of track.rows ?? []) {
        if (row.instrument) lastInst = instruments.get(row.instrument) ?? lastInst;
        if (row.note == null) continue;
        const wf = lastInst?.waveform ?? 'pulse';
        events.push({ row: row.row, note: row.note, waveform: wf, voice: VOICE[wf] ?? 0 });
      }
    }
  }
  return { events, length: song.patterns[0]?.length ?? 16 };
}

function encodeSong(song, events, length) {
  const bytes = [song.tempo & 255, song.speed & 255, length & 255, events.length & 255];
  for (const e of events) bytes.push(e.row & 255, e.note & 255, WAVE[e.waveform] ?? 0, e.voice & 255);
  return bytes;
}

function lowerAudio(air, _pcm, facts, file, diagnostic) {
  const diagnostics = [];
  const samples = [];
  const songs = [];
  const voices = Number(facts?.['audio.voices'] ?? 0);
  if (!voices) {
    for (const sample of air.samples ?? []) {
      diagnostics.push(diagnostic(
        '8BS2211',
        `target 'vic20' has no audio driver yet; playback omitted`,
        file, sample.start, sample.length, 'warning',
      ));
      samples.push({ name: sample.name, data: [], events: [] });
    }
    for (const song of air.songs ?? []) {
      diagnostics.push(diagnostic(
        '8BS2211',
        `target 'vic20' has no audio driver yet; playback omitted`,
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
      `sample '${sample.name}' is not PCM on the VIC; using fallback { synth ${fallback} }`,
      file, sample.start, sample.length, 'warning',
    ));
    samples.push({ name: sample.name, data: [WAVE[fallback] ?? 1, 60], events: [] });
  }
  for (const song of air.songs ?? []) {
    const { events, length } = songEvents(air, song);
    const saw = events.find((e) => e.waveform === 'saw');
    if (saw) {
      diagnostics.push(diagnostic(
        '8BS2212',
        `waveform 'saw' cannot route on 'vic20'`,
        file, song.start, song.length, 'error',
      ));
    }
    songs.push({ name: song.name, data: encodeSong(song, events, length), events });
  }
  return { samples, songs, diagnostics };
}

module.exports = { lowerGraphics, lowerAudio };
