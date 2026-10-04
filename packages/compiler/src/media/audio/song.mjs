// The portable song bank: how a `song` in a `.8ba` file becomes the bytes a chip driver plays.
// One monophonic voice, so a song is a header and a list of note events in row order.
//
//   header   [flags, speed, rows, count]       flags bit 0 = loop; speed = frames per row;
//                                              rows = the song's length; count = events
//   event    [row, note, packed, length, decay]
//                packed  = waveform (bits 0-1: 0 pulse, 1 noise, 2 triangle, 3 saw)
//                          | volume << 2 (bits 2-5: 0..15)
//                length  = rows the note sounds for (a note ends when it is up, or when the next
//                          one starts; the rows between events are silence)
//                decay   = frames the note takes to die away (0: it holds for its length)
//
// A machine whose driver plays this (the C64, VIC-20, PET, X16 and the web) asks for it through
// the `helpers` argument of its media module's `lowerAudio`; a machine with another format (the
// NES, the Atari 8-bit) does not.
import { songRows } from './check.mjs';

export const SONG_HEADER = 4;
export const EVENT_BYTES = 5;
export const WAVE_CODE = { pulse: 0, noise: 1, triangle: 2, saw: 3 };

/** The note events of `song`, in row order, rows counted from the start of its order. */
export function songEvents(air, song) {
  const instruments = new Map((air.instruments ?? []).map((i) => [i.name, i]));
  const patterns = new Map((song.patterns ?? []).map((p) => [p.name, p]));
  const names = song.order?.length ? song.order : [...patterns.keys()].slice(0, 1);
  const events = [];
  const used = new Set();
  let offset = 0;
  let instrument = null;
  for (const name of names) {
    const pattern = patterns.get(name);
    if (!pattern) continue;
    for (const track of pattern.tracks ?? []) {
      for (const row of track.rows ?? []) {
        if (row.instrument) instrument = instruments.get(row.instrument) ?? instrument;
        if (row.note == null) continue;
        const at = offset + row.row;
        if (used.has(at) || at > 254) continue; // the checker reports a clash and an overrun
        used.add(at);
        events.push({
          row: at,
          note: row.note,
          waveform: instrument?.waveform ?? 'pulse',
          volume: row.volume ?? instrument?.volume ?? 15,
          length: row.noteLength ?? 1,
          decay: instrument?.decay ?? 0,
        });
      }
    }
    offset += pattern.length;
  }
  events.sort((a, b) => a.row - b.row);
  return events;
}

/** `song` as the bytes above: { data, events, rows }. */
export function encodeSong(air, song) {
  const events = songEvents(air, song);
  const rows = Math.min(255, songRows(song));
  const data = [song.loop === false ? 0 : 1, song.speed & 255, rows, events.length & 255];
  for (const e of events) {
    data.push(e.row & 255, e.note & 255, (WAVE_CODE[e.waveform] ?? 0) | ((e.volume & 15) << 2), e.length & 255, e.decay & 255);
  }
  return { data, events, rows };
}
