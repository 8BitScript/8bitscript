// AIR checker: required fields, unique names, sample fallback, instruments
// a song names. Host decode (missing WAV, FLAC without FFmpeg) happens in
// the linker.
import { Codes, diagnostic } from '../../diagnostics/index.mjs';
import { WAVEFORMS } from './parse.mjs';

// The rows a song runs: its order's patterns end to end (or its first pattern when no order is given).
export function songRows(song) {
  const byName = new Map((song.patterns ?? []).map((p) => [p.name, p]));
  const names = song.order?.length ? song.order : [...byName.keys()].slice(0, 1);
  return names.reduce((sum, name) => sum + (byName.get(name)?.length ?? 0), 0);
}

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
    if (inst.volume < 0 || inst.volume > 15) {
      at(inst, Codes.AUD_SYNTAX, `instrument '${inst.name}': volume is 0..15, not ${inst.volume}`, inst.volumeSpan?.start, inst.volumeSpan?.length);
    }
    if (inst.decay < 0 || inst.decay > 255) {
      at(inst, Codes.AUD_SYNTAX, `instrument '${inst.name}': decay is 0..255 frames, not ${inst.decay}`, inst.decaySpan?.start, inst.decaySpan?.length);
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
      // One voice: two tracks that both start a note on the same row would need two voices.
      const taken = new Map();
      for (const track of pattern.tracks ?? []) {
        for (const row of track.rows ?? []) {
          if (row.instrument && !instruments.has(row.instrument)) {
            at(row, Codes.AUD_UNKNOWN_INSTRUMENT, `cannot find instrument '${row.instrument}'`);
          }
          if (row.note != null) {
            if (row.row < 0 || row.row >= pattern.length) {
              at(row, Codes.AUD_SYNTAX, `row ${row.row} is outside pattern '${pattern.name}' (length ${pattern.length})`);
            }
            if (taken.has(row.row) && taken.get(row.row) !== track.name) {
              at(row, Codes.AUD_SYNTAX, `track '${track.name}' starts a note on row ${row.row}, which track '${taken.get(row.row)}' already uses: a song has one voice`);
            }
            taken.set(row.row, track.name);
          }
          if (row.noteLength != null && (row.noteLength < 1 || row.noteLength > 255)) {
            at(row, Codes.AUD_SYNTAX, `a note's length is 1..255 rows, not ${row.noteLength}`, row.lengthSpan?.start, row.lengthSpan?.length);
          }
          if (row.volume != null && (row.volume < 0 || row.volume > 15)) {
            at(row, Codes.AUD_SYNTAX, `volume is 0..15, not ${row.volume}`, row.volumeSpan?.start, row.volumeSpan?.length);
          }
        }
      }
    }
    const rowsInOrder = songRows(song);
    if (rowsInOrder > 255) {
      at(song, Codes.AUD_SYNTAX, `song '${song.name}' has ${rowsInOrder} rows; a song holds up to 255`);
    }
  }

  return diagnostics;
}
