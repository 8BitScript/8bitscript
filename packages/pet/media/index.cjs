// PET media lowering. PNG → 4×4 quadrant-block shape, or a single glyph
// if the picture cannot survive that. Song → VIA square wave when the
// build has a voice; otherwise omitted.
'use strict';

const KIND_PET = 3;
const KIND_GLYPH = 0;

function downsample(rgba, width, height, dstW, dstH) {
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
          if (rgba[o + 3] >= 16 && (rgba[o] + rgba[o + 1] + rgba[o + 2]) < 500) ink += 1;
        }
      }
      if (n && ink / n >= 0.3) row |= 1 << (dstW - 1 - x);
    }
    bits.push(row);
  }
  return bits;
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
  const bits = downsample(frame.rgba, frame.width, frame.height, 4, 4);
  const ink = bits.reduce((n, row) => n + (row.toString(2).split('1').length - 1), 0);
  if (ink < 2) {
    diagnostics.push(diagnostic(
      '8BS2111',
      `sprite '${sprite.name}' cannot survive as a 4×4 quadrant-block; using a software glyph`,
      file, sprite.start, sprite.length, 'warning',
    ));
    return {
      kind: KIND_GLYPH, data: [0x51], frames: 1, every: anim?.every ?? 8, width: 8, height: 8, chrPatches: [], diagnostics,
    };
  }
  diagnostics.push(diagnostic(
    '8BS2111',
    `sprite '${sprite.name}' is a 4×4 quadrant-block object on the PET`,
    file, sprite.start, sprite.length, 'warning',
  ));
  return {
    kind: KIND_PET,
    data: bits,
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

function lowerAudio(air, _pcm, facts, file, diagnostic) {
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
    const { events, length } = songEvents(air, song);
    songs.push({ name: song.name, data: encodeSong(song, events, length), events });
  }
  return { samples, songs, diagnostics };
}

module.exports = { lowerGraphics, lowerAudio };
