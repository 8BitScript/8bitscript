//! Port of `media/audio/parse.mjs:1-374`: the `.8ba` parser. It never fails;
//! it produces AIR.

use super::{
    Air, Fallback, Instrument, Pattern, PatternKind, Row, RowKind, Sample, Song, Span, Track,
    TrackKind,
};
use crate::cursor::{
    BlockItem, Cursor, cursor, parse_block, parse_name, parse_number, parse_string,
};
use crate::lexer::{MediaToken, MediaTokenKind};
use diagnostics::{Diagnostic, codes};

/// `WAVEFORMS`.
pub const WAVEFORMS: [&str; 4] = ["pulse", "triangle", "saw", "noise"];

const NOTE_NAMES: [&str; 12] = [
    "C", "CS", "D", "DS", "E", "F", "FS", "G", "GS", "A", "AS", "B",
];

/// `NOTES.get(name)`: `C0`..`B6` to `octave * 12 + semitone`.
#[must_use]
pub fn note_value(name: &str) -> Option<f64> {
    for oct in 0..=6u32 {
        for (s, n) in NOTE_NAMES.iter().enumerate() {
            if name.len() == n.len() + 1
                && name.starts_with(n)
                && name.ends_with(char::from_digit(oct, 10).unwrap_or('0'))
            {
                return Some(f64::from(oct * 12 + s as u32));
            }
        }
    }
    None
}

struct Waveform {
    value: String,
    diagnostics: Vec<Diagnostic>,
}

fn parse_waveform(c: &mut Cursor) -> Waveform {
    let Some(tok) = c.eat(Some(MediaTokenKind::Identifier), None) else {
        return Waveform {
            value: "pulse".into(),
            diagnostics: vec![c.report(c.syntax, "expected a waveform", c.at(0))],
        };
    };
    if !WAVEFORMS.contains(&tok.text.as_str()) {
        return Waveform {
            value: "pulse".into(),
            diagnostics: vec![c.report(
                codes::AUD_UNKNOWN_WAVEFORM,
                format!("unknown waveform '{}'", tok.text),
                Some(tok),
            )],
        };
    }
    Waveform {
        value: tok.text.clone(),
        diagnostics: Vec::new(),
    }
}

/// The body item shape every block here shares: a skipped field, or a
/// value with its diagnostics.
macro_rules! block_item {
    ($name:ident { $($variant:ident $({ $($field:ident : $ty:ty),* })?),* $(,)? }) => {
        enum $name {
            $($variant { $($($field: $ty,)*)? diagnostics: Vec<Diagnostic> },)*
            Skip { diagnostics: Vec<Diagnostic> },
        }
        impl BlockItem for $name {
            fn diagnostics(&self) -> &[Diagnostic] {
                match self {
                    $($name::$variant { diagnostics, .. } )|* | $name::Skip { diagnostics } => diagnostics,
                }
            }
            fn is_skip(&self) -> bool {
                matches!(self, $name::Skip { .. })
            }
        }
    };
}

fn expected_field(inner: &mut Cursor) -> Vec<Diagnostic> {
    inner.skip_to(&["}"]);
    vec![inner.report(inner.syntax, "expected a field", inner.at(0))]
}

fn unknown_field(inner: &Cursor, field: &MediaToken) -> Vec<Diagnostic> {
    vec![inner.report(
        inner.unknown,
        format!("unknown field '{}'", field.text),
        Some(field),
    )]
}

block_item!(InstItem {
    Waveform { value: String },
    Polyphony { value: f64 },
    Volume { value: f64, start: u32, length: u32 },
    Decay { value: f64, start: u32, length: u32 },
});

fn parse_instrument(c: &mut Cursor, keyword: &MediaToken) -> (Instrument, Vec<Diagnostic>) {
    let name = parse_name(c);
    let mut diagnostics = name.diagnostics.clone();
    let mut inst = Instrument {
        name: name.name.clone(),
        waveform: "pulse".into(),
        polyphony: 1.0,
        volume: 15.0,
        decay: 0.0,
        start: keyword.start,
        length: name.length,
        volume_span: None,
        decay_span: None,
    };
    let block = parse_block(c, |inner| {
        let Some(field) = inner.eat(Some(MediaTokenKind::Identifier), None) else {
            return InstItem::Skip {
                diagnostics: expected_field(inner),
            };
        };
        if field.text == "waveform" {
            let w = parse_waveform(inner);
            return InstItem::Waveform {
                value: w.value,
                diagnostics: w.diagnostics,
            };
        }
        if field.text == "polyphony" {
            let n = parse_number(inner, "polyphony");
            return InstItem::Polyphony {
                value: n.value,
                diagnostics: n.diagnostics,
            };
        }
        // `volume` and `decay`: optional, each ends with an optional ';'.
        if field.text == "volume" || field.text == "decay" {
            let n = parse_number(inner, &field.text);
            inner.eat(Some(MediaTokenKind::Punctuation), Some(";"));
            return if field.text == "volume" {
                InstItem::Volume {
                    value: n.value,
                    start: n.start,
                    length: n.length,
                    diagnostics: n.diagnostics,
                }
            } else {
                InstItem::Decay {
                    value: n.value,
                    start: n.start,
                    length: n.length,
                    diagnostics: n.diagnostics,
                }
            };
        }
        InstItem::Skip {
            diagnostics: unknown_field(inner, field),
        }
    });
    diagnostics.extend(block.diagnostics);
    for item in block.body {
        match item {
            InstItem::Waveform { value, .. } => inst.waveform = value,
            InstItem::Polyphony { value, .. } => inst.polyphony = value,
            InstItem::Volume {
                value,
                start,
                length,
                ..
            } => {
                inst.volume = value;
                inst.volume_span = Some(Span { start, length });
            }
            InstItem::Decay {
                value,
                start,
                length,
                ..
            } => {
                inst.decay = value;
                inst.decay_span = Some(Span { start, length });
            }
            InstItem::Skip { .. } => {}
        }
    }
    (inst, diagnostics)
}

struct FallbackParsed {
    synth: String,
    diagnostics: Vec<Diagnostic>,
}

fn parse_fallback(c: &mut Cursor) -> FallbackParsed {
    let mut diagnostics = Vec::new();
    let open = c.expect(Some(MediaTokenKind::Punctuation), Some("{"), "'{'");
    diagnostics.extend(open.diagnostics);
    let mut synth = "noise".to_string();
    if c.at(0)
        .is_some_and(|t| t.kind == MediaTokenKind::Identifier && t.text == "synth")
    {
        c.eat(Some(MediaTokenKind::Identifier), None);
        let w = parse_waveform(c);
        diagnostics.extend(w.diagnostics);
        synth = w.value;
    } else if c.at(0).is_some_and(|t| t.text != "}") {
        diagnostics.push(c.report(c.syntax, "expected 'synth <waveform>'", c.at(0)));
    }
    let close = c.expect(Some(MediaTokenKind::Punctuation), Some("}"), "'}'");
    diagnostics.extend(close.diagnostics);
    FallbackParsed { synth, diagnostics }
}

block_item!(SampleItem {
    Source { value: String, start: u32, length: u32 },
    Fallback { synth: String, start: u32, length: u32 },
});

fn parse_sample(c: &mut Cursor, keyword: &MediaToken) -> (Sample, Vec<Diagnostic>) {
    let name = parse_name(c);
    let mut diagnostics = name.diagnostics.clone();
    let mut sample = Sample {
        name: name.name.clone(),
        source: None,
        fallback: None,
        start: keyword.start,
        length: name.length,
        source_start: keyword.start,
        source_length: keyword.length,
        fallback_start: keyword.start,
        fallback_length: keyword.length,
    };
    let block = parse_block(c, |inner| {
        let Some(field) = inner.eat(Some(MediaTokenKind::Identifier), None) else {
            return SampleItem::Skip {
                diagnostics: expected_field(inner),
            };
        };
        if field.text == "source" {
            let s = parse_string(inner, "a source path");
            return SampleItem::Source {
                value: s.value,
                start: s.start,
                length: s.length,
                diagnostics: s.diagnostics,
            };
        }
        if field.text == "fallback" {
            let f = parse_fallback(inner);
            return SampleItem::Fallback {
                synth: f.synth,
                start: field.start,
                length: field.length,
                diagnostics: f.diagnostics,
            };
        }
        SampleItem::Skip {
            diagnostics: unknown_field(inner, field),
        }
    });
    diagnostics.extend(block.diagnostics);
    for item in block.body {
        match item {
            SampleItem::Source {
                value,
                start,
                length,
                ..
            } => {
                sample.source = Some(value);
                sample.source_start = start;
                sample.source_length = length;
            }
            SampleItem::Fallback {
                synth,
                start,
                length,
                ..
            } => {
                sample.fallback = Some(Fallback { synth });
                sample.fallback_start = start;
                sample.fallback_length = length;
            }
            SampleItem::Skip { .. } => {}
        }
    }
    (sample, diagnostics)
}

fn parse_note(c: &mut Cursor) -> (f64, Vec<Diagnostic>) {
    let Some(tok) = c.eat(Some(MediaTokenKind::Identifier), None) else {
        return (
            0.0,
            vec![c.report(c.syntax, "expected a note (C4, G4, \u{2026})", c.at(0))],
        );
    };
    // The note names are ASCII, so an ASCII upper-case is `toUpperCase()`.
    match note_value(&tok.text.to_ascii_uppercase()) {
        Some(value) => (value, Vec::new()),
        None => (
            0.0,
            vec![c.report(
                codes::AUD_UNKNOWN_NOTE,
                format!("unknown note '{}'", tok.text),
                Some(tok),
            )],
        ),
    }
}

block_item!(RowItem {
    Note { value: f64 },
    Instrument { value: String },
    Length { value: f64, start: u32, length: u32 },
    Volume { value: f64, start: u32, length: u32 },
});

fn parse_row(c: &mut Cursor) -> Row {
    let n = parse_number(c, "a row number");
    let mut diagnostics = n.diagnostics.clone();
    let mut row = Row {
        kind: RowKind::Row,
        row: n.value,
        note: None,
        instrument: None,
        note_length: None,
        volume: None,
        start: n.start,
        length: n.length,
        length_span: None,
        volume_span: None,
        diagnostics: Vec::new(),
    };
    let block = parse_block(c, |inner| {
        let Some(field) = inner.eat(Some(MediaTokenKind::Identifier), None) else {
            return RowItem::Skip {
                diagnostics: expected_field(inner),
            };
        };
        if field.text == "note" {
            let (value, diagnostics) = parse_note(inner);
            inner.eat(Some(MediaTokenKind::Punctuation), Some(";"));
            return RowItem::Note { value, diagnostics };
        }
        if field.text == "instrument" {
            let name = parse_name(inner);
            inner.eat(Some(MediaTokenKind::Punctuation), Some(";"));
            return RowItem::Instrument {
                value: name.name,
                diagnostics: name.diagnostics,
            };
        }
        // `length N`: the note sounds for N rows; `volume N`: 0..15.
        if field.text == "length" || field.text == "volume" {
            let n = parse_number(inner, &field.text);
            inner.eat(Some(MediaTokenKind::Punctuation), Some(";"));
            return if field.text == "length" {
                RowItem::Length {
                    value: n.value,
                    start: n.start,
                    length: n.length,
                    diagnostics: n.diagnostics,
                }
            } else {
                RowItem::Volume {
                    value: n.value,
                    start: n.start,
                    length: n.length,
                    diagnostics: n.diagnostics,
                }
            };
        }
        RowItem::Skip {
            diagnostics: unknown_field(inner, field),
        }
    });
    diagnostics.extend(block.diagnostics);
    for item in block.body {
        match item {
            RowItem::Note { value, .. } => row.note = Some(value),
            RowItem::Instrument { value, .. } => row.instrument = Some(value),
            RowItem::Length {
                value,
                start,
                length,
                ..
            } => {
                row.note_length = Some(value);
                row.length_span = Some(Span { start, length });
            }
            RowItem::Volume {
                value,
                start,
                length,
                ..
            } => {
                row.volume = Some(value);
                row.volume_span = Some(Span { start, length });
            }
            RowItem::Skip { .. } => {}
        }
    }
    row.diagnostics = diagnostics;
    row
}

enum TrackItem {
    Row(Row),
    Skip { diagnostics: Vec<Diagnostic> },
}

impl BlockItem for TrackItem {
    fn diagnostics(&self) -> &[Diagnostic] {
        match self {
            TrackItem::Row(r) => &r.diagnostics,
            TrackItem::Skip { diagnostics } => diagnostics,
        }
    }
    fn is_skip(&self) -> bool {
        matches!(self, TrackItem::Skip { .. })
    }
}

fn parse_track(c: &mut Cursor) -> Track {
    let name = parse_name(c);
    let mut diagnostics = name.diagnostics.clone();
    let mut rows = Vec::new();
    let block = parse_block(c, |inner| {
        let Some(field) = inner.eat(Some(MediaTokenKind::Identifier), None) else {
            return TrackItem::Skip {
                diagnostics: expected_field(inner),
            };
        };
        if field.text == "row" {
            return TrackItem::Row(parse_row(inner));
        }
        TrackItem::Skip {
            diagnostics: unknown_field(inner, field),
        }
    });
    diagnostics.extend(block.diagnostics);
    for item in block.body {
        if let TrackItem::Row(row) = item {
            // The JS adds a row's diagnostics here again after parseBlock did.
            diagnostics.extend(row.diagnostics.iter().cloned());
            rows.push(row);
        }
    }
    Track {
        kind: TrackKind::Track,
        name: name.name,
        rows,
        start: name.start,
        length: name.length,
        diagnostics,
    }
}

enum PatternItem {
    Track(Track),
    Skip { diagnostics: Vec<Diagnostic> },
}

impl BlockItem for PatternItem {
    fn diagnostics(&self) -> &[Diagnostic] {
        match self {
            PatternItem::Track(t) => &t.diagnostics,
            PatternItem::Skip { diagnostics } => diagnostics,
        }
    }
    fn is_skip(&self) -> bool {
        matches!(self, PatternItem::Skip { .. })
    }
}

fn parse_pattern(c: &mut Cursor) -> Pattern {
    let name = parse_name(c);
    let mut diagnostics = name.diagnostics.clone();
    let mut length = 16.0;
    if c.at(0)
        .is_some_and(|t| t.kind == MediaTokenKind::Identifier && t.text == "length")
    {
        c.eat(Some(MediaTokenKind::Identifier), None);
        let n = parse_number(c, "pattern length");
        diagnostics.extend(n.diagnostics);
        length = n.value;
    }
    let mut tracks = Vec::new();
    let block = parse_block(c, |inner| {
        let Some(field) = inner.eat(Some(MediaTokenKind::Identifier), None) else {
            return PatternItem::Skip {
                diagnostics: expected_field(inner),
            };
        };
        if field.text == "track" {
            return PatternItem::Track(parse_track(inner));
        }
        PatternItem::Skip {
            diagnostics: unknown_field(inner, field),
        }
    });
    diagnostics.extend(block.diagnostics);
    for item in block.body {
        if let PatternItem::Track(track) = item {
            diagnostics.extend(track.diagnostics.iter().cloned());
            tracks.push(track);
        }
    }
    Pattern {
        kind: PatternKind::Pattern,
        name: name.name,
        length,
        tracks,
        start: name.start,
        length_span: name.length,
        diagnostics,
    }
}

struct Order {
    names: Vec<String>,
    diagnostics: Vec<Diagnostic>,
}

fn parse_order(c: &mut Cursor) -> Order {
    let mut diagnostics = Vec::new();
    let mut names = Vec::new();
    let open = c.expect(Some(MediaTokenKind::Punctuation), Some("{"), "'{'");
    diagnostics.extend(open.diagnostics);
    while c.at(0).is_some_and(|t| t.text != "}") {
        let before = c.pos;
        let n = parse_name(c);
        diagnostics.extend(n.diagnostics);
        if !n.name.is_empty() {
            names.push(n.name);
        }
        c.eat(Some(MediaTokenKind::Punctuation), Some(","));
        // Stop at the first token that is not a name (`order { 5 }`), as the JS does.
        if c.pos == before {
            break;
        }
    }
    let close = c.expect(Some(MediaTokenKind::Punctuation), Some("}"), "'}'");
    diagnostics.extend(close.diagnostics);
    Order { names, diagnostics }
}

block_item!(SongItem {
    Tempo { value: f64 },
    Speed { value: f64 },
    Loop { value: bool },
    Order { names: Vec<String> },
});

enum SongBody {
    Plain(SongItem),
    Pattern(Pattern),
}

impl BlockItem for SongBody {
    fn diagnostics(&self) -> &[Diagnostic] {
        match self {
            SongBody::Plain(i) => i.diagnostics(),
            SongBody::Pattern(p) => &p.diagnostics,
        }
    }
    fn is_skip(&self) -> bool {
        matches!(self, SongBody::Plain(i) if i.is_skip())
    }
}

fn parse_song(c: &mut Cursor, keyword: &MediaToken) -> (Song, Vec<Diagnostic>) {
    let name = parse_name(c);
    let mut diagnostics = name.diagnostics.clone();
    let mut song = Song {
        name: name.name.clone(),
        tempo: 120.0,
        speed: 6.0,
        looping: true,
        order: Vec::new(),
        patterns: Vec::new(),
        start: keyword.start,
        length: name.length,
    };
    let block = parse_block(c, |inner| {
        let Some(field) = inner.eat(Some(MediaTokenKind::Identifier), None) else {
            return SongBody::Plain(SongItem::Skip {
                diagnostics: expected_field(inner),
            });
        };
        let plain = match field.text.as_str() {
            "tempo" => {
                let n = parse_number(inner, "tempo");
                SongItem::Tempo {
                    value: n.value,
                    diagnostics: n.diagnostics,
                }
            }
            "speed" => {
                let n = parse_number(inner, "speed");
                SongItem::Speed {
                    value: n.value,
                    diagnostics: n.diagnostics,
                }
            }
            // `loop true` (music, the default) or `loop false` (plays once).
            "loop" => {
                let word = inner.eat(Some(MediaTokenKind::Identifier), None);
                inner.eat(Some(MediaTokenKind::Punctuation), Some(";"));
                match word {
                    Some(w) if w.text == "true" || w.text == "false" => SongItem::Loop {
                        value: w.text == "true",
                        diagnostics: Vec::new(),
                    },
                    _ => {
                        let at = word.or_else(|| inner.at(0));
                        SongItem::Skip {
                            diagnostics: vec![inner.report(
                                inner.syntax,
                                "expected 'true' or 'false' after loop",
                                at,
                            )],
                        }
                    }
                }
            }
            "order" => {
                let o = parse_order(inner);
                SongItem::Order {
                    names: o.names,
                    diagnostics: o.diagnostics,
                }
            }
            "pattern" => return SongBody::Pattern(parse_pattern(inner)),
            _ => SongItem::Skip {
                diagnostics: unknown_field(inner, field),
            },
        };
        SongBody::Plain(plain)
    });
    diagnostics.extend(block.diagnostics);
    for item in block.body {
        match item {
            SongBody::Plain(SongItem::Tempo { value, .. }) => song.tempo = value,
            SongBody::Plain(SongItem::Speed { value, .. }) => song.speed = value,
            SongBody::Plain(SongItem::Loop { value, .. }) => song.looping = value,
            SongBody::Plain(SongItem::Order { names, .. }) => song.order = names,
            SongBody::Plain(SongItem::Skip { .. }) => {}
            SongBody::Pattern(p) => {
                diagnostics.extend(p.diagnostics.iter().cloned());
                song.patterns.push(p);
            }
        }
    }
    (song, diagnostics)
}

/// `parseAudio(tokens, text, file)`: `(air, diagnostics)`.
#[must_use]
pub fn parse_audio(tokens: &[MediaToken], text: &str, file: &str) -> (Air, Vec<Diagnostic>) {
    let mut c = cursor(tokens, text, file, ".8ba");
    let mut diagnostics = Vec::new();
    let mut instruments = Vec::new();
    let mut samples = Vec::new();
    let mut songs = Vec::new();
    while !c.done() {
        let Some(kw) = c.eat(Some(MediaTokenKind::Identifier), None) else {
            diagnostics.push(c.report(c.syntax, "expected a declaration", c.at(0)));
            break;
        };
        match kw.text.as_str() {
            "instrument" => {
                let (inst, d) = parse_instrument(&mut c, kw);
                diagnostics.extend(d);
                instruments.push(inst);
            }
            "sample" => {
                let (sample, d) = parse_sample(&mut c, kw);
                diagnostics.extend(d);
                samples.push(sample);
            }
            "song" => {
                let (song, d) = parse_song(&mut c, kw);
                diagnostics.extend(d);
                songs.push(song);
            }
            "target" => {
                diagnostics.push(c.report(
                    c.unknown,
                    format!(
                        "unknown target block '{}': target blocks are not in this slice",
                        kw.text
                    ),
                    Some(kw),
                ));
                c.skip_to(&["instrument", "sample", "song", "target"]);
            }
            _ => {
                diagnostics.push(c.report(
                    c.unknown,
                    format!(
                        "'{}' is not an audio declaration in this slice (instrument, sample, song)",
                        kw.text
                    ),
                    Some(kw),
                ));
                c.skip_to(&["instrument", "sample", "song"]);
            }
        }
    }
    (
        Air {
            instruments,
            samples,
            songs,
            parts: Vec::new(),
            voice_groups: Vec::new(),
        },
        diagnostics,
    )
}
