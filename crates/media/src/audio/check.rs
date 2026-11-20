//! Port of `media/audio/check.mjs:1-90`: required fields, unique names,
//! sample fallback, instruments a song names. Host decode happens later,
//! in the linker.

use super::parse::WAVEFORMS;
use super::{Air, Instrument, Song, Span};
use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use indexmap::{IndexMap, IndexSet};
use jsnum::number_to_string as n2s;

/// The pattern a name resolves to: a later pattern of the same name wins,
/// the first name keeps its place (a JS `Map` built from pairs).
fn pattern_map(song: &Song) -> IndexMap<&str, &super::Pattern> {
    let mut by_name = IndexMap::new();
    for p in &song.patterns {
        by_name.insert(p.name.as_str(), p);
    }
    by_name
}

/// The names of the patterns a song runs, in order.
pub(crate) fn order_names<'a>(
    song: &'a Song,
    by_name: &IndexMap<&'a str, &super::Pattern>,
) -> Vec<&'a str> {
    if song.order.is_empty() {
        by_name.keys().take(1).copied().collect()
    } else {
        song.order.iter().map(String::as_str).collect()
    }
}

/// `songRows(song)`: the rows a song runs, its order's patterns end to end
/// (or its first pattern when no order is given).
#[must_use]
pub fn song_rows(song: &Song) -> f64 {
    let by_name = pattern_map(song);
    order_names(song, &by_name).iter().fold(0.0, |sum, name| {
        sum + by_name.get(name).map_or(0.0, |p| p.length)
    })
}

/// `checkAudio(air, file)`.
#[must_use]
pub fn check_audio(air: &Air, file: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    let mut names: IndexSet<&str> = IndexSet::new();
    let mut instruments: IndexMap<&str, &Instrument> = IndexMap::new();
    let mut at = |code: &str, message: String, start: u32, length: u32| {
        out.push(diagnostic(
            code,
            message,
            file,
            start,
            length,
            Severity::Error,
        ));
    };
    // `start ?? node.start`, `length ?? node.length` with an optional span.
    let spanned = |span: Option<Span>, start: u32, length: u32| {
        span.map_or((start, length), |s| (s.start, s.length))
    };

    for inst in &air.instruments {
        if inst.name.is_empty() {
            continue;
        }
        if names.contains(inst.name.as_str()) {
            at(
                codes::AUD_DUPLICATE_NAME,
                format!("'{}' is already declared", inst.name),
                inst.start,
                inst.length,
            );
        }
        names.insert(&inst.name);
        instruments.insert(&inst.name, inst);
        if !WAVEFORMS.contains(&inst.waveform.as_str()) {
            at(
                codes::AUD_UNKNOWN_WAVEFORM,
                format!("unknown waveform '{}'", inst.waveform),
                inst.start,
                inst.length,
            );
        }
        if inst.polyphony != 1.0 {
            at(
                codes::AUD_SYNTAX,
                format!(
                    "this slice only accepts polyphony 1, not {}",
                    n2s(inst.polyphony)
                ),
                inst.start,
                inst.length,
            );
        }
        if inst.volume < 0.0 || inst.volume > 15.0 {
            let (s, l) = spanned(inst.volume_span, inst.start, inst.length);
            at(
                codes::AUD_SYNTAX,
                format!(
                    "instrument '{}': volume is 0..15, not {}",
                    inst.name,
                    n2s(inst.volume)
                ),
                s,
                l,
            );
        }
        if inst.decay < 0.0 || inst.decay > 255.0 {
            let (s, l) = spanned(inst.decay_span, inst.start, inst.length);
            at(
                codes::AUD_SYNTAX,
                format!(
                    "instrument '{}': decay is 0..255 frames, not {}",
                    inst.name,
                    n2s(inst.decay)
                ),
                s,
                l,
            );
        }
    }

    for sample in &air.samples {
        if sample.name.is_empty() {
            continue;
        }
        if names.contains(sample.name.as_str()) {
            at(
                codes::AUD_DUPLICATE_NAME,
                format!("'{}' is already declared", sample.name),
                sample.start,
                sample.length,
            );
        }
        names.insert(&sample.name);
        if sample.source.as_deref().is_none_or(str::is_empty) {
            at(
                codes::AUD_MISSING_FIELD,
                format!(
                    "sample '{}' needs a source \"...wav\" or \"...flac\"",
                    sample.name
                ),
                sample.start,
                sample.length,
            );
        }
        if sample.fallback.is_none() {
            at(
                codes::AUD_MISSING_FALLBACK,
                format!(
                    "sample '{}' needs fallback {{ synth <waveform> }}",
                    sample.name
                ),
                sample.fallback_start,
                sample.fallback_length,
            );
        }
    }

    for song in &air.songs {
        if song.name.is_empty() {
            continue;
        }
        if names.contains(song.name.as_str()) {
            at(
                codes::AUD_DUPLICATE_NAME,
                format!("'{}' is already declared", song.name),
                song.start,
                song.length,
            );
        }
        names.insert(&song.name);
        if song.tempo == 0.0 || song.tempo.is_nan() {
            at(
                codes::AUD_MISSING_FIELD,
                format!("song '{}' needs a tempo", song.name),
                song.start,
                song.length,
            );
        }
        if song.speed == 0.0 || song.speed.is_nan() {
            at(
                codes::AUD_MISSING_FIELD,
                format!("song '{}' needs a speed", song.name),
                song.start,
                song.length,
            );
        }
        for pattern in &song.patterns {
            // One voice: two tracks that both start a note on the same row
            // would need two voices. The map is keyed by the row number.
            let mut taken: Vec<(f64, &str)> = Vec::new();
            for track in &pattern.tracks {
                for row in &track.rows {
                    if let Some(name) = row.instrument.as_deref().filter(|n| !n.is_empty())
                        && !instruments.contains_key(name)
                    {
                        at(
                            codes::AUD_UNKNOWN_INSTRUMENT,
                            format!("cannot find instrument '{name}'"),
                            row.start,
                            row.length,
                        );
                    }
                    if row.note.is_some() {
                        if row.row < 0.0 || row.row >= pattern.length {
                            at(
                                codes::AUD_SYNTAX,
                                format!(
                                    "row {} is outside pattern '{}' (length {})",
                                    n2s(row.row),
                                    pattern.name,
                                    n2s(pattern.length)
                                ),
                                row.start,
                                row.length,
                            );
                        }
                        let slot = taken.iter().position(|(r, _)| *r == row.row);
                        if let Some(i) = slot
                            && taken[i].1 != track.name
                        {
                            at(
                                codes::AUD_SYNTAX,
                                format!(
                                    "track '{}' starts a note on row {}, which track '{}' already uses: a song has one voice",
                                    track.name,
                                    n2s(row.row),
                                    taken[i].1
                                ),
                                row.start,
                                row.length,
                            );
                        }
                        match slot {
                            Some(i) => taken[i].1 = &track.name,
                            None => taken.push((row.row, &track.name)),
                        }
                    }
                    if let Some(len) = row.note_length
                        && (len < 1.0 || len > 255.0)
                    {
                        let (s, l) = spanned(row.length_span, row.start, row.length);
                        at(
                            codes::AUD_SYNTAX,
                            format!("a note's length is 1..255 rows, not {}", n2s(len)),
                            s,
                            l,
                        );
                    }
                    if let Some(v) = row.volume
                        && (v < 0.0 || v > 15.0)
                    {
                        let (s, l) = spanned(row.volume_span, row.start, row.length);
                        at(
                            codes::AUD_SYNTAX,
                            format!("volume is 0..15, not {}", n2s(v)),
                            s,
                            l,
                        );
                    }
                }
            }
        }
        let rows_in_order = song_rows(song);
        if rows_in_order > 255.0 {
            at(
                codes::AUD_SYNTAX,
                format!(
                    "song '{}' has {} rows; a song holds up to 255",
                    song.name,
                    n2s(rows_in_order)
                ),
                song.start,
                song.length,
            );
        }
    }

    out
}
