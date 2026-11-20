//! The machine-lowering contract: what a machine's `media/index.cjs`
//! (`lowerGraphics`, `lowerAudio`) takes and returns. The elaborate unit
//! calls it; this unit only fixes the types.
//!
//! Declared deviations from the JS callers:
//! - `Frame` and `Pcm` are placeholders. Their decoders are not ported yet
//!   (they belong to the media tools), so only the fields the machine
//!   modules read are here.
//! - JS passes a `wrapDiagnostic` callback and a `helpers` object. The
//!   lowerers here build `Diagnostic`s directly with `diagnostics::diagnostic`,
//!   and `helpers.encodeSong` is the `encode_song` argument.
//! - Every key of the JS result objects is optional there; every field is
//!   an `Option` here, with the caller's defaults applied by the caller.

use crate::audio::song::{EncodedSong, SongEvent};
use crate::audio::{Air, Song};
use crate::graphics::Sprite;
use diagnostics::Diagnostic;
use indexmap::IndexMap;
use serde_json::Value;

/// The machine facts object (`facts['audio.voices']`, ...).
pub type Facts = IndexMap<String, Value>;

/// A decoded picture frame: `{width, height, rgba}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Decoded sample audio. A placeholder until the decoder is ported.
#[derive(Debug, Clone, PartialEq)]
pub struct Pcm {
    pub rate: f64,
    pub samples: Vec<f64>,
}

/// The link-wide slot counters (`mediaSlots`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MediaSlots {
    pub graphics: u32,
    pub audio: u32,
    pub audio_bytes: u32,
    /// `shared.petShapes`: absent until the PET module first writes it.
    pub pet_shapes: Option<u32>,
}

/// `{tile, bytes}` of a `chrPatches` entry.
#[derive(Debug, Clone, PartialEq)]
pub struct ChrPatch {
    pub tile: f64,
    pub bytes: Vec<u8>,
}

/// What `lowerGraphics` returns; every key may be absent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GraphicsLowered {
    pub kind: Option<f64>,
    pub data: Option<Vec<u8>>,
    pub frames: Option<f64>,
    pub every: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub chr_patches: Option<Vec<ChrPatch>>,
    pub diagnostics: Option<Vec<Diagnostic>>,
}

/// A lowered sample or song: `{name, data, events}`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoweredAsset {
    pub name: String,
    pub data: Option<Vec<u8>>,
    pub events: Option<Vec<SongEvent>>,
}

/// What `lowerAudio` returns.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AudioLowered {
    pub samples: Vec<LoweredAsset>,
    pub songs: Vec<LoweredAsset>,
    pub diagnostics: Option<Vec<Diagnostic>>,
}

/// A machine's media module.
pub trait MachineMedia {
    /// `lowerGraphics(sprite, frames, facts, file, diagnostic, mediaSlots)`.
    fn lower_graphics(
        &self,
        sprite: &Sprite,
        frames: &[Frame],
        facts: &Facts,
        file: &str,
        slots: Option<&mut MediaSlots>,
    ) -> GraphicsLowered;

    /// `lowerAudio(air, pcmBySample, facts, file, diagnostic, helpers)`.
    fn lower_audio(
        &self,
        air: &Air,
        pcm_by_sample: &IndexMap<String, Pcm>,
        facts: &Facts,
        file: &str,
        encode_song: &dyn Fn(&Song) -> EncodedSong,
    ) -> AudioLowered;
}
