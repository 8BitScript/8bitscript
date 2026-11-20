//! The nes media module (`packages/nes/media/index.cjs`).

use crate::audio::song::EncodedSong;
use crate::audio::{Air, Song};
use crate::audio::{Instrument, Pattern};
use crate::graphics::Sprite;
use crate::machine::ChrPatch;
use crate::machine::{AudioLowered, Facts, Frame, GraphicsLowered, MachineMedia, MediaSlots, Pcm};
use crate::machine::{LoweredAsset, LoweredEvent, VoiceEvent};
use diagnostics::{Severity, diagnostic};
use indexmap::IndexMap;
use jsnum::to_int32;

/// The nes media module.
#[derive(Debug, Clone, Copy, Default)]
pub struct Nes;

const KIND_NES: f64 = 2.0;
const FIRST_TILE: f64 = 224.0;

/// `frames[index] ?? frames[0]`: an index that is not an array index of
/// `frames` reads `undefined`.
fn frame_at(frames: &[Frame], index: f64) -> Option<&Frame> {
    let by_index = if index >= 0.0 && index.fract() == 0.0 && index < frames.len() as f64 {
        frames.get(index as usize)
    } else {
        None
    };
    by_index.or_else(|| frames.first())
}

/// `packTile(indices, width, sx, sy)`. `indices[...]` past the array reads
/// `undefined`, which is neither 255 nor has a bit set, so it is skipped.
fn pack_tile(indices: &[u8], width: u32, sx: u32, sy: u32) -> Vec<u8> {
    let mut lo = [0u8; 8];
    let mut hi = [0u8; 8];
    for y in 0..8u32 {
        for x in 0..8u32 {
            let ix = sx + x;
            let iy = sy + y;
            if ix >= width {
                continue;
            }
            let Some(&v) = indices.get((iy * width + ix) as usize) else {
                continue;
            };
            if v == 255 {
                continue;
            }
            let bit = 0x80u8 >> x;
            if v & 1 != 0 {
                lo[y as usize] |= bit;
            }
            if v & 2 != 0 {
                hi[y as usize] |= bit;
            }
        }
    }
    lo.iter().chain(hi.iter()).copied().collect()
}

/// `quantize2bit(rgba, width, height)`: `(indices, colors)`.
fn quantize_2bit(rgba: &[u8], width: u32, height: u32) -> (Vec<u8>, usize) {
    let count = (width * height) as usize;
    let mut indices = vec![0u8; count];
    let mut seen: IndexMap<(u8, u8, u8), u8> = IndexMap::new();
    let px = |k: usize| rgba.get(k).copied();
    for (i, slot) in indices.iter_mut().enumerate() {
        let o = i * 4;
        if px(o + 3).is_some_and(|a| a < 16) {
            *slot = 255;
            continue;
        }
        // A missing channel is `undefined >> 5`, which is 0.
        let key = (
            px(o).unwrap_or(0) >> 5,
            px(o + 1).unwrap_or(0) >> 5,
            px(o + 2).unwrap_or(0) >> 5,
        );
        let next = seen.len().min(3) as u8;
        *slot = *seen.entry(key).or_insert(next);
    }
    (indices, seen.len())
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

impl MachineMedia for Nes {
    fn lower_graphics(
        &self,
        sprite: &Sprite,
        frames: &[Frame],
        _facts: &Facts,
        file: &str,
        _slots: Option<&mut MediaSlots>,
    ) -> GraphicsLowered {
        let mut diagnostics = Vec::new();
        let anim = sprite.animations.first();
        let frame_indexes: Vec<f64> = match anim {
            Some(a) if !a.frames.is_empty() => a.frames.clone(),
            _ => vec![0.0],
        };
        let mut data: Vec<f64> = Vec::new();
        let mut chr_patches: Vec<ChrPatch> = Vec::new();
        let mut tile = FIRST_TILE;
        let tw = if sprite.width >= 16.0 { 16.0 } else { 8.0 };
        let th = if sprite.height >= 16.0 { 16.0 } else { 8.0 };
        for &index in &frame_indexes {
            let Some(frame) = frame_at(frames, index) else {
                continue;
            };
            let (indices, colors) = quantize_2bit(&frame.rgba, frame.width, frame.height);
            if colors > 3 {
                diagnostics.push(diagnostic(
                    "8BS2110",
                    format!(
                        "sprite '{}' has {} colours; an NES sprite tile holds three plus transparent \u{2014} extra colours were quantized",
                        sprite.name, colors
                    ),
                    file,
                    sprite.start,
                    sprite.length,
                    Severity::Warning,
                ));
            }
            let corners: &[(u32, u32)] = if th == 16.0 {
                &[(0, 0), (8, 0), (0, 8), (8, 8)]
            } else {
                &[(0, 0)]
            };
            let mut tiles = Vec::new();
            for &(sx, sy) in corners {
                let bytes = pack_tile(&indices, frame.width, sx, sy);
                chr_patches.push(ChrPatch { tile, bytes });
                tiles.push(tile);
                tile += 1.0;
            }
            data.extend(tiles);
        }
        GraphicsLowered {
            kind: Some(KIND_NES),
            data: Some(data),
            frames: Some(frame_indexes.len() as f64),
            every: Some(anim.map_or(8.0, |a| a.every)),
            width: Some(tw),
            height: Some(th),
            chr_patches: Some(chr_patches),
            diagnostics: Some(diagnostics),
        }
    }

    fn lower_audio(
        &self,
        air: &Air,
        pcm_by_sample: &IndexMap<String, Pcm>,
        _facts: &Facts,
        file: &str,
        _encode_song: &dyn Fn(&Song) -> EncodedSong,
    ) -> AudioLowered {
        let mut diagnostics = Vec::new();
        let mut samples = Vec::new();
        let mut songs = Vec::new();
        for sample in &air.samples {
            let dpcm = pcm_by_sample
                .get(&sample.name)
                .and_then(|pcm| pcm.dpcm.as_ref());
            if let Some(dpcm) = dpcm {
                let mut data = vec![255.0, dpcm.length as f64];
                data.extend(dpcm.bytes.iter().map(|&b| f64::from(b)));
                samples.push(LoweredAsset {
                    name: sample.name.clone(),
                    data: Some(data),
                    events: Some(Vec::new()),
                });
            } else {
                let fallback = sample
                    .fallback
                    .as_ref()
                    .map_or("noise", |f| f.synth.as_str());
                diagnostics.push(diagnostic(
                    "8BS2210",
                    format!(
                        "sample '{}' cannot be DPCM on this clip; using fallback {{ synth {fallback} }}",
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
        }
        for song in &air.songs {
            let (events, length) = song_events(air, song);
            if events.iter().any(|e| e.waveform == "saw") {
                diagnostics.push(diagnostic(
                    "8BS2212",
                    "waveform 'saw' cannot route on 'nes'",
                    file,
                    song.start,
                    song.length,
                    Severity::Error,
                ));
            }
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
