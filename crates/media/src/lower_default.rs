//! Port of `media/lower-default.mjs:1-120`: the media lowering of every machine without a
//! `"8bitscript".media` module. Graphics become a software glyph (the path `@8bitscript/sprites`
//! already has). Audio with no driver emits no song bytes.
//!
//! Declared deviation: `waveIndex` looks the name up in a plain object, so a name such as
//! `constructor` finds an inherited property and puts a function in the byte list. A waveform
//! comes from an instrument the checker has validated, so the port answers `WAVE_PULSE` for any
//! name that is not one of the four.

use crate::audio::{Air, Song};
use crate::graphics::Sprite;
use crate::machine::{AudioLowered, Frame, GraphicsLowered, LoweredAsset, Pcm, VoiceEvent};
use diagnostics::{Severity, codes, diagnostic};
use indexmap::IndexMap;
use jsnum::to_int32;
use media_tools::png::brightness;

pub use media_tools::png::{bitmask, quantize};

pub const KIND_GLYPH: u8 = 0;
pub const KIND_C64: u8 = 1;
pub const KIND_NES: u8 = 2;
pub const KIND_PET: u8 = 3;

pub const WAVE_PULSE: u8 = 0;
pub const WAVE_NOISE: u8 = 1;
pub const WAVE_TRIANGLE: u8 = 2;
pub const WAVE_SAW: u8 = 3;

/// `packages/graphics/src/index.8bs` holds this many animation steps a picture.
pub const DEFAULT_MAX_STEPS: usize = 4;

/// `waveIndex(name)`.
#[must_use]
pub fn wave_index(name: &str) -> u8 {
    match name {
        "pulse" => WAVE_PULSE,
        "noise" => WAVE_NOISE,
        "triangle" => WAVE_TRIANGLE,
        "saw" => WAVE_SAW,
        _ => WAVE_PULSE,
    }
}

/// `glyphOf(frame)`: one PETSCII-ish glyph from a frame: a filled cell if mostly ink, else a ball.
#[must_use]
pub fn glyph_of(frame: &Frame) -> u8 {
    let indices = quantize(&frame.rgba, 2).indices;
    let ink = indices.iter().filter(|&&v| v != 255).count();
    let total = if indices.is_empty() { 1 } else { indices.len() };
    if ink as f64 / total as f64 > 0.45 {
        return 0xA0; // reverse space
    }
    if brightness(&frame.rgba) > 40 {
        return 0x51; // ball
    }
    0x2A // asterisk, the sprites default
}

/// `frames[index] ?? frames[0]`: an index that is not an array index reads `undefined`.
fn frame_at(frames: &[Frame], index: f64) -> Option<&Frame> {
    let exact = index.fract() == 0.0 && index >= 0.0 && index < frames.len() as f64;
    if exact {
        frames.get(index as usize)
    } else {
        frames.first()
    }
}

/// `lowerGraphicsDefault(sprite, frames, file)`.
#[must_use]
pub fn lower_graphics_default(sprite: &Sprite, frames: &[Frame], file: &str) -> GraphicsLowered {
    let anim = sprite.animations.first();
    let sequence: Vec<f64> = match anim {
        Some(a) if !a.frames.is_empty() => a.frames.clone(),
        _ => vec![0.0],
    };
    let kept: Vec<f64> = sequence.iter().take(DEFAULT_MAX_STEPS).copied().collect();
    let data: Vec<f64> = kept
        .iter()
        .map(|&index| {
            frame_at(frames, index).map_or(f64::from(0x2A_u8), |f| f64::from(glyph_of(f)))
        })
        .collect();
    let mut notes: Vec<String> = Vec::new();
    if kept.len() > 1 {
        notes.push(format!("{} animation steps kept", kept.len()));
    }
    if sequence.len() > DEFAULT_MAX_STEPS {
        notes.push(format!("steps past {DEFAULT_MAX_STEPS} dropped"));
    }
    let suffix = if notes.is_empty() {
        String::new()
    } else {
        format!("; {}", notes.join("; "))
    };
    let diagnostics = vec![diagnostic(
        codes::GFX_ADAPTED,
        format!(
            "sprite '{}' is a software glyph on this target{suffix}",
            sprite.name
        ),
        file,
        sprite.start,
        sprite.length,
        Severity::Warning,
    )];
    GraphicsLowered {
        kind: Some(f64::from(KIND_GLYPH)),
        data: Some(data),
        frames: Some(kept.len() as f64),
        every: Some(anim.map_or(8.0, |a| a.every)),
        width: Some(8.0),
        height: Some(8.0),
        chr_patches: Some(Vec::new()),
        diagnostics: Some(diagnostics),
    }
}

/// What `songEvents` returns: `{events, length}`.
#[derive(Debug, Clone, PartialEq)]
pub struct SongEvents {
    pub events: Vec<VoiceEvent>,
    pub length: f64,
}

/// `songEvents(air, song)`.
#[must_use]
pub fn song_events(air: &Air, song: &Song) -> SongEvents {
    let instruments: IndexMap<&str, &crate::audio::Instrument> = air
        .instruments
        .iter()
        .map(|i| (i.name.as_str(), i))
        .collect();
    let pattern_by_name: IndexMap<&str, &crate::audio::Pattern> =
        song.patterns.iter().map(|p| (p.name.as_str(), p)).collect();
    let mut events = Vec::new();
    let mut last_inst: Option<&crate::audio::Instrument> = None;
    let order: Vec<&str> = if song.order.is_empty() {
        pattern_by_name.keys().take(1).copied().collect()
    } else {
        song.order.iter().map(String::as_str).collect()
    };
    for name in order {
        let Some(pattern) = pattern_by_name.get(name) else {
            continue;
        };
        for track in &pattern.tracks {
            for row in &track.rows {
                if let Some(name) = row.instrument.as_deref().filter(|n| !n.is_empty()) {
                    last_inst = instruments.get(name).copied().or(last_inst);
                }
                let Some(note) = row.note else {
                    continue;
                };
                events.push(VoiceEvent {
                    row: row.row,
                    note,
                    waveform: last_inst.map_or_else(|| "pulse".to_string(), |i| i.waveform.clone()),
                    voice: 0.0,
                });
            }
        }
    }
    let length = song.patterns.first().map_or(16.0, |p| p.length);
    SongEvents { events, length }
}

/// `encodeSong(song, events, length)`.
#[must_use]
pub fn encode_song(song: &Song, events: &[VoiceEvent], length: f64) -> Vec<f64> {
    let b = |v: f64| f64::from(to_int32(v) & 255);
    let mut bytes = vec![
        b(song.tempo),
        b(song.speed),
        b(length),
        (events.len() & 255) as f64,
    ];
    for e in events {
        bytes.extend([
            b(e.row),
            b(e.note),
            f64::from(wave_index(&e.waveform)),
            b(e.voice),
        ]);
    }
    bytes
}

/// `lowerAudioDefault(air, pcmBySample, file, { machine })`: no `"8bitscript".media` module means
/// no on-machine driver. Silence is the declared fallback: no song bytes, a diagnostic that names
/// the target.
#[must_use]
pub fn lower_audio_default(
    air: &Air,
    _pcm_by_sample: &IndexMap<String, Pcm>,
    file: &str,
    machine: &str,
) -> AudioLowered {
    let mut diagnostics = Vec::new();
    let mut at = |start: u32, length: u32| {
        diagnostics.push(diagnostic(
            codes::AUD_NO_DRIVER,
            format!("target '{machine}' has no audio driver yet; playback omitted"),
            file,
            start,
            length,
            Severity::Warning,
        ));
    };
    let mut samples = Vec::new();
    let mut songs = Vec::new();
    for sample in &air.samples {
        at(sample.start, sample.length);
        samples.push(LoweredAsset {
            name: sample.name.clone(),
            data: Some(Vec::new()),
            events: Some(Vec::new()),
        });
    }
    for song in &air.songs {
        at(song.start, song.length);
        songs.push(LoweredAsset {
            name: song.name.clone(),
            data: Some(Vec::new()),
            events: Some(Vec::new()),
        });
    }
    AudioLowered {
        samples,
        songs,
        diagnostics: Some(diagnostics),
    }
}
