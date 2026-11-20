//! The web media module (`packages/web/media/index.cjs`). A picture becomes,
//! per animation step, one 8x8 one-ink glyph; songs and samples play through
//! the host's one oscillator.

use crate::audio::song::EncodedSong;
use crate::audio::{Air, Song};
use crate::graphics::Sprite;
use crate::machine::{
    AudioLowered, Facts, Frame, GraphicsLowered, LoweredAsset, LoweredEvent, MachineMedia,
    MediaSlots, Pcm,
};
use diagnostics::{Severity, diagnostic};
use indexmap::IndexMap;
use std::collections::HashSet;

/// The web media module.
#[derive(Debug, Clone, Copy, Default)]
pub struct Web;

const KIND_GLYPH: f64 = 0.0;
/// graphics/src/index.web.8bs holds this many animation steps per picture.
const MAX_STEPS: usize = 8;
/// The glyph is eight rows of eight pixels.
const GLYPH_SIZE: u32 = 8;
/// A glyph pixel is lit when at least this share of the source pixels it
/// covers is opaque.
const LIT_SHARE: f64 = 0.5;
const OPAQUE_ALPHA: u8 = 16;

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
fn frame_at(frames: &[Frame], index: f64) -> Option<&Frame> {
    let by_index = if index >= 0.0 && index.fract() == 0.0 && index < frames.len() as f64 {
        frames.get(index as usize)
    } else {
        None
    };
    by_index.or_else(|| frames.first())
}

/// `boxShare(frame, gx, gy)`: the opaque share (0..1) of the source box
/// behind glyph pixel (gx, gy).
fn box_share(frame: &Frame, gx: u32, gy: u32) -> f64 {
    let (width, height) = (frame.width, frame.height);
    let x0 = gx * width / GLYPH_SIZE;
    let x1 = (x0 + 1).max((gx + 1) * width / GLYPH_SIZE);
    let y0 = gy * height / GLYPH_SIZE;
    let y1 = (y0 + 1).max((gy + 1) * height / GLYPH_SIZE);
    let mut ink = 0u32;
    let mut area = 0u32;
    let mut y = y0;
    while y < y1 && y < height {
        let mut x = x0;
        while x < x1 && x < width {
            area += 1;
            // A missing alpha is `undefined >= 16`: false.
            if frame
                .rgba
                .get((y * width + x) as usize * 4 + 3)
                .is_some_and(|&a| a >= OPAQUE_ALPHA)
            {
                ink += 1;
            }
            x += 1;
        }
        y += 1;
    }
    if area == 0 {
        0.0
    } else {
        f64::from(ink) / f64::from(area)
    }
}

/// `glyphOf(frame)`: the eight row bytes for one frame.
#[must_use]
pub fn glyph_of(frame: &Frame) -> Vec<u8> {
    let mut shares = Vec::new();
    let mut best = 0.0f64;
    for gy in 0..GLYPH_SIZE {
        for gx in 0..GLYPH_SIZE {
            let share = box_share(frame, gx, gy);
            shares.push(share);
            if share > best {
                best = share;
            }
        }
    }
    let mut rows = vec![0u8; GLYPH_SIZE as usize];
    if best == 0.0 {
        return rows;
    }
    let threshold = if best >= LIT_SHARE { LIT_SHARE } else { best };
    for (i, &share) in shares.iter().enumerate() {
        if share >= threshold {
            rows[i / GLYPH_SIZE as usize] |= 1 << (i % GLYPH_SIZE as usize);
        }
    }
    rows
}

/// `opaqueColours(frame)`: how many distinct opaque colours a frame has.
fn opaque_colours(frame: &Frame) -> usize {
    let mut seen: HashSet<u32> = HashSet::new();
    let px = |k: usize| u32::from(frame.rgba.get(k).copied().unwrap_or(0));
    for i in 0..(frame.width * frame.height) as usize {
        if frame
            .rgba
            .get(i * 4 + 3)
            .is_some_and(|&a| a >= OPAQUE_ALPHA)
        {
            seen.insert((px(i * 4) << 16) | (px(i * 4 + 1) << 8) | px(i * 4 + 2));
        }
    }
    seen.len()
}

impl MachineMedia for Web {
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
        if frames.is_empty() {
            return GraphicsLowered {
                kind: Some(KIND_GLYPH),
                data: Some(vec![255.0; GLYPH_SIZE as usize]),
                frames: Some(1.0),
                every: Some(every),
                width: Some(f64::from(GLYPH_SIZE)),
                height: Some(f64::from(GLYPH_SIZE)),
                chr_patches: Some(Vec::new()),
                diagnostics: Some(diagnostics),
            };
        }
        let sequence: Vec<f64> = match anim {
            Some(a) if !a.frames.is_empty() => a.frames.clone(),
            _ => vec![0.0],
        };
        let kept: Vec<f64> = sequence.iter().take(MAX_STEPS).copied().collect();
        let used: Vec<&Frame> = kept
            .iter()
            .filter_map(|&index| frame_at(frames, index))
            .collect();
        let data: Vec<u8> = used.iter().flat_map(|frame| glyph_of(frame)).collect();
        let mut notes: Vec<String> = Vec::new();
        if used.iter().any(|frame| opaque_colours(frame) > 1) {
            notes.push("colours dropped".to_string());
        }
        if used
            .iter()
            .any(|frame| frame.width != GLYPH_SIZE || frame.height != GLYPH_SIZE)
        {
            notes.push(format!(
                "{}\u{d7}{} reduced to {GLYPH_SIZE}\u{d7}{GLYPH_SIZE}",
                used[0].width, used[0].height
            ));
        }
        if kept.len() > 1 {
            notes.push(format!("{} animation steps kept", kept.len()));
        }
        if sequence.len() > MAX_STEPS {
            notes.push(format!("steps past {MAX_STEPS} dropped"));
        }
        if !notes.is_empty() {
            diagnostics.push(diagnostic(
                "8BS2111",
                format!(
                    "sprite '{}' is an 8\u{d7}8 one-ink glyph on the web; {}",
                    sprite.name,
                    notes.join("; ")
                ),
                file,
                sprite.start,
                sprite.length,
                Severity::Warning,
            ));
        }
        GraphicsLowered {
            kind: Some(KIND_GLYPH),
            data: Some(data.iter().map(|&b| f64::from(b)).collect()),
            frames: Some(kept.len() as f64),
            every: Some(every),
            width: Some(f64::from(GLYPH_SIZE)),
            height: Some(f64::from(GLYPH_SIZE)),
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
