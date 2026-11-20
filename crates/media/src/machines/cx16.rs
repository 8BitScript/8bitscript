//! The cx16 media module, ported from `packages/cx16/media/index.cjs:1-190`.
//! PNG to a VERA 4bpp hardware sprite with its own palette; song to the
//! VERA PSG at $1F9C0.
//!
//! The graphics driver is handed, byte by byte through `graphics.bind`:
//! bytes 0..31 the sprite's palette (sixteen 12-bit colours, two bytes each
//! in VERA's order, GGGGBBBB then 0000RRRR, entry 0 always zero), then every
//! animation frame, each a linear 4bpp bitmap, the left pixel in the high
//! nibble. The size is the next legal VERA size (8, 16, 32 or 64 a side).
//!
//! Declared deviations: the `diagnostic` callback and the `helpers` object
//! are direct `Diagnostic` construction and the `encode_song` argument
//! (`machine.rs`); `slots` is unused here, as in the JS. `Number(value)` of
//! a facts entry is `facts_number` below.

use crate::audio::song::EncodedSong;
use crate::audio::{Air, Song};
use crate::graphics::Sprite;
use crate::machine::{
    AudioLowered, Facts, Frame, GraphicsLowered, LoweredAsset, LoweredEvent, MachineMedia,
    MediaSlots, Pcm,
};
use diagnostics::{Severity, diagnostic};
use indexmap::IndexMap;
use jsnum::{number_to_string, string_to_number, to_int32};
use serde_json::Value;

const KIND_CX16: f64 = 5.0;
const KIND_GLYPH: f64 = 0.0;
const PALETTE_COLORS: usize = 15;
const WINDOW_BYTES: f64 = 4096.0;
const SIZES: [f64; 4] = [8.0, 16.0, 32.0, 64.0];

/// `rgba[o]`: a read past the end is `undefined`, which compares as NaN
/// and is 0 under `>> 4`.
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

/// `Number(v)` of a facts entry; `undefined` and `null` never reach it
/// (the JS `??` turns them into 0 first).
fn facts_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_to_number(s),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        Value::Array(a) => match a.as_slice() {
            [] => 0.0,
            [one] => facts_number(one),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// `Number(facts?.['audio.voices'] ?? 0)`.
fn voices_of(facts: &Facts) -> f64 {
    facts.get("audio.voices").map_or(0.0, facts_number)
}

fn legal_size(n: f64) -> f64 {
    for s in SIZES {
        if n <= s {
            return s;
        }
    }
    64.0
}

fn rgb12(rgba: &[u8], o: usize) -> [i32; 3] {
    [
        to_int32(px(rgba, o)) >> 4,
        to_int32(px(rgba, o + 1)) >> 4,
        to_int32(px(rgba, o + 2)) >> 4,
    ]
}

/// `{colors, distinct}`: the sprite's own picture colours, most-used first,
/// quantized to VERA's 12 bits.
fn build_palette(frames: &[&Frame]) -> (Vec<i32>, usize) {
    let mut counts: IndexMap<i32, u32> = IndexMap::new();
    for frame in frames {
        let mut o = 0;
        while o < frame.width as usize * frame.height as usize * 4 {
            if px(&frame.rgba, o + 3) < 16.0 {
                o += 4;
                continue;
            }
            let [r, g, b] = rgb12(&frame.rgba, o);
            let key = (r << 8) | (g << 4) | b;
            *counts.entry(key).or_insert(0) += 1;
            o += 4;
        }
    }
    let mut ordered: Vec<(i32, u32)> = counts.into_iter().collect();
    // `Array.prototype.sort` is stable; the comparator is `b[1] - a[1] || a[0] - b[0]`.
    ordered.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let distinct = ordered.len();
    (
        ordered
            .iter()
            .take(PALETTE_COLORS)
            .map(|(key, _)| *key)
            .collect(),
        distinct,
    )
}

fn nearest(colors: &[i32], r: i32, g: i32, b: i32) -> i32 {
    let mut best = 0;
    let mut best_d = f64::INFINITY;
    for (i, key) in colors.iter().enumerate() {
        let dr = ((key >> 8) & 15) - r;
        let dg = ((key >> 4) & 15) - g;
        let db = (key & 15) - b;
        let d = f64::from(dr * dr + dg * dg + db * db);
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best as i32 + 1
}

fn pack_frame(frame: &Frame, colors: &[i32], width: usize, height: usize) -> Vec<u8> {
    let index: IndexMap<i32, i32> = colors
        .iter()
        .enumerate()
        .map(|(i, key)| (*key, i as i32 + 1))
        .collect();
    let mut out = Vec::new();
    for y in 0..height {
        let mut x = 0;
        while x < width {
            let mut pair = [0i32, 0i32];
            for (k, slot) in pair.iter_mut().enumerate() {
                let p = x + k;
                if p >= frame.width as usize || y >= frame.height as usize {
                    continue;
                }
                let o = (y * frame.width as usize + p) * 4;
                if px(&frame.rgba, o + 3) < 16.0 {
                    continue;
                }
                let [r, g, b] = rgb12(&frame.rgba, o);
                *slot = index
                    .get(&((r << 8) | (g << 4) | b))
                    .copied()
                    .unwrap_or_else(|| nearest(colors, r, g, b));
            }
            out.push(((pair[0] << 4) | pair[1]) as u8);
            x += 2;
        }
    }
    out
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

/// The cx16 media module.
#[derive(Debug, Clone, Copy, Default)]
pub struct Cx16;

impl MachineMedia for Cx16 {
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
        let Some(first) = frames.first() else {
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
        };
        let width = legal_size(f64::from(first.width));
        let height = legal_size(f64::from(first.height));
        if first.width > 64 || first.height > 64 {
            diagnostics.push(diagnostic(
                "8BS2111",
                format!(
                    "sprite '{}' is {}x{}; a VERA sprite is at most 64x64 \u{2014} the rest was cut",
                    sprite.name,
                    number_to_string(f64::from(first.width)),
                    number_to_string(f64::from(first.height)),
                ),
                file,
                sprite.start,
                sprite.length,
                Severity::Warning,
            ));
        }
        let mut order: Vec<f64> = match anim {
            Some(a) if !a.frames.is_empty() => a.frames.clone(),
            _ => vec![0.0],
        };
        let frame_bytes = (width * height) / 2.0;
        let fit = f64::max(1.0, (WINDOW_BYTES / frame_bytes).floor());
        if order.len() as f64 > fit {
            diagnostics.push(diagnostic(
                "8BS2111",
                format!(
                    "sprite '{}': {} frames of {}x{} do not fit its {}-byte window of video memory; the first {} are kept",
                    sprite.name,
                    number_to_string(order.len() as f64),
                    number_to_string(width),
                    number_to_string(height),
                    number_to_string(WINDOW_BYTES),
                    number_to_string(fit),
                ),
                file,
                sprite.start,
                sprite.length,
                Severity::Warning,
            ));
            order.truncate(fit as usize);
        }
        let used: Vec<&Frame> = order
            .iter()
            .filter_map(|i| pick(frames, *i))
            .collect();
        let (colors, distinct) = build_palette(&used);
        if distinct > PALETTE_COLORS {
            diagnostics.push(diagnostic(
                "8BS2110",
                format!(
                    "sprite '{}' has {} colours; a VERA 4bpp sprite holds {} plus transparent \u{2014} the rarest were mapped to the nearest kept",
                    sprite.name,
                    number_to_string(distinct as f64),
                    number_to_string(PALETTE_COLORS as f64),
                ),
                file,
                sprite.start,
                sprite.length,
                Severity::Warning,
            ));
        }
        diagnostics.push(diagnostic(
            "8BS2111",
            format!(
                "sprite '{}' is a {}x{} VERA hardware sprite on the Commander X16",
                sprite.name,
                number_to_string(width),
                number_to_string(height),
            ),
            file,
            sprite.start,
            sprite.length,
            Severity::Warning,
        ));
        let mut data = vec![0u8; 32];
        for (i, key) in colors.iter().enumerate() {
            data[(i + 1) * 2] = ((((key >> 4) & 15) << 4) | (key & 15)) as u8;
            data[(i + 1) * 2 + 1] = ((key >> 8) & 15) as u8;
        }
        for frame in &used {
            data.extend(pack_frame(frame, &colors, width as usize, height as usize));
        }
        GraphicsLowered {
            kind: Some(KIND_CX16),
            data: Some(data.iter().map(|b| f64::from(*b)).collect()),
            frames: Some(used.len() as f64),
            every: Some(anim.map_or(8.0, |a| a.every)),
            width: Some(width),
            height: Some(height),
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
        if voices == 0.0 || voices.is_nan() {
            for sample in &air.samples {
                diagnostics.push(diagnostic(
                    "8BS2211",
                    "target 'cx16' has no audio driver yet; playback omitted",
                    file,
                    sample.start,
                    sample.length,
                    Severity::Warning,
                ));
                samples.push(LoweredAsset {
                    name: sample.name.clone(),
                    data: Some(Vec::new()),
                    events: Some(Vec::new()),
                });
            }
            for song in &air.songs {
                diagnostics.push(diagnostic(
                    "8BS2211",
                    "target 'cx16' has no audio driver yet; playback omitted",
                    file,
                    song.start,
                    song.length,
                    Severity::Warning,
                ));
                songs.push(LoweredAsset {
                    name: song.name.clone(),
                    data: Some(Vec::new()),
                    events: Some(Vec::new()),
                });
            }
            return AudioLowered {
                samples,
                songs,
                diagnostics: Some(diagnostics),
            };
        }
        for sample in &air.samples {
            let fallback = sample.fallback.as_ref().map_or("noise", |f| f.synth.as_str());
            diagnostics.push(diagnostic(
                "8BS2210",
                format!(
                    "sample '{}' is not PCM in this slice; using fallback {{ synth {fallback} }}",
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
                events: Some(
                    encoded
                        .events
                        .into_iter()
                        .map(LoweredEvent::Song)
                        .collect(),
                ),
            });
        }
        AudioLowered {
            samples,
            songs,
            diagnostics: Some(diagnostics),
        }
    }
}
