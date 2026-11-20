//! The vic20 media module, ported from `packages/vic20/media/index.cjs:1-190`.
//! PNG to screen codes, worked out at build time: the sprite is reduced to
//! the ROM's sixteen 2x2 quadrant-block characters (screen codes 32, 97-127
//! and their reverses), which turn the 22 x 23 grid into 44 x 46
//! pseudo-pixels. One cell for a source of 8 pixels or fewer in a
//! direction, two for anything larger; a pseudo-pixel is lit when any
//! opaque dark pixel of the source falls in it. Song to the three squares
//! plus noise at $900A-$900D.
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
use jsnum::{number_to_string, string_to_number};
use serde_json::Value;

const KIND_VIC20: f64 = 4.0;
const KIND_GLYPH: f64 = 0.0;
/// A ball, the screen code a faint sprite is drawn as.
const GLYPH: u8 = 0x51;
/// How many frames one sprite may carry (the driver's pool of codes is
/// fixed); a sprite is cut to this and says so.
const MAX_FRAMES: usize = 8;
/// The bytes of that pool, shared by every object in the build.
const POOL: usize = 64;

/// Screen code for each 2x2 pattern, indexed by TL<<3 | TR<<2 | BL<<1 | BR.
const QUAD: [u8; 16] = [
    32, 108, 123, 98, 124, 225, 255, 254, 126, 127, 97, 252, 226, 251, 236, 160,
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

/// `Number(v)` of a facts entry; `undefined` never reaches it (the JS `??`
/// turns it into 0 first).
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

/// `Number(facts?.['audio.voices'] ?? 0)`.
fn voices_of(facts: &Facts) -> f64 {
    facts.get("audio.voices").map_or(0.0, facts_number)
}

fn is_ink(rgba: &[u8], o: usize) -> bool {
    px(rgba, o + 3) >= 16.0 && px(rgba, o) + px(rgba, o + 1) + px(rgba, o + 2) < 500.0
}

fn ink_count(frame: &Frame) -> usize {
    let mut n = 0;
    for i in 0..frame.width as usize * frame.height as usize {
        if is_ink(&frame.rgba, i * 4) {
            n += 1;
        }
    }
    n
}

/// The frame's pseudo-pixels, `pw` x `ph`, each lit if any ink falls in the
/// part of the source it covers.
fn pseudo_pixels(frame: &Frame, pw: usize, ph: usize) -> Vec<u8> {
    let (fw, fh) = (frame.width as usize, frame.height as usize);
    let mut bits = Vec::new();
    for y in 0..ph {
        let y0 = (y * fh) / ph;
        let y1 = usize::max(y0 + 1, ((y + 1) * fh) / ph);
        for x in 0..pw {
            let x0 = (x * fw) / pw;
            let x1 = usize::max(x0 + 1, ((x + 1) * fw) / pw);
            let mut on = 0;
            let mut sy = y0;
            while sy < y1 && sy < fh && on == 0 {
                let mut sx = x0;
                while sx < x1 && sx < fw {
                    if is_ink(&frame.rgba, (sy * fw + sx) * 4) {
                        on = 1;
                        break;
                    }
                    sx += 1;
                }
                sy += 1;
            }
            bits.push(on);
        }
    }
    bits
}

fn frame_codes(frame: &Frame, cw: usize, ch: usize) -> Vec<u8> {
    let pw = cw * 2;
    let bits = pseudo_pixels(frame, pw, ch * 2);
    let at = |x: usize, y: usize| usize::from(bits[y * pw + x]);
    let mut codes = Vec::new();
    for cy in 0..ch {
        for cx in 0..cw {
            let x = cx * 2;
            let y = cy * 2;
            codes.push(
                QUAD[(at(x, y) << 3)
                    | (at(x + 1, y) << 2)
                    | (at(x, y + 1) << 1)
                    | at(x + 1, y + 1)],
            );
        }
    }
    codes
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

/// The vic20 media module.
#[derive(Debug, Clone, Copy, Default)]
pub struct Vic20;

impl MachineMedia for Vic20 {
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
        let every = anim.map_or(8.0, |a| a.every);
        let glyph = |data: u8, diagnostics| GraphicsLowered {
            kind: Some(KIND_GLYPH),
            data: Some(vec![f64::from(data)]),
            frames: Some(1.0),
            every: Some(every),
            width: Some(8.0),
            height: Some(8.0),
            chr_patches: Some(Vec::new()),
            diagnostics: Some(diagnostics),
        };
        if frames.is_empty() {
            return glyph(0x2A, diagnostics);
        }
        let wanted: Vec<f64> = match anim {
            Some(a) if !a.frames.is_empty() => a.frames.clone(),
            _ => vec![0.0],
        };
        let used: Vec<&Frame> = wanted
            .iter()
            .take(MAX_FRAMES)
            .filter_map(|index| pick(frames, *index))
            .collect();
        if wanted.len() > MAX_FRAMES {
            diagnostics.push(diagnostic(
                "8BS2111",
                format!(
                    "sprite '{}' has {} animation frames; the VIC-20 keeps the first {}",
                    sprite.name,
                    number_to_string(wanted.len() as f64),
                    number_to_string(MAX_FRAMES as f64),
                ),
                file,
                sprite.start,
                sprite.length,
                Severity::Warning,
            ));
        }
        if used.iter().map(|frame| ink_count(frame)).sum::<usize>() < 4 {
            diagnostics.push(diagnostic(
                "8BS2111",
                format!(
                    "sprite '{}' has too little ink to survive as quadrant blocks; using a software glyph",
                    sprite.name
                ),
                file,
                sprite.start,
                sprite.length,
                Severity::Warning,
            ));
            return glyph(GLYPH, diagnostics);
        }
        // At least 4 ink pixels were counted, so `used` is not empty.
        let (w, h) = (used[0].width, used[0].height);
        let cw = if w > 8 { 2 } else { 1 };
        let ch = if h > 8 { 2 } else { 1 };
        diagnostics.push(diagnostic(
            "8BS2111",
            format!(
                "sprite '{}' is a {}\u{d7}{}-cell quadrant-block object on the VIC-20, taking {} of the {} pool bytes every object shares; one that does not fit is not drawn",
                sprite.name,
                number_to_string(cw as f64),
                number_to_string(ch as f64),
                number_to_string((used.len() * cw * ch) as f64),
                number_to_string(POOL as f64),
            ),
            file,
            sprite.start,
            sprite.length,
            Severity::Warning,
        ));
        GraphicsLowered {
            kind: Some(KIND_VIC20),
            data: Some(
                used.iter()
                    .flat_map(|frame| frame_codes(frame, cw, ch))
                    .map(f64::from)
                    .collect(),
            ),
            frames: Some(used.len() as f64),
            every: Some(every),
            width: Some((cw * 8) as f64),
            height: Some((ch * 8) as f64),
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
                    "target 'vic20' has no audio driver yet; playback omitted",
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
                    "target 'vic20' has no audio driver yet; playback omitted",
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
            let fallback = sample
                .fallback
                .as_ref()
                .map_or("noise", |f| f.synth.as_str());
            diagnostics.push(diagnostic(
                "8BS2210",
                format!(
                    "sample '{}' is not PCM on the VIC; using fallback {{ synth {fallback} }}",
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
            if encoded.events.iter().any(|e| e.waveform == "saw") {
                diagnostics.push(diagnostic(
                    "8BS2212",
                    "waveform 'saw' cannot route on 'vic20'",
                    file,
                    song.start,
                    song.length,
                    Severity::Error,
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
