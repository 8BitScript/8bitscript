//! The pet media module (`packages/pet/media/index.cjs`).

use crate::audio::song::EncodedSong;
use crate::audio::{Air, Song};
use crate::graphics::Sprite;
use crate::machine::{
    AudioLowered, Facts, Frame, GraphicsLowered, LoweredAsset, LoweredEvent, MachineMedia,
    MediaSlots, Pcm,
};
use diagnostics::{Severity, diagnostic};
use indexmap::IndexMap;
use jsnum::string_to_number;
use serde_json::Value;

/// The pet media module.
#[derive(Debug, Clone, Copy, Default)]
pub struct Pet;

const KIND_PET: f64 = 3.0;
const KIND_GLYPH: f64 = 0.0;
/// Rows of a 4x4 shape, bit 3 the left pixel: the middle two by two.
const CENTRE_BLOCK: [f64; 4] = [0.0, 6.0, 6.0, 0.0];
/// The sprite layer holds this many shapes in all.
const MAX_FRAMES: i64 = 7;
const WAVE_PULSE: f64 = 0.0;

/// `frames[index] ?? frames[0]`.
fn frame_at(frames: &[Frame], index: f64) -> Option<&Frame> {
    let by_index = if index >= 0.0 && index.fract() == 0.0 && index < frames.len() as f64 {
        frames.get(index as usize)
    } else {
        None
    };
    by_index.or_else(|| frames.first())
}

/// `downsample(rgba, width, height, dstW, dstH, byAlpha)`.
fn downsample(
    rgba: &[u8],
    width: u32,
    height: u32,
    dst_w: u32,
    dst_h: u32,
    by_alpha: bool,
) -> Vec<u8> {
    let px = |k: usize| rgba.get(k).copied();
    let mut bits = Vec::new();
    for y in 0..dst_h {
        let mut row = 0u8;
        for x in 0..dst_w {
            let x0 = x * width / dst_w;
            let x1 = (x0 + 1).max((x + 1) * width / dst_w);
            let y0 = y * height / dst_h;
            let y1 = (y0 + 1).max((y + 1) * height / dst_h);
            let mut ink = 0u32;
            let mut n = 0u32;
            let mut sy = y0;
            while sy < y1 && sy < height {
                let mut sx = x0;
                while sx < x1 && sx < width {
                    let o = (sy * width + sx) as usize * 4;
                    n += 1;
                    // A missing alpha is `undefined >= 16`: false.
                    if px(o + 3).is_some_and(|a| a >= 16) {
                        let bright = match (px(o), px(o + 1), px(o + 2)) {
                            (Some(r), Some(g), Some(b)) => {
                                u32::from(r) + u32::from(g) + u32::from(b) < 500
                            }
                            _ => false,
                        };
                        if by_alpha || bright {
                            ink += 1;
                        }
                    }
                    sx += 1;
                }
                sy += 1;
            }
            if n != 0 && f64::from(ink) / f64::from(n) >= 0.3 {
                row |= 1 << (dst_w - 1 - x);
            }
        }
        bits.push(row);
    }
    bits
}

/// `Number(facts?.['audio.voices'] ?? 0)`. Facts hold numbers; the other
/// JSON shapes get their `Number()` value where it is simple.
fn voices_of(facts: &Facts) -> f64 {
    match facts.get("audio.voices") {
        None | Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(_) => f64::NAN,
    }
}

fn empty_asset(name: &str) -> LoweredAsset {
    LoweredAsset {
        name: name.to_string(),
        data: Some(Vec::new()),
        events: Some(Vec::new()),
    }
}

impl MachineMedia for Pet {
    fn lower_graphics(
        &self,
        sprite: &Sprite,
        frames: &[Frame],
        _facts: &Facts,
        file: &str,
        slots: Option<&mut MediaSlots>,
    ) -> GraphicsLowered {
        let mut shared = slots;
        let mut diagnostics = Vec::new();
        let anim = sprite.animations.first();
        let every = anim.map_or(8.0, |a| a.every);
        if frames.is_empty() {
            return GraphicsLowered {
                kind: Some(KIND_GLYPH),
                data: Some(vec![42.0]),
                frames: Some(1.0),
                every: Some(8.0),
                width: Some(8.0),
                height: Some(8.0),
                chr_patches: Some(Vec::new()),
                diagnostics: Some(diagnostics),
            };
        }
        let spent = shared.as_ref().map_or(0, |s| s.pet_shapes.unwrap_or(0));
        let left = MAX_FRAMES - i64::from(spent);
        if left <= 0 {
            diagnostics.push(diagnostic(
                "8BS2111",
                format!(
                    "sprite '{}' is not drawn: the PET holds {MAX_FRAMES} shapes in all and earlier pictures have taken them",
                    sprite.name
                ),
                file,
                sprite.start,
                sprite.length,
                Severity::Warning,
            ));
            return GraphicsLowered {
                kind: Some(KIND_PET),
                data: Some(Vec::new()),
                frames: Some(0.0),
                every: Some(every),
                width: Some(16.0),
                height: Some(16.0),
                chr_patches: Some(Vec::new()),
                diagnostics: Some(diagnostics),
            };
        }
        let wanted: Vec<f64> = match anim {
            Some(a) if !a.frames.is_empty() => a.frames.clone(),
            _ => vec![0.0],
        };
        let indexes: Vec<f64> = wanted.iter().take(left as usize).copied().collect();
        let picked: Vec<&Frame> = indexes
            .iter()
            .filter_map(|&index| frame_at(frames, index))
            .collect();
        let by_alpha = picked
            .iter()
            .any(|frame| frame.rgba.iter().skip(3).step_by(4).any(|&a| a < 16));
        let rows: Vec<Vec<u8>> = picked
            .iter()
            .map(|frame| downsample(&frame.rgba, frame.width, frame.height, 4, 4, by_alpha))
            .collect();
        let flat: Vec<u8> = rows.iter().flatten().copied().collect();
        let ink: u32 = flat.iter().map(|row| row.count_ones()).sum();
        if ink < 2 {
            // A picture of one lit quadrant or none: all it can show is a mark.
            diagnostics.push(diagnostic(
                "8BS2111",
                format!(
                    "sprite '{}' cannot survive as a 4\u{d7}4 quadrant-block; using a small centre block",
                    sprite.name
                ),
                file,
                sprite.start,
                sprite.length,
                Severity::Warning,
            ));
            if let Some(s) = &mut shared {
                s.pet_shapes = Some(s.pet_shapes.unwrap_or(0) + 1);
            }
            return GraphicsLowered {
                kind: Some(KIND_PET),
                data: Some(CENTRE_BLOCK.to_vec()),
                frames: Some(1.0),
                every: Some(every),
                width: Some(16.0),
                height: Some(16.0),
                chr_patches: Some(Vec::new()),
                diagnostics: Some(diagnostics),
            };
        }
        let dropped = wanted.len() - indexes.len();
        let mut message = format!(
            "sprite '{}' is a 4\u{d7}4 quadrant-block object on the PET",
            sprite.name
        );
        if indexes.len() > 1 {
            message.push_str(&format!(", {} frames", indexes.len()));
        }
        if dropped != 0 {
            message.push_str(&format!(
                "; the last {dropped} frame{} dropped (the PET holds {MAX_FRAMES} shapes in all)",
                if dropped == 1 { "" } else { "s" }
            ));
        }
        diagnostics.push(diagnostic(
            "8BS2111",
            message,
            file,
            sprite.start,
            sprite.length,
            Severity::Warning,
        ));
        if let Some(s) = &mut shared {
            s.pet_shapes = Some(s.pet_shapes.unwrap_or(0) + indexes.len() as u32);
        }
        GraphicsLowered {
            kind: Some(KIND_PET),
            data: Some(flat.iter().map(|&b| f64::from(b)).collect()),
            frames: Some(indexes.len() as f64),
            every: Some(every),
            width: Some(16.0),
            height: Some(16.0),
            chr_patches: Some(Vec::new()),
            diagnostics: Some(diagnostics),
        }
    }

    fn lower_audio(
        &self,
        air: &Air,
        _pcm_by_sample: &IndexMap<String, Pcm>,
        facts: &Facts,
        file: &str,
        encode_song: &dyn Fn(&Song) -> EncodedSong,
    ) -> AudioLowered {
        let mut diagnostics = Vec::new();
        let mut samples = Vec::new();
        let mut songs = Vec::new();
        let voices = voices_of(facts);
        // `!voices`: 0 and NaN are falsy.
        let silent = voices == 0.0 || voices.is_nan();
        for sample in &air.samples {
            if silent {
                diagnostics.push(diagnostic(
                    "8BS2211",
                    "target 'pet' has no audio driver yet; playback omitted",
                    file,
                    sample.start,
                    sample.length,
                    Severity::Warning,
                ));
                samples.push(empty_asset(&sample.name));
                continue;
            }
            let fallback = sample
                .fallback
                .as_ref()
                .map_or("pulse", |f| f.synth.as_str());
            if fallback == "noise" {
                diagnostics.push(diagnostic(
                    "8BS2210",
                    format!(
                        "sample '{}' cannot play noise on the PET's one square wave; omitted",
                        sample.name
                    ),
                    file,
                    sample.start,
                    sample.length,
                    Severity::Warning,
                ));
                samples.push(empty_asset(&sample.name));
            } else {
                samples.push(LoweredAsset {
                    name: sample.name.clone(),
                    data: Some(vec![WAVE_PULSE, 60.0]),
                    events: Some(Vec::new()),
                });
            }
        }
        for song in &air.songs {
            if silent {
                diagnostics.push(diagnostic(
                    "8BS2211",
                    "target 'pet' has no audio driver yet; playback omitted",
                    file,
                    song.start,
                    song.length,
                    Severity::Warning,
                ));
                songs.push(empty_asset(&song.name));
                continue;
            }
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
