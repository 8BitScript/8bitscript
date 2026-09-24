// C64 media lowering. PNG → 24×21 VIC-II sprite bytes (16×16 is padded).
// The sample does not become a $D418 digi: fallback { synth } is what plays.
'use strict';

const KIND_C64 = 1;

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
  const frameIndexes = anim?.frames?.length ? anim.frames : [0];
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
    kind: KIND_C64,
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

function lowerAudio(air, _pcm, _facts, file, diagnostic) {
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
    const { events, length } = songEvents(air, song);
    songs.push({ name: song.name, data: encodeSong(song, events, length), events });
  }
  return { samples, songs, diagnostics };
}

module.exports = { lowerGraphics, lowerAudio };
