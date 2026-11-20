//! Port of `media/audio/song.mjs:1-66`: the portable song bank. One
//! monophonic voice, so a song is a header and a list of note events in
//! row order.
//!
//! ```text
//! header   [flags, speed, rows, count]
//! event    [row, note, packed, length, decay]
//! ```

use super::check::{order_names, song_rows};
use super::{Air, Instrument, Pattern, Song};
use indexmap::IndexMap;
use jsnum::to_int32;
use serde::Serialize;

pub const SONG_HEADER: usize = 4;
pub const EVENT_BYTES: usize = 5;

/// `WAVE_CODE[waveform] ?? 0`.
#[must_use]
pub fn wave_code(waveform: &str) -> i32 {
    match waveform {
        "noise" => 1,
        "triangle" => 2,
        "saw" => 3,
        _ => 0,
    }
}

/// One note event.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SongEvent {
    pub row: f64,
    pub note: f64,
    pub waveform: String,
    pub volume: f64,
    pub length: f64,
    pub decay: f64,
}

/// `songEvents(air, song)`: the events of `song`, in row order, rows counted
/// from the start of its order.
#[must_use]
pub fn song_events(air: &Air, song: &Song) -> Vec<SongEvent> {
    let mut instruments: IndexMap<&str, &Instrument> = IndexMap::new();
    for i in &air.instruments {
        instruments.insert(i.name.as_str(), i);
    }
    let mut patterns: IndexMap<&str, &Pattern> = IndexMap::new();
    for p in &song.patterns {
        patterns.insert(p.name.as_str(), p);
    }
    let names = order_names(song, &patterns);
    let mut events: Vec<SongEvent> = Vec::new();
    let mut used: Vec<f64> = Vec::new();
    let mut offset = 0.0;
    let mut instrument: Option<&Instrument> = None;
    for name in names {
        let Some(pattern) = patterns.get(name) else {
            continue;
        };
        for track in &pattern.tracks {
            for row in &track.rows {
                if let Some(n) = row.instrument.as_deref().filter(|n| !n.is_empty())
                    && let Some(i) = instruments.get(n)
                {
                    instrument = Some(i);
                }
                let Some(note) = row.note else { continue };
                let at = offset + row.row;
                // The checker reports a clash and an overrun.
                if used.contains(&at) || at > 254.0 {
                    continue;
                }
                used.push(at);
                events.push(SongEvent {
                    row: at,
                    note,
                    waveform: instrument
                        .map_or_else(|| "pulse".to_string(), |i| i.waveform.clone()),
                    volume: row.volume.or(instrument.map(|i| i.volume)).unwrap_or(15.0),
                    length: row.note_length.unwrap_or(1.0),
                    decay: instrument.map_or(0.0, |i| i.decay),
                });
            }
        }
        offset += pattern.length;
    }
    // `Array.prototype.sort` is stable.
    events.sort_by(|a, b| a.row.total_cmp(&b.row));
    events
}

/// `{data, events, rows}` of `encodeSong`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EncodedSong {
    pub data: Vec<f64>,
    pub events: Vec<SongEvent>,
    pub rows: f64,
}

/// `encodeSong(air, song)`.
#[must_use]
pub fn encode_song(air: &Air, song: &Song) -> EncodedSong {
    let events = song_events(air, song);
    let rows = song_rows(song).min(255.0);
    // `x & 255` on a Number, kept as a Number like the JS array.
    let b = |v: f64| f64::from(to_int32(v) & 255);
    let mut data = vec![
        if song.looping { 1.0 } else { 0.0 },
        b(song.speed),
        rows,
        (events.len() & 255) as f64,
    ];
    for e in &events {
        let packed = wave_code(&e.waveform) | ((to_int32(e.volume) & 15) << 2);
        data.extend([
            b(e.row),
            b(e.note),
            f64::from(packed),
            b(e.length),
            b(e.decay),
        ]);
    }
    EncodedSong { data, events, rows }
}
