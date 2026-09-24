// CX16 media lowering. PNG → a VERA sprite (attributes at $1FC00); song →
// the VERA PSG at $1F9C0.
'use strict';

const KIND_CX16 = 5;
const KIND_GLYPH = 0;
const SPRITE_INDEX = 1;

function quantize2bit(rgba, width, height) {
  const indices = new Uint8Array(width * height);
  const seen = new Map();
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    if (rgba[o + 3] < 16) {
      indices[i] = 255;
      continue;
    }
    const key = `${rgba[o] >> 5},${rgba[o + 1] >> 5},${rgba[o + 2] >> 5}`;
    if (!seen.has(key)) seen.set(key, Math.min(3, seen.size));
    indices[i] = seen.get(key);
  }
  return { indices, colors: seen.size };
}

function packTile4bpp(indices, width, sx, sy) {
  const out = new Uint8Array(32);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 2) {
      const a = indices[(sy + y) * width + (sx + x)];
      const b = indices[(sy + y) * width + (sx + x + 1)];
      const lo = a === 255 ? 0 : a;
      const hi = b === 255 ? 0 : b;
      out[y * 4 + x / 2] = lo | (hi << 4);
    }
  }
  return [...out];
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
  const { indices, colors } = quantize2bit(frame.rgba, frame.width, frame.height);
  if (colors > 3) {
    diagnostics.push(diagnostic(
      '8BS2110',
      `sprite '${sprite.name}' has ${colors} colours; a VERA 4bpp tile holds three plus transparent — extra colours were quantized`,
      file, sprite.start, sprite.length, 'warning',
    ));
  }
  diagnostics.push(diagnostic(
    '8BS2111',
    `sprite '${sprite.name}' is a VERA hardware sprite on the Commander X16`,
    file, sprite.start, sprite.length, 'warning',
  ));
  const tiles = [];
  for (const [sx, sy] of [[0, 0], [8, 0], [0, 8], [8, 8]]) {
    tiles.push(...packTile4bpp(indices, frame.width, sx, sy));
  }
  const data = [SPRITE_INDEX, 0, 0, 0, ...tiles];
  return {
    kind: KIND_CX16,
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
        events.push({
          row: row.row,
          note: row.note,
          waveform: lastInst?.waveform ?? 'pulse',
          voice: 0,
          volume: lastInst?.volume ?? 15,
        });
      }
    }
  }
  return { events, length: song.patterns[0]?.length ?? 16 };
}

function encodeSong(song, events, length) {
  const bytes = [song.tempo & 255, song.speed & 255, length & 255, events.length & 255];
  for (const e of events) {
    bytes.push(e.row & 255, e.note & 255, WAVE[e.waveform] ?? 0, e.voice & 255);
  }
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
    const { events, length } = songEvents(air, song);
    for (const e of events) {
      if (e.volume != null && e.volume !== 15) {
        diagnostics.push(diagnostic(
          '8BS2212',
          `per-voice volume is not supported on 'cx16' in this slice`,
          file, song.start, song.length, 'warning',
        ));
        break;
      }
    }
    songs.push({ name: song.name, data: encodeSong(song, events, length), events });
  }
  return { samples, songs, diagnostics };
}

module.exports = { lowerGraphics, lowerAudio };
