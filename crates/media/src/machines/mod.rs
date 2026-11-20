//! The per-machine media modules (`packages/<machine>/media/index.cjs`).
//! Each is a stub until the elaborate unit ports its lowering; a stub
//! lowers nothing, which the caller reads as "use the default lowering".

pub mod atari8;
pub mod c64;
pub mod cx16;
pub mod nes;
pub mod pet;
pub mod vic20;
pub mod web;

use crate::machine::MachineMedia;

/// The media module of `machine`, or `None` for a machine without one.
#[must_use]
pub fn for_machine(machine: &str) -> Option<Box<dyn MachineMedia>> {
    match machine {
        "atari8" => Some(Box::new(atari8::Atari8)),
        "c64" => Some(Box::new(c64::C64)),
        "cx16" => Some(Box::new(cx16::Cx16)),
        "nes" => Some(Box::new(nes::Nes)),
        "pet" => Some(Box::new(pet::Pet)),
        "vic20" => Some(Box::new(vic20::Vic20)),
        "web" => Some(Box::new(web::Web)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::song::encode_song;
    use crate::audio::{Air, Song};
    use crate::graphics::{Sprite, Transparent};
    use crate::machine::{AudioLowered, Facts, GraphicsLowered, Pcm};
    use indexmap::IndexMap;

    const NAMES: [&str; 7] = ["atari8", "c64", "cx16", "nes", "pet", "vic20", "web"];

    #[test]
    fn every_machine_resolves_and_others_do_not() {
        for n in NAMES {
            assert!(for_machine(n).is_some(), "{n}");
        }
        for n in ["", "apple2", "C64", "wasm"] {
            assert!(for_machine(n).is_none(), "{n}");
        }
    }

    #[test]
    fn stubs_lower_nothing() {
        let sprite = Sprite {
            name: "s".into(),
            source: None,
            width: 8.0,
            height: 8.0,
            transparent: Transparent::Auto,
            animations: Vec::new(),
            start: 0,
            length: 0,
            source_start: 0,
            source_length: 0,
            size_start: 0,
            size_length: 0,
        };
        let air = Air {
            instruments: Vec::new(),
            samples: Vec::new(),
            songs: Vec::new(),
            parts: Vec::new(),
            voice_groups: Vec::new(),
        };
        let pcm: IndexMap<String, Pcm> = IndexMap::new();
        let facts = Facts::new();
        let enc = |s: &Song| encode_song(&air, s);
        for n in NAMES {
            // Machines with a ported module are covered by `tests/machine_media.rs`.
            if matches!(n, "c64" | "cx16" | "vic20") {
                continue;
            }
            let m = for_machine(n).unwrap();
            let mut slots = crate::machine::MediaSlots::default();
            assert_eq!(
                m.lower_graphics(&sprite, &[], &facts, "a.8bg", Some(&mut slots)),
                GraphicsLowered::default(),
                "{n}"
            );
            assert_eq!(slots, crate::machine::MediaSlots::default(), "{n}");
            assert_eq!(
                m.lower_audio(&air, &pcm, &facts, "a.8ba", &enc),
                AudioLowered::default(),
                "{n}"
            );
        }
    }
}
