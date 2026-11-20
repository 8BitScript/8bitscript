//! The web media module (`packages/web/media/index.cjs`), a stub.

use crate::audio::song::EncodedSong;
use crate::audio::{Air, Song};
use crate::graphics::Sprite;
use crate::machine::{AudioLowered, Facts, Frame, GraphicsLowered, MachineMedia, MediaSlots, Pcm};
use std::collections::BTreeMap;

/// The web media module.
#[derive(Debug, Clone, Copy, Default)]
pub struct Web;

impl MachineMedia for Web {
    fn lower_graphics(
        &self,
        _sprite: &Sprite,
        _frames: &[Frame],
        _facts: &Facts,
        _file: &str,
        _slots: Option<&mut MediaSlots>,
    ) -> GraphicsLowered {
        GraphicsLowered::default()
    }

    fn lower_audio(
        &self,
        _air: &Air,
        _pcm_by_sample: &BTreeMap<String, Pcm>,
        _facts: &Facts,
        _file: &str,
        _encode_song: &dyn Fn(&Song) -> EncodedSong,
    ) -> AudioLowered {
        AudioLowered::default()
    }
}
