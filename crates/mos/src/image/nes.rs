//! Port of mos/image-nes.ts. The iNES file itself arrives with PR-F;
//! `MachineImage::file` returns `unported: NES.file` until then.

use super::{ImageKind, MachineImage};

pub static NES: MachineImage = MachineImage {
    kind: ImageKind::Nes,
    entry_is_vectored: true,
    writable_image: Some(false),
    ends_by_halting: None,
};
