// Atari 8-bit media lowering. PNG uses the glyph path the existing sprite
// layer already has (no player/missile twin yet), reported. Song drives
// POKEY. Sample uses the synth fallback (volume-only PCM is a special case).
'use strict';

const KIND_GLYPH = 0;

function glyphOf(rgba) {
  let ink = 0;
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 16) continue;
    n += 1;
    if ((rgba[i] + rgba[i + 1] + rgba[i + 2]) < 500) ink += 1;
  }
  if (!n) return 0x2A;
  if (ink / n > 0.45) return 0xA0;
  return 0x51;
}

function lowerGraphics(sprite, frames, _facts, file, diagnostic) {
  const diagnostics = [];
  const frame = frames[0];
  const anim = sprite.animations?.[0];
  const collapsed = (anim?.frames?.length ?? 1) > 1;
  diagnostics.push(diagnostic(
    '8BS2111',
    `sprite '${sprite.name}' is a software glyph on atari8${collapsed ? '; frames collapsed' : ''}`,
    file, sprite.start, sprite.length, 'warning',
  ));
  return {
    kind: KIND_GLYPH,
    data: [frame ? glyphOf(frame.rgba) : 0x2A],
    frames: 1,
    every: anim?.every ?? 8,
    width: 8,
    height: 8,
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
      `sample '${sample.name}' is not volume-only PCM in this slice; using fallback { synth ${fallback} }`,
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
