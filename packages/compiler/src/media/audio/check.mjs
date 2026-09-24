// AIR checker: required fields, unique names, sample fallback, instruments
// a song names. Host decode (missing WAV, FLAC without FFmpeg) happens in
// the linker.
import { Codes, diagnostic } from '../../diagnostics/index.mjs';
import { WAVEFORMS } from './parse.mjs';

export function checkAudio(air, file) {
  const diagnostics = [];
  const names = new Set();
  const instruments = new Map();
  const at = (node, code, message, start, length, severity = 'error') => {
    diagnostics.push(diagnostic(code, message, file, start ?? node.start ?? 0, length ?? node.length ?? 0, severity));
  };

  for (const inst of air.instruments ?? []) {
    if (!inst.name) continue;
    if (names.has(inst.name)) at(inst, Codes.AUD_DUPLICATE_NAME, `'${inst.name}' is already declared`);
    names.add(inst.name);
    instruments.set(inst.name, inst);
    if (!WAVEFORMS.has(inst.waveform)) {
      at(inst, Codes.AUD_UNKNOWN_WAVEFORM, `unknown waveform '${inst.waveform}'`);
    }
    if (inst.polyphony !== 1) {
      at(inst, Codes.AUD_SYNTAX, `this slice only accepts polyphony 1, not ${inst.polyphony}`);
    }
  }

  for (const sample of air.samples ?? []) {
    if (!sample.name) continue;
    if (names.has(sample.name)) at(sample, Codes.AUD_DUPLICATE_NAME, `'${sample.name}' is already declared`);
    names.add(sample.name);
    if (!sample.source) at(sample, Codes.AUD_MISSING_FIELD, `sample '${sample.name}' needs a source "...wav" or "...flac"`);
    if (!sample.fallback) {
      at(sample, Codes.AUD_MISSING_FALLBACK, `sample '${sample.name}' needs fallback { synth <waveform> }`, sample.fallbackStart, sample.fallbackLength);
    }
  }

  for (const song of air.songs ?? []) {
    if (!song.name) continue;
    if (names.has(song.name)) at(song, Codes.AUD_DUPLICATE_NAME, `'${song.name}' is already declared`);
    names.add(song.name);
    if (!song.tempo) at(song, Codes.AUD_MISSING_FIELD, `song '${song.name}' needs a tempo`);
    if (!song.speed) at(song, Codes.AUD_MISSING_FIELD, `song '${song.name}' needs a speed`);
    for (const pattern of song.patterns ?? []) {
      for (const track of pattern.tracks ?? []) {
        for (const row of track.rows ?? []) {
          if (row.instrument && !instruments.has(row.instrument)) {
            at(row, Codes.AUD_UNKNOWN_INSTRUMENT, `cannot find instrument '${row.instrument}'`);
          }
        }
      }
    }
  }

  return diagnostics;
}
