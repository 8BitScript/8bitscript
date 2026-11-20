//! The audio front end: `parse`, `check` and `song`, plus AIR.

pub mod check;
pub mod parse;
pub mod song;

use diagnostics::Diagnostic;
use serde::Serialize;

/// `{start, length}` of `volumeSpan`, `decaySpan` and `lengthSpan`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Span {
    pub start: u32,
    pub length: u32,
}

/// An AIR instrument, fields in the JS insertion order. The two spans are
/// set only when the file gave `volume` / `decay`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub name: String,
    pub waveform: String,
    pub polyphony: f64,
    pub volume: f64,
    pub decay: f64,
    pub start: u32,
    pub length: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_span: Option<Span>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decay_span: Option<Span>,
}

/// `sample.fallback`: `{synth}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Fallback {
    pub synth: String,
}

/// An AIR sample.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub name: String,
    pub source: Option<String>,
    pub fallback: Option<Fallback>,
    pub start: u32,
    pub length: u32,
    pub source_start: u32,
    pub source_length: u32,
    pub fallback_start: u32,
    pub fallback_length: u32,
}

/// `kind: 'row'` of a track's row entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RowKind {
    Row,
}

/// A track row: `{kind: 'row', ...parseRow}`. The parser leaves `diagnostics`
/// on the entry, so they are part of AIR.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub kind: RowKind,
    pub row: f64,
    pub note: Option<f64>,
    pub instrument: Option<String>,
    pub note_length: Option<f64>,
    pub volume: Option<f64>,
    pub start: u32,
    pub length: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_span: Option<Span>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_span: Option<Span>,
    pub diagnostics: Vec<Diagnostic>,
}

/// `kind: 'track'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Track,
}

/// A pattern's track: `{kind: 'track', ...parseTrack}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Track {
    pub kind: TrackKind,
    pub name: String,
    pub rows: Vec<Row>,
    pub start: u32,
    pub length: u32,
    pub diagnostics: Vec<Diagnostic>,
}

/// `kind: 'pattern'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PatternKind {
    Pattern,
}

/// A song's pattern: `{kind: 'pattern', ...parsePattern}`. `length` is the
/// row count (a number); `length_span` is the name token's length.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pattern {
    pub kind: PatternKind,
    pub name: String,
    pub length: f64,
    pub tracks: Vec<Track>,
    pub start: u32,
    pub length_span: u32,
    pub diagnostics: Vec<Diagnostic>,
}

/// An AIR song (`diagnostics` is deleted by `parseAudio` and returned beside it).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Song {
    pub name: String,
    pub tempo: f64,
    pub speed: f64,
    #[serde(rename = "loop")]
    pub looping: bool,
    pub order: Vec<String>,
    pub patterns: Vec<Pattern>,
    pub start: u32,
    pub length: u32,
}

/// `{instruments, samples, songs, parts: [], voiceGroups: []}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Air {
    pub instruments: Vec<Instrument>,
    pub samples: Vec<Sample>,
    pub songs: Vec<Song>,
    pub parts: Vec<()>,
    pub voice_groups: Vec<()>,
}
