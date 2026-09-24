// NES media lowering. PNG → CHR tiles + OAM sprite. Sample → DPCM when
// the encoder can represent it, otherwise the declared synth fallback.
'use strict';

const KIND_NES = 2;
const FIRST_TILE = 0xe0;

function packTile(indices, width, sx, sy) {
  const lo = new Uint8Array(8);
  const hi = new Uint8Array(8);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const ix = sx + x;
      const iy = sy + y;
      if (ix >= width) continue;
      const v = indices[iy * width + ix];
      if (v === 255) continue;
      const bit = 0x80 >> x;
      if (v & 1) lo[y] |= bit;
      if (v & 2) hi[y] |= bit;
    }
  }
  return [...lo, ...hi];
}

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

function lowerGraphics(sprite, frames, _facts, file, diagnostic) {
  const diagnostics = [];
  const anim = sprite.animations?.[0];
  const frameIndexes = anim?.frames?.length ? anim.frames : [0];
  const data = [];
  const chrPatches = [];
  let tile = FIRST_TILE;
  const tw = sprite.width >= 16 ? 16 : 8;
  const th = sprite.height >= 16 ? 16 : 8;
  for (const index of frameIndexes) {
    const frame = frames[index] ?? frames[0];
    if (!frame) continue;
    const { indices, colors } = quantize2bit(frame.rgba, frame.width, frame.height);
    if (colors > 3) {
      diagnostics.push(diagnostic(
        '8BS2110',
        `sprite '${sprite.name}' has ${colors} colours; an NES sprite tile holds three plus transparent — extra colours were quantized`,
        file, sprite.start, sprite.length, 'warning',
      ));
    }
    const tiles = [];
    for (const [sx, sy] of th === 16 ? [[0, 0], [8, 0], [0, 8], [8, 8]] : [[0, 0]]) {
      const bytes = packTile(indices, frame.width, sx, sy);
      chrPatches.push({ tile, bytes });
      tiles.push(tile);
      tile += 1;
    }
    data.push(...tiles);
  }
  return {
    kind: KIND_NES,
    data,
    frames: frameIndexes.length,
    every: anim?.every ?? 8,
    width: tw,
    height: th,
    chrPatches,
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
        events.push({ row: row.row, note: row.note, waveform: lastInst?.waveform ?? 'pulse', voice: 0 });
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

function lowerAudio(air, pcmBySample, _facts, file, diagnostic) {
  const diagnostics = [];
  const samples = [];
  const songs = [];
  for (const sample of air.samples ?? []) {
    const dpcm = pcmBySample.get(sample.name)?.dpcm;
    if (dpcm) {
      samples.push({ name: sample.name, data: [255, dpcm.length, ...dpcm.bytes], events: [] });
    } else {
      const fallback = sample.fallback?.synth ?? 'noise';
      diagnostics.push(diagnostic(
        '8BS2210',
        `sample '${sample.name}' cannot be DPCM on this clip; using fallback { synth ${fallback} }`,
        file, sample.start, sample.length, 'warning',
      ));
      samples.push({ name: sample.name, data: [WAVE[fallback] ?? 1, 60], events: [] });
    }
  }
  for (const song of air.songs ?? []) {
    const { events, length } = songEvents(air, song);
    const saw = events.find((e) => e.waveform === 'saw');
    if (saw) {
      diagnostics.push(diagnostic(
        '8BS2212',
        `waveform 'saw' cannot route on 'nes'`,
        file, song.start, song.length, 'error',
      ));
    }
    songs.push({ name: song.name, data: encodeSong(song, events, length), events });
  }
  return { samples, songs, diagnostics };
}

module.exports = { lowerGraphics, lowerAudio };
