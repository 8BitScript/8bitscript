//! The c64 media module, ported from `packages/c64/media/index.cjs:1-151`.
//! PNG to 24x21 VIC-II sprite bytes. The sample does not become a $D418
//! digi: `fallback { synth }` is what plays.
//!
//! Declared deviations: the `diagnostic` callback and the `helpers` object
//! are direct `Diagnostic` construction and the `encode_song` argument
//! (`machine.rs`); `slots` is unused here, as in the JS.

use crate::audio::song::EncodedSong;
use crate::audio::{Air, Song};
use crate::graphics::Sprite;
use crate::machine::{
    AudioLowered, Facts, Frame, GraphicsLowered, LoweredAsset, LoweredEvent, MachineMedia,
    MediaSlots, Pcm,
};
use diagnostics::{Severity, diagnostic};
use indexmap::IndexMap;
use jsnum::{number_to_string, to_int32};
use std::collections::HashSet;

const KIND_C64: i32 = 1;

// graphics.meta's `kind` byte is this machine's to define: the low nibble is
// KIND_C64, the high nibble the sprite's VIC-II colour (0-15). A graphics
// sprite owns FRAME_BLOCKS shape blocks in the driver's layout, so 4 frames
// x 63 bytes = 252 is the most one sprite can hold.
const FRAME_BLOCKS: usize = 4;

/// The 16 VIC-II colours, as the Pepto palette (the one VICE defaults to).
const PALETTE: [[f64; 3]; 16] = [
    [0.0, 0.0, 0.0],
    [255.0, 255.0, 255.0],
    [129.0, 51.0, 56.0],
    [117.0, 206.0, 200.0],
    [142.0, 60.0, 151.0],
    [86.0, 172.0, 77.0],
    [46.0, 44.0, 155.0],
    [237.0, 241.0, 113.0],
    [142.0, 80.0, 41.0],
    [85.0, 56.0, 0.0],
    [196.0, 108.0, 113.0],
    [74.0, 74.0, 74.0],
    [123.0, 123.0, 123.0],
    [169.0, 255.0, 159.0],
    [112.0, 109.0, 235.0],
    [178.0, 178.0, 178.0],
];

/// `rgba[o]`: a read past the end is `undefined`, which compares and
/// computes as NaN.
fn px(rgba: &[u8], o: usize) -> f64 {
    rgba.get(o).map_or(f64::NAN, |v| f64::from(*v))
}

/// `frames[index] ?? frames[0]`.
fn pick(frames: &[Frame], index: f64) -> Option<&Frame> {
    if index >= 0.0 && index.fract() == 0.0 && index < frames.len() as f64 {
        frames.get(index as usize)
    } else {
        frames.first()
    }
}

fn nearest_color(r: f64, g: f64, b: f64) -> usize {
    let mut best = 1;
    let mut best_distance = f64::INFINITY;
    for (index, [pr, pg, pb]) in PALETTE.iter().enumerate() {
        let distance = (r - pr).powi(2) + (g - pg).powi(2) + (b - pb).powi(2);
        if distance < best_distance {
            best = index;
            best_distance = distance;
        }
    }
    best
}

/// The VIC-II sprite is one colour: the palette entry nearest the colour
/// most of the opaque pixels (over every kept frame) have.
fn dominant_color(frame_list: &[&Frame]) -> usize {
    let mut votes = vec![0u32; PALETTE.len()];
    for frame in frame_list {
        for i in 0..(frame.width as usize * frame.height as usize) {
            let o = i * 4;
            if px(&frame.rgba, o + 3) < 16.0 {
                continue;
            }
            votes[nearest_color(
                px(&frame.rgba, o),
                px(&frame.rgba, o + 1),
                px(&frame.rgba, o + 2),
            )] += 1;
        }
    }
    let mut best = 1;
    for (index, count) in votes.iter().enumerate() {
        if *count > votes[best] {
            best = index;
        }
    }
    best
}

fn pack_sprite(indices: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut bytes = [0u8; 63];
    for y in 0..21 {
        for x in 0..24 {
            if x >= width || y >= height {
                continue;
            }
            if indices.get(y * width + x) == Some(&255) {
                continue;
            }
            bytes[y * 3 + (x >> 3)] |= 0x80 >> (x & 7);
        }
    }
    bytes.to_vec()
}

/// `{indices, colors}` of `quantize1bit`.
fn quantize_1bit(rgba: &[u8], width: usize, height: usize) -> (Vec<u8>, usize) {
    let mut indices = vec![0u8; width * height];
    let mut seen: HashSet<(i32, i32, i32)> = HashSet::new();
    for (i, index) in indices.iter_mut().enumerate() {
        let o = i * 4;
        if px(rgba, o + 3) < 16.0 {
            *index = 255;
            continue;
        }
        let key = (
            to_int32(px(rgba, o)) >> 4,
            to_int32(px(rgba, o + 1)) >> 4,
            to_int32(px(rgba, o + 2)) >> 4,
        );
        seen.insert(key);
        *index = 1;
    }
    (indices, seen.len())
}

fn wave(name: &str) -> f64 {
    match name {
        "pulse" => 0.0,
        "noise" => 1.0,
        "triangle" => 2.0,
        "saw" => 3.0,
        _ => 1.0,
    }
}

/// The c64 media module.
#[derive(Debug, Clone, Copy, Default)]
pub struct C64;

impl MachineMedia for C64 {
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
        let wanted: Vec<f64> = match anim {
            Some(a) if !a.frames.is_empty() => a.frames.clone(),
            _ => vec![0.0],
        };
        let frame_indexes: Vec<f64> = wanted.iter().take(FRAME_BLOCKS).copied().collect();
        if wanted.len() > FRAME_BLOCKS {
            diagnostics.push(diagnostic(
                "8BS2111",
                format!(
                    "sprite '{}' has {} animation frames; a C64 graphics sprite keeps {} \u{2014} frames collapsed to the first {}",
                    sprite.name,
                    number_to_string(wanted.len() as f64),
                    number_to_string(FRAME_BLOCKS as f64),
                    number_to_string(FRAME_BLOCKS as f64),
                ),
                file,
                sprite.start,
                sprite.length,
                Severity::Warning,
            ));
        }
        let kept: Vec<&Frame> = frame_indexes
            .iter()
            .filter_map(|index| pick(frames, *index))
            .collect();
        let color = dominant_color(&kept);
        let mut data: Vec<u8> = Vec::new();
        for index in &frame_indexes {
            let Some(frame) = pick(frames, *index) else {
                continue;
            };
            let (indices, colors) =
                quantize_1bit(&frame.rgba, frame.width as usize, frame.height as usize);
            if colors > 1 {
                diagnostics.push(diagnostic(
                    "8BS2110",
                    format!(
                        "sprite '{}' has {} colours; the VIC-II sprite holds one plus transparent \u{2014} extra colours were quantized",
                        sprite.name,
                        number_to_string(colors as f64),
                    ),
                    file,
                    sprite.start,
                    sprite.length,
                    Severity::Warning,
                ));
            }
            data.extend(pack_sprite(
                &indices,
                frame.width as usize,
                frame.height as usize,
            ));
        }
        if data.is_empty() {
            data.extend([0u8; 63]);
        }
        GraphicsLowered {
            kind: Some(f64::from(KIND_C64 | ((color as i32) << 4))),
            data: Some(data.iter().map(|b| f64::from(*b)).collect()),
            frames: Some(frame_indexes.len() as f64),
            every: Some(anim.map_or(8.0, |a| a.every)),
            width: Some(24.0),
            height: Some(21.0),
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
        encode_song: &dyn Fn(&Song) -> EncodedSong,
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
                    "sample '{}' is not a $D418 digi in this slice; using fallback {{ synth {fallback} }}",
                    sample.name
                ),
                file,
                sample.start,
                sample.length,
                Severity::Warning,
            ));
            samples.push(LoweredAsset {
                name: sample.name.clone(),
                data: Some(vec![wave(fallback), 60.0]),
                events: Some(Vec::new()),
            });
        }
        for song in &air.songs {
            let encoded = encode_song(song);
            songs.push(LoweredAsset {
                name: song.name.clone(),
                data: Some(encoded.data),
                events: Some(encoded.events.into_iter().map(LoweredEvent::Song).collect()),
            });
        }
        AudioLowered {
            samples,
            songs,
            diagnostics: Some(diagnostics),
        }
    }
}
