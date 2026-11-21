//! The web media module, ported from `packages/web/media/index.cjs:1-123` and
//! `packages/graphics-tools/src/sprite-pack.cjs`. A picture becomes a 4bpp
//! pixel sprite the page draws, with its own palette (the Commander X16's
//! packing, shared through `sprite_pack`); songs and samples play through the
//! host's one oscillator.
//!
//! The graphics driver is handed, byte by byte through `graphics.bind`:
//! bytes 0..1 where the sprite's frames start in the shared pool (low byte,
//! then high), bytes 2..33 the palette (sixteen 12-bit colours in VERA's
//! order, entry 0 the clear one), then every animation frame as a linear
//! 4bpp bitmap. The limits come from the build's facts: `video.sprites`
//! slots, `video.spriteWidth` x `video.spriteHeight` bytes of window per
//! sprite and `video.spriteKib` KiB of pool every picture shares.
//!
//! Declared deviations: the `diagnostic` callback and the `helpers` object
//! are direct `Diagnostic` construction and the `encode_song` argument
//! (`machine.rs`); `tally` is `slots`. `Number(value)` of a facts entry is
//! `facts_number` below.

use super::sprite_pack::{PALETTE_COLORS, build_palette, legal_size, pack_frame};
use crate::audio::song::EncodedSong;
use crate::audio::{Air, Song};
use crate::graphics::Sprite;
use crate::machine::{
    AudioLowered, Facts, Frame, GraphicsLowered, LoweredAsset, LoweredEvent, MachineMedia,
    MediaSlots, Pcm,
};
use diagnostics::{Diagnostic, Severity, diagnostic};
use indexmap::IndexMap;
use jsnum::{number_to_string, string_to_number, to_int32};
use serde_json::Value;

/// The web media module.
#[derive(Debug, Clone, Copy, Default)]
pub struct Web;

const KIND_WEB: f64 = 6.0;
const PALETTE_BYTES: usize = 32;

/// `WAVE[fallback] ?? 0`.
fn wave(name: &str) -> u8 {
    match name {
        "noise" => 1,
        "triangle" => 2,
        "saw" => 3,
        _ => 0,
    }
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
        Value::Array(_) => string_to_number(&join_string(v)),
        Value::Object(_) => f64::NAN,
    }
}

/// `String(v)` of a JSON value as `Array.prototype.join(",")` builds it:
/// `null` is "", nested arrays recurse, objects are "[object Object]".
fn join_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(join_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `empty(sprite, diagnostics, every)`.
fn empty(diagnostics: Vec<Diagnostic>, every: f64) -> GraphicsLowered {
    GraphicsLowered {
        kind: Some(KIND_WEB),
        data: Some(Vec::new()),
        frames: Some(0.0),
        every: Some(every),
        width: Some(8.0),
        height: Some(8.0),
        chr_patches: Some(Vec::new()),
        diagnostics: Some(diagnostics),
    }
}

impl MachineMedia for Web {
    fn lower_graphics(
        &self,
        sprite: &Sprite,
        frames: &[Frame],
        facts: &Facts,
        file: &str,
        mut slots: Option<&mut MediaSlots>,
    ) -> GraphicsLowered {
        let mut diagnostics = Vec::new();
        let mut warn = |code: &str, text: String| {
            diagnostics.push(diagnostic(
                code,
                text,
                file,
                sprite.start,
                sprite.length,
                Severity::Warning,
            ));
        };
        let anim = sprite.animations.first();
        let every = anim.map_or(8.0, |a| a.every);
        let slot = slots.as_ref().map_or(0.0, |s| f64::from(s.graphics) - 1.0);
        let max = facts.get("video.sprites").map_or(0.0, facts_number);
        if slot >= max {
            warn(
                "8BS2111",
                format!(
                    "sprite '{}' is slot {}; this build has {} sprites, so it is never drawn",
                    sprite.name,
                    number_to_string(slot),
                    match facts.get("video.sprites") {
                        None | Some(Value::Null) => "0".to_string(),
                        Some(v) => join_string(v),
                    },
                ),
            );
            return empty(diagnostics, every);
        }
        // A source with no picture is one white 8x8 block.
        let source: Vec<Frame> = if frames.is_empty() {
            vec![Frame {
                width: 8,
                height: 8,
                rgba: vec![255; 8 * 8 * 4],
            }]
        } else {
            frames.to_vec()
        };
        let width = legal_size(f64::from(source[0].width));
        let height = legal_size(f64::from(source[0].height));
        if source[0].width > 64 || source[0].height > 64 {
            warn(
                "8BS2111",
                format!(
                    "sprite '{}' is {}x{}; a web sprite is at most 64x64 \u{2014} the rest was cut",
                    sprite.name,
                    number_to_string(f64::from(source[0].width)),
                    number_to_string(f64::from(source[0].height)),
                ),
            );
        }
        let mut order: Vec<f64> = match anim {
            Some(a) if !a.frames.is_empty() && !frames.is_empty() => a.frames.clone(),
            _ => vec![0.0],
        };
        let frame_bytes = (width * height) / 2.0;
        let window = facts.get("video.spriteWidth").map_or(0.0, facts_number)
            * facts.get("video.spriteHeight").map_or(0.0, facts_number);
        // NaN is unreachable here: the facts are counts (R2.11); the same holds
        // for the `kept` max/min below.
        let fit = f64::max(1.0, (window / frame_bytes).floor());
        if order.len() as f64 > fit {
            warn(
                "8BS2111",
                format!(
                    "sprite '{}': {} frames of {}x{} do not fit its {}-byte window; the first {} are kept",
                    sprite.name,
                    number_to_string(order.len() as f64),
                    number_to_string(width),
                    number_to_string(height),
                    number_to_string(window),
                    number_to_string(fit),
                ),
            );
            order.truncate(fit as usize);
        }
        let pool = facts.get("video.spriteKib").map_or(0.0, facts_number) * 1024.0;
        let at = slots
            .as_ref()
            .and_then(|s| s.web_sprite_bytes)
            .map_or(0.0, f64::from);
        let kept = f64::min(
            order.len() as f64,
            f64::max(0.0, ((pool - at) / frame_bytes).floor()),
        );
        if kept < order.len() as f64 {
            warn(
                "8BS2111",
                format!(
                    "sprite '{}': the {}-byte sprite pool has {} bytes left; {} of {} frames kept",
                    sprite.name,
                    number_to_string(pool),
                    number_to_string(f64::max(0.0, pool - at)),
                    number_to_string(kept),
                    number_to_string(order.len() as f64),
                ),
            );
        }
        if let Some(s) = slots.as_mut() {
            // R2.1: the cast saturates (the tally is a byte count, R7.8 note above).
            s.web_sprite_bytes = Some((at + kept * frame_bytes) as u32);
        }
        let used: Vec<&Frame> = order
            .iter()
            .take(kept as usize)
            .filter_map(|i| pick(&source, *i))
            .collect();
        let (colors, distinct) = build_palette(&used);
        if distinct > PALETTE_COLORS {
            warn(
                "8BS2110",
                format!(
                    "sprite '{}' has {} colours; a web sprite holds {} plus transparent \u{2014} the rarest were mapped to the nearest kept",
                    sprite.name,
                    number_to_string(distinct as f64),
                    number_to_string(PALETTE_COLORS as f64),
                ),
            );
        }
        let mut data = vec![0.0f64; 2 + PALETTE_BYTES];
        data[0] = f64::from(to_int32(at) & 255);
        data[1] = f64::from(to_int32(at) >> 8);
        for (i, key) in colors.iter().enumerate() {
            data[2 + (i + 1) * 2] = f64::from(((((key >> 4) & 15) << 4) | (key & 15)) as u8);
            data[2 + (i + 1) * 2 + 1] = f64::from(((key >> 8) & 15) as u8);
        }
        for frame in &used {
            data.extend(
                pack_frame(frame, &colors, width as usize, height as usize)
                    .into_iter()
                    .map(f64::from),
            );
        }
        GraphicsLowered {
            kind: Some(KIND_WEB),
            data: Some(data),
            frames: Some(used.len() as f64),
            every: Some(every),
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
                .map_or("pulse", |f| f.synth.as_str());
            diagnostics.push(diagnostic(
                "8BS2210",
                format!(
                    "sample '{}' is not PCM on the web; using fallback {{ synth {fallback} }}",
                    sample.name
                ),
                file,
                sample.start,
                sample.length,
                Severity::Warning,
            ));
            samples.push(LoweredAsset {
                name: sample.name.clone(),
                data: Some(vec![f64::from(wave(fallback)), 60.0]),
                events: Some(Vec::new()),
            });
        }
        for song in &air.songs {
            let encoded = encode_song(song);
            if encoded.events.iter().any(|e| e.waveform == "noise") {
                diagnostics.push(diagnostic(
                    "8BS2212",
                    "waveform 'noise' cannot route on 'web': the oscillator plays it as a square",
                    file,
                    song.start,
                    song.length,
                    Severity::Warning,
                ));
            }
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
