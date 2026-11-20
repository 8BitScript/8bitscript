//! The atari8 media module (`packages/atari8/media/index.cjs`).

use crate::audio::song::EncodedSong;
use crate::audio::{Air, Song};
use crate::audio::{Instrument, Pattern};
use crate::graphics::Sprite;
use crate::machine::{AudioLowered, Facts, Frame, GraphicsLowered, MachineMedia, MediaSlots, Pcm};
use crate::machine::{LoweredAsset, LoweredEvent, VoiceEvent};
use diagnostics::{Severity, diagnostic};
use indexmap::IndexMap;
use jsnum::to_int32;

/// The atari8 media module.
#[derive(Debug, Clone, Copy, Default)]
pub struct Atari8;

const KIND_GLYPH: f64 = 0.0;

/// `glyphOf(rgba)`.
fn glyph_of(rgba: &[u8]) -> u8 {
    let mut ink = 0u32;
    let mut n = 0u32;
    let px = |k: usize| rgba.get(k).copied();
    let mut i = 0;
    while i < rgba.len() {
        // `rgba[i + 3] < 16` is false for a missing byte (undefined).
        if px(i + 3).is_some_and(|a| a < 16) {
            i += 4;
            continue;
        }
        n += 1;
        // A missing channel makes the sum NaN, and `NaN < 500` is false.
        if let (Some(r), Some(g), Some(b)) = (px(i), px(i + 1), px(i + 2))
            && u32::from(r) + u32::from(g) + u32::from(b) < 500
        {
            ink += 1;
        }
        i += 4;
    }
    if n == 0 {
        return 0x2A;
    }
    if f64::from(ink) / f64::from(n) > 0.45 {
        return 0xA0;
    }
    0x51
}

/// `WAVE[name] ?? dflt`.
fn wave_or(name: &str, dflt: f64) -> f64 {
    match name {
        "pulse" => 0.0,
        "noise" => 1.0,
        "triangle" => 2.0,
        "saw" => 3.0,
        _ => dflt,
    }
}

/// `songEvents(air, song)`: `(events, length)`.
fn song_events(air: &Air, song: &Song) -> (Vec<VoiceEvent>, f64) {
    let mut instruments: IndexMap<&str, &Instrument> = IndexMap::new();
    for i in &air.instruments {
        instruments.insert(i.name.as_str(), i);
    }
    let mut pattern_by_name: IndexMap<&str, &Pattern> = IndexMap::new();
    for p in &song.patterns {
        pattern_by_name.insert(p.name.as_str(), p);
    }
    let mut events = Vec::new();
    let mut last_inst: Option<&Instrument> = None;
    let names: Vec<&str> = if song.order.is_empty() {
        pattern_by_name.keys().copied().take(1).collect()
    } else {
        song.order.iter().map(String::as_str).collect()
    };
    for name in names {
        let Some(pattern) = pattern_by_name.get(name) else {
            continue;
        };
        for track in &pattern.tracks {
            for row in &track.rows {
                if let Some(inst) = row.instrument.as_deref().filter(|n| !n.is_empty()) {
                    last_inst = instruments.get(inst).copied().or(last_inst);
                }
                let Some(note) = row.note else { continue };
                events.push(VoiceEvent {
                    row: row.row,
                    note,
                    waveform: last_inst
                        .map_or("pulse", |i| i.waveform.as_str())
                        .to_string(),
                    voice: 0.0,
                });
            }
        }
    }
    let length = song.patterns.first().map_or(16.0, |p| p.length);
    (events, length)
}

/// `encodeSong(song, events, length)`; `x & 255` keeps a Number.
fn encode_song_bytes(song: &Song, events: &[VoiceEvent], length: f64) -> Vec<f64> {
    let b = |v: f64| f64::from(to_int32(v) & 255);
    let mut bytes = vec![
        b(song.tempo),
        b(song.speed),
        b(length),
        (events.len() & 255) as f64,
    ];
    for e in events {
        bytes.extend([b(e.row), b(e.note), wave_or(&e.waveform, 0.0), b(e.voice)]);
    }
    bytes
}

impl MachineMedia for Atari8 {
    fn lower_graphics(
        &self,
        sprite: &Sprite,
        frames: &[Frame],
        _facts: &Facts,
        file: &str,
        _slots: Option<&mut MediaSlots>,
    ) -> GraphicsLowered {
        let mut diagnostics = Vec::new();
        let frame = frames.first();
        let anim = sprite.animations.first();
        let collapsed = anim.map_or(1, |a| a.frames.len()) > 1;
        diagnostics.push(diagnostic(
            "8BS2111",
            format!(
                "sprite '{}' is a software glyph on atari8{}",
                sprite.name,
                if collapsed { "; frames collapsed" } else { "" }
            ),
            file,
            sprite.start,
            sprite.length,
            Severity::Warning,
        ));
        GraphicsLowered {
            kind: Some(KIND_GLYPH),
            data: Some(vec![f64::from(frame.map_or(0x2A, |f| glyph_of(&f.rgba)))]),
            frames: Some(1.0),
            every: Some(anim.map_or(8.0, |a| a.every)),
            width: Some(8.0),
            height: Some(8.0),
            chr_patches: Some(Vec::new()),
            diagnostics: Some(diagnostics),
        }
    }

    fn lower_audio(
        &self,
        air: &Air,
        _pcm_by_sample: &IndexMap<String, Pcm>,
        _facts: &Facts,
        file: &str,
        _encode_song: &dyn Fn(&Song) -> EncodedSong,
    ) -> AudioLowered {
        let mut diagnostics = Vec::new();
        let mut samples = Vec::new();
        let mut songs = Vec::new();
        for sample in &air.samples {
            let fallback = sample
                .fallback
                .as_ref()
                .map_or("noise", |f| f.synth.as_str());
            diagnostics.push(diagnostic(
                "8BS2210",
                format!(
                    "sample '{}' is not volume-only PCM in this slice; using fallback {{ synth {fallback} }}",
                    sample.name
                ),
                file,
                sample.start,
                sample.length,
                Severity::Warning,
            ));
            samples.push(LoweredAsset {
                name: sample.name.clone(),
                data: Some(vec![wave_or(fallback, 1.0), 60.0]),
                events: Some(Vec::new()),
            });
        }
        for song in &air.songs {
            let (events, length) = song_events(air, song);
            songs.push(LoweredAsset {
                name: song.name.clone(),
                data: Some(encode_song_bytes(song, &events, length)),
                events: Some(events.into_iter().map(LoweredEvent::Voice).collect()),
            });
        }
        AudioLowered {
            samples,
            songs,
            diagnostics: Some(diagnostics),
        }
    }
}
