// VIC-20 media lowering. PNG → four RAM glyphs in a 2×2 grid; song → the
// three squares plus noise at $900A–$900D with one shared volume at $900E.
'use strict';

const KIND_VIC20 = 4;
const KIND_GLYPH = 0;
const CODE0 = 128;

function quantize1bit(rgba, width, height) {
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    if (rgba[o + 3] < 16) {
      indices[i] = 255;
      continue;
    }
    const lum = rgba[o] + rgba[o + 1] + rgba[o + 2];
    indices[i] = lum < 500 ? 1 : 255;
  }
  return indices;
}

function packCharTile(indices, width, sx, sy) {
  const out = [];
  for (let y = 0; y < 8; y += 1) {
    let b = 0;
    for (let x = 0; x < 8; x += 1) {
      const ix = sx + x;
      const iy = sy + y;
      if (ix < width && indices[iy * width + ix] === 1) {
        b |= 0x80 >> x;
      }
    }
    out.push(b);
  }
  return out;
}

function lowerGraphics(sprite, frames, _facts, file, diagnostic) {
  const diagnostics = [];
  const frame = frames[0];
  const anim = sprite.animations?.[0];
  if (!frame) {
    return {
      kind: KIND_GLYPH, data: [0x2A], frames: 1, every: 8, width: 8, height: 8, chrPatches: [], diagnostics,
    };
  }
  const indices = quantize1bit(frame.rgba, frame.width, frame.height);
  let ink = 0;
  for (let i = 0; i < indices.length; i += 1) {
    if (indices[i] === 1) ink += 1;
  }
  if (ink < 4) {
    diagnostics.push(diagnostic(
      '8BS2111',
      `sprite '${sprite.name}' cannot survive as four RAM glyphs; using a software glyph`,
      file, sprite.start, sprite.length, 'warning',
    ));
    return {
      kind: KIND_GLYPH, data: [0x51], frames: 1, every: anim?.every ?? 8, width: 8, height: 8, chrPatches: [], diagnostics,
    };
  }
  diagnostics.push(diagnostic(
    '8BS2111',
    `sprite '${sprite.name}' is four redefined RAM glyphs (2×2) on the VIC-20`,
    file, sprite.start, sprite.length, 'warning',
  ));
  const tiles = [];
  for (const [sx, sy] of [[0, 0], [8, 0], [0, 8], [8, 8]]) {
    tiles.push(...packCharTile(indices, frame.width, sx, sy));
  }
  const data = [CODE0, CODE0 + 1, CODE0 + 2, CODE0 + 3, ...tiles];
  return {
    kind: KIND_VIC20,
    data,
    frames: 1,
    every: anim?.every ?? 8,
    width: 16,
    height: 16,
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
