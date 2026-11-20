//! The machine-lowering contract: what a machine's `media/index.cjs`
//! (`lowerGraphics`, `lowerAudio`) takes and returns. The elaborate unit
//! calls it; this unit only fixes the types.
//!
//! Declared deviations from the JS callers:
//! - `Frame` is a placeholder. Its decoder is not ported yet (it belongs to
//!   the media tools), so only the fields the machine modules read are here.
//!   `Pcm` is the decoded audio plus its DPCM encoding.
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
use serde::Serialize;
use serde_json::Value;

pub use media_tools::audio::Dpcm;

/// Serializes `data` as JS plain numbers: integral values print without a
/// fraction (`[255,300,1]`), so the JSON matches what `JSON.stringify` gives.
#[allow(clippy::ref_option, clippy::cast_possible_truncation)]
fn serialize_numbers<S: serde::Serializer>(
    data: &Option<Vec<f64>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeSeq;
    let Some(data) = data else {
        return serializer.serialize_none();
    };
    let mut seq = serializer.serialize_seq(Some(data.len()))?;
    for &n in data {
        if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
            seq.serialize_element(&(n as i64))?;
        } else {
            seq.serialize_element(&n)?;
        }
    }
    seq.end()
}

/// The machine facts object (`facts['audio.voices']`, ...).
pub type Facts = IndexMap<String, Value>;

/// A decoded picture frame: `{width, height, rgba}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Decoded sample audio: `{...decodeWav(bytes), dpcm: encodeDpcm(samples, sampleRate)}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Pcm {
    pub sample_rate: u32,
    pub samples: Vec<f32>,
    pub dpcm: Option<Dpcm>,
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
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChrPatch {
    pub tile: f64,
    pub bytes: Vec<u8>,
}

/// What `lowerGraphics` returns; every key may be absent.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsLowered {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<f64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_numbers"
    )]
    pub data: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chr_patches: Option<Vec<ChrPatch>>,
    pub diagnostics: Option<Vec<Diagnostic>>,
}

/// An atari8/nes `songEvents` item: `{row, note, waveform, voice}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VoiceEvent {
    pub row: f64,
    pub note: f64,
    pub waveform: String,
    pub voice: f64,
}

/// One item of a lowered asset's `events`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum LoweredEvent {
    Song(SongEvent),
    Voice(VoiceEvent),
}

/// A lowered sample or song: `{name, data, events}`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredAsset {
    pub name: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_numbers"
    )]
    pub data: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<LoweredEvent>>,
}

/// What `lowerAudio` returns.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLowered {
    pub samples: Vec<LoweredAsset>,
    pub songs: Vec<LoweredAsset>,
    #[serde(skip_serializing_if = "Option::is_none")]
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

#[cfg(test)]
mod tests {
    use super::*;
    use media_tools::audio::{decode_wav, encode_dpcm};

    fn wav_fixture() -> Vec<u8> {
        let samples: Vec<u8> = (0..64u32).map(|i| (i * 4 % 256) as u8).collect();
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&8000u32.to_le_bytes());
        v.extend_from_slice(&8000u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&8u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        v.extend_from_slice(&samples);
        v
    }

    #[test]
    fn voice_events_serialize_in_js_key_order() {
        let asset = LoweredAsset {
            name: "tune".to_string(),
            data: None,
            events: Some(vec![LoweredEvent::Voice(VoiceEvent {
                row: 1.0,
                note: 60.0,
                waveform: "pulse".to_string(),
                voice: 2.0,
            })]),
        };
        assert_eq!(
            serde_json::to_string(&asset).unwrap(),
            r#"{"name":"tune","events":[{"row":1.0,"note":60.0,"waveform":"pulse","voice":2.0}]}"#
        );
    }

    #[test]
    fn song_events_serialize_in_js_key_order() {
        let asset = LoweredAsset {
            name: "tune".to_string(),
            data: None,
            events: Some(vec![LoweredEvent::Song(SongEvent {
                row: 0.0,
                note: 48.0,
                waveform: "tri".to_string(),
                volume: 15.0,
                length: 4.0,
                decay: 0.0,
            })]),
        };
        assert_eq!(
            serde_json::to_string(&asset).unwrap(),
            r#"{"name":"tune","events":[{"row":0.0,"note":48.0,"waveform":"tri","volume":15.0,"length":4.0,"decay":0.0}]}"#
        );
    }

    #[test]
    fn data_past_255_serializes_as_numbers() {
        let lowered = GraphicsLowered {
            data: Some(vec![255.0, 300.0, 1.0]),
            ..GraphicsLowered::default()
        };
        assert_eq!(serde_json::to_string(&lowered).unwrap(),
            r#"{"data":[255,300,1]}"#);
    }

    #[test]
    fn pcm_from_wav_and_dpcm() {
        let decoded = decode_wav(&wav_fixture()).unwrap();
        let dpcm = encode_dpcm(&decoded.samples, f64::from(decoded.sample_rate));
        let pcm = Pcm {
            sample_rate: decoded.sample_rate,
            samples: decoded.samples,
            dpcm,
        };
        assert_eq!(pcm.sample_rate, 8000);
        assert_eq!(pcm.samples.len(), 64);
        assert!(pcm.dpcm.is_some());
    }
}
