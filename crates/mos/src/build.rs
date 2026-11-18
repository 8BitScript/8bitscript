//! Port of mos/index.ts (`build`)

use serde::{Deserialize, Serialize};

/// Variant order follows `mos/index.ts:55`; serde names are the JS strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Machine {
    Vic20,
    C64,
    Pet,
    C128,
    Mega65,
    Cx16,
    Nes,
    Atari8,
    Plus4,
    Oric,
    Apple2,
    Bbc,
    Atari5200,
    Lynx,
    Pce,
    Supervision,
    Atari2600,
    Atari7800,
}

impl Machine {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vic20 => "vic20",
            Self::C64 => "c64",
            Self::Pet => "pet",
            Self::C128 => "c128",
            Self::Mega65 => "mega65",
            Self::Cx16 => "cx16",
            Self::Nes => "nes",
            Self::Atari8 => "atari8",
            Self::Plus4 => "plus4",
            Self::Oric => "oric",
            Self::Apple2 => "apple2",
            Self::Bbc => "bbc",
            Self::Atari5200 => "atari5200",
            Self::Lynx => "lynx",
            Self::Pce => "pce",
            Self::Supervision => "supervision",
            Self::Atari2600 => "atari2600",
            Self::Atari7800 => "atari7800",
        }
    }
}

/// The two module-level label counters (R4.6); `build()` creates it zeroed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    pub lower: u64,
    pub relax: u64,
}
