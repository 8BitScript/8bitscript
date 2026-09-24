// Default media lowering: every machine without a `"8bitscript".media`
// module. Graphics become a software glyph (the path @8bitscript/sprites
// already has). Audio with no driver emits no song bytes.
import { quantize, bitmask, brightness } from '@8bitscript/graphics-tools';
import { Codes, diagnostic } from '../diagnostics/index.mjs';

export const KIND_GLYPH = 0;
export const KIND_C64 = 1;
export const KIND_NES = 2;
export const KIND_PET = 3;

export const WAVE_PULSE = 0;
export const WAVE_NOISE = 1;
export const WAVE_TRIANGLE = 2;
export const WAVE_SAW = 3;

const WAVE_INDEX = { pulse: WAVE_PULSE, noise: WAVE_NOISE, triangle: WAVE_TRIANGLE, saw: WAVE_SAW };

export function waveIndex(name) {
  return WAVE_INDEX[name] ?? WAVE_PULSE;
}

/** One PETSCII-ish glyph from a frame: a filled cell if mostly ink, else a ball. */
export function glyphOf(frame) {
  const { indices } = quantize(frame.rgba, 2);
  const ink = indices.filter((v) => v !== 255).length;
  const total = indices.length || 1;
  if (ink / total > 0.45) return 0xA0; // reverse space
  if (brightness(frame.rgba) > 40) return 0x51; // ball
  return 0x2A; // asterisk — the sprites default
}

export function lowerGraphicsDefault(sprite, frames, file) {
  const diagnostics = [];
  const first = frames[0];
  const glyph = first ? glyphOf(first) : 0x2A;
  const collapsed = (sprite.animations?.[0]?.frames?.length ?? 1) > 1;
  diagnostics.push(diagnostic(
    Codes.GFX_ADAPTED,
    `sprite '${sprite.name}' is a software glyph on this target${collapsed ? '; frames collapsed' : ''}`,
    file, sprite.start, sprite.length, 'warning',
  ));
  return {
    kind: KIND_GLYPH,
    data: [glyph],
    frames: 1,
    every: sprite.animations?.[0]?.every ?? 8,
    width: 8,
    height: 8,
    chrPatches: [],
    diagnostics,
  };
}

export function songEvents(air, song) {
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
        });
      }
    }
  }
  const length = song.patterns[0]?.length ?? 16;
  return { events, length };
}

export function encodeSong(song, events, length) {
  const bytes = [song.tempo & 255, song.speed & 255, length & 255, events.length & 255];
  for (const e of events) {
    bytes.push(e.row & 255, e.note & 255, waveIndex(e.waveform), e.voice & 255);
  }
  return bytes;
}

export function lowerAudioDefault(air, _pcmBySample, file, { machine } = {}) {
  const diagnostics = [];
  const samples = [];
  const songs = [];
  const at = (node, code, message, severity = 'warning') => {
    diagnostics.push(diagnostic(code, message, file, node.start ?? 0, node.length ?? 0, severity));
  };

  // No `"8bitscript".media` module means no on-machine driver. Silence is
  // the declared fallback: no song bytes, a diagnostic that names the target.
  for (const sample of air.samples ?? []) {
    at(sample, Codes.AUD_NO_DRIVER, `target '${machine}' has no audio driver yet; playback omitted`);
    samples.push({ name: sample.name, data: [], events: [] });
  }
  for (const song of air.songs ?? []) {
    at(song, Codes.AUD_NO_DRIVER, `target '${machine}' has no audio driver yet; playback omitted`);
    songs.push({ name: song.name, data: [], events: [] });
  }

  return { samples, songs, diagnostics };
}

export { bitmask, quantize };
