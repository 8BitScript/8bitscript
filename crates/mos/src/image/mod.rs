//! Port of mos/image.ts and its per-machine modules: what a built program
//! looks like as a file, per machine.

pub mod atari8;
pub mod cart;
pub mod nes;
pub mod raw;

use crate::basic_stub::basic_stub;
use crate::build::Machine;
use crate::chr_nes::NativeSource;
use crate::prg::prg_bytes;
use serde::{Deserialize, Serialize};

/// Tile patterns a `.8bg` module lowered onto the NES CHR-ROM.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChrPatch {
    pub tile: i64,
    pub bytes: Vec<i64>,
}

/// Everything a format may need that is neither the code nor an address.
/// `native_sources` carries file texts, not paths: the caller reads them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageExtras {
    pub native_sources: Vec<NativeSource>,
    pub chr_patches: Option<Vec<ChrPatch>>,
}

/// Which file shape a machine is built as (replaces the JS object of methods).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageKind {
    Commodore,
    C64,
    Raw,
    /// A cartridge ROM of the given size.
    Cart(i64),
    Atari8,
    Nes,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prelude {
    pub bytes: Vec<u8>,
    pub code_start: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MachineImage {
    pub kind: ImageKind,
    /// True when the machine starts the program itself, so there is no loader to return to.
    pub entry_is_vectored: bool,
    /// Whether the image's own bytes are the program's RAM once running (default true).
    pub writable_image: Option<bool>,
    /// Whether `main()` ending must stop the 6502 rather than RTS (default false).
    pub ends_by_halting: Option<bool>,
}

/// Load address, BASIC stub, `SYS`: every Commodore this backend builds.
pub static COMMODORE: MachineImage = MachineImage {
    kind: ImageKind::Commodore,
    entry_is_vectored: false,
    writable_image: None,
    ends_by_halting: None,
};

/// The C64 is still a `.prg` with a BASIC stub; it just halts at the end.
pub static C64: MachineImage = MachineImage {
    kind: ImageKind::C64,
    entry_is_vectored: false,
    writable_image: None,
    ends_by_halting: Some(true),
};

pub use atari8::ATARI8;
pub use cart::{CART_4K, CART_32K};
pub use nes::NES;
pub use raw::RAW;

impl MachineImage {
    /// The bytes that precede the lowered code inside the image, and the
    /// address the code begins at.
    pub fn prelude(&self, load: i64) -> Result<Prelude, String> {
        match self.kind {
            ImageKind::Commodore | ImageKind::C64 => {
                let stub = basic_stub(load)?;
                Ok(Prelude {
                    bytes: stub.bytes,
                    code_start: stub.code_start,
                })
            }
            ImageKind::Raw | ImageKind::Cart(_) | ImageKind::Atari8 | ImageKind::Nes => {
                Ok(Prelude {
                    bytes: Vec::new(),
                    code_start: load,
                })
            }
        }
    }

    /// The finished file. `body` is the prelude and the linked code joined.
    pub fn file(
        &self,
        load: i64,
        body: &[u8],
        code_start: i64,
        extras: &ImageExtras,
    ) -> Result<Vec<u8>, String> {
        match self.kind {
            ImageKind::Commodore | ImageKind::C64 => Ok(prg_bytes(load, body)),
            ImageKind::Raw => Ok(raw::file(body)),
            ImageKind::Cart(size) => Ok(cart::file(size, load, body, code_start)),
            ImageKind::Atari8 => Ok(atari8::file(load, body, code_start)),
            ImageKind::Nes => nes::file(load, body, code_start, extras),
        }
    }
}

/// The image a machine is built as: Commodore unless it says otherwise.
pub fn image_for(machine: Machine) -> Result<&'static MachineImage, String> {
    Ok(match machine {
        Machine::Atari8 => &ATARI8,
        Machine::Nes => &NES,
        Machine::C64 => &C64,
        Machine::Oric | Machine::Apple2 | Machine::Bbc => &RAW,
        Machine::Atari5200
        | Machine::Lynx
        | Machine::Pce
        | Machine::Supervision
        | Machine::Atari7800 => &CART_32K,
        Machine::Atari2600 => &CART_4K,
        Machine::Vic20
        | Machine::Pet
        | Machine::C128
        | Machine::Mega65
        | Machine::Cx16
        | Machine::Plus4 => &COMMODORE,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_matches_the_js_image_map() {
        assert_eq!(image_for(Machine::C64).unwrap().ends_by_halting, Some(true));
        assert_eq!(image_for(Machine::Pet).unwrap().kind, ImageKind::Commodore);
        assert_eq!(image_for(Machine::Oric).unwrap().kind, ImageKind::Raw);
        assert_eq!(
            image_for(Machine::Atari2600).unwrap().kind,
            ImageKind::Cart(4096)
        );
        assert_eq!(
            image_for(Machine::Lynx).unwrap().kind,
            ImageKind::Cart(32768)
        );
        assert!(image_for(Machine::Nes).unwrap().entry_is_vectored);
        assert!(!image_for(Machine::Atari8).unwrap().entry_is_vectored);
    }

    #[test]
    fn prelude_and_file_per_kind() {
        let extras = ImageExtras::default();
        let p = COMMODORE.prelude(0x0801).unwrap();
        assert_eq!(p.code_start, 2061);
        let f = COMMODORE.file(0x0801, &[9], p.code_start, &extras).unwrap();
        assert_eq!(f, vec![0x01, 0x08, 9]);
        let p = RAW.prelude(0x300).unwrap();
        assert_eq!((p.bytes.len(), p.code_start), (0, 0x300));
        assert_eq!(RAW.file(0x300, &[1], 0x300, &extras).unwrap(), vec![1]);
        assert_eq!(
            CART_4K.file(0xF000, &[], 0xF000, &extras).unwrap().len(),
            4096
        );
        assert_eq!(ATARI8.file(0x2000, &[1], 0x2000, &extras).unwrap()[0], 0xff);
    }

    #[test]
    fn nes_file_needs_chr_and_the_sheet_load_address() {
        let none = ImageExtras::default();
        let err = NES.file(0x8000, &[], 0x8000, &none).unwrap_err();
        assert!(err.starts_with("the NES has no character ROM"), "{err}");
        let err = NES.file(0x4000, &[], 0x4000, &none).unwrap_err();
        assert!(err.contains("$4000"), "{err}");
        assert_eq!(NES.prelude(0x8000).unwrap().code_start, 0x8000);
        let extras = ImageExtras {
            native_sources: vec![NativeSource {
                path: "t.s".into(),
                text: ".section .chr_rom,\"a\"\n.byte 1, 2".into(),
            }],
            chr_patches: Some(vec![ChrPatch {
                tile: 1,
                bytes: vec![9],
            }]),
        };
        let f = NES.file(0x8000, &[0xea], 0x8000, &extras).unwrap();
        assert_eq!(f.len(), 16 + 32768 + 8192);
        assert_eq!(&f[..8], &[0x4e, 0x45, 0x53, 0x1a, 2, 1, 0, 0]);
        assert_eq!(&f[16 + 32768..][..3], &[1, 2, 0]);
        assert_eq!(f[16 + 32768 + 16], 9);
    }
}
