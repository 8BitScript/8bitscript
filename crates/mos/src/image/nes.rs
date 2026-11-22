//! Port of mos/image-nes.ts: an iNES cartridge image, 32 KiB of PRG-ROM and
//! 8 KiB of CHR-ROM. The caller reads the native sources (`ImageExtras`).

use super::{ChrPatch, ImageExtras, ImageKind, MachineImage};
use crate::chr_nes::assemble_chr_rom;
use jsnum::{hex_upper, to_uint8};

pub static NES: MachineImage = MachineImage {
    kind: ImageKind::Nes,
    entry_is_vectored: true,
    writable_image: Some(false),
    ends_by_halting: None,
};

const INES_MAGIC: [u8; 4] = [0x4e, 0x45, 0x53, 0x1a];
const INES_HEADER_BYTES: usize = 16;
pub const PRG_ROM_BYTES: usize = 32 * 1024;
pub const CHR_ROM_BYTES: usize = 8 * 1024;
const PRG_ORIGIN: i64 = 0x8000;
const VECTOR_TABLE: i64 = 0xfffa;
const UNUSED_VECTOR_HANDLER: i64 = VECTOR_TABLE - 1;
const RTI: u8 = 0x40;
const ROM_FILL: u8 = 0xff;

fn le16(bytes: &mut [u8], offset: usize, value: i64) {
    let v = value as f64;
    bytes[offset] = to_uint8(v);
    bytes[offset + 1] = to_uint8(f64::from(jsnum::to_uint32(v) >> 8));
}

fn ines_header(prg_bytes: usize, chr_bytes: usize) -> [u8; INES_HEADER_BYTES] {
    let mut header = [0u8; INES_HEADER_BYTES];
    header[..4].copy_from_slice(&INES_MAGIC);
    header[4] = (prg_bytes / (16 * 1024)) as u8;
    header[5] = (chr_bytes / (8 * 1024)) as u8;
    header
}

fn apply_chr_patches(chr: &mut [u8], patches: &[ChrPatch]) -> Result<(), String> {
    for patch in patches {
        let offset = patch.tile.saturating_mul(16);
        if offset.saturating_add(patch.bytes.len() as i64) > chr.len() as i64 {
            continue;
        }
        // JS `Uint8Array.set` throws a RangeError for a negative offset.
        let offset = usize::try_from(offset)
            .map_err(|_| format!("offset is out of bounds (tile {})", patch.tile))?;
        for (i, b) in patch.bytes.iter().enumerate() {
            chr[offset + i] = to_uint8(*b as f64);
        }
    }
    Ok(())
}

fn chr_rom(extras: &ImageExtras) -> Result<Vec<u8>, String> {
    let chr = assemble_chr_rom(&extras.native_sources, CHR_ROM_BYTES as i64)?;
    if chr.defined == 0 {
        return Err("the NES has no character ROM of its own, so a .nes image needs the tile patterns a package ships as a `.chr_rom` native source — the linked program contributes none. Importing @8bitscript/screen or @8bitscript/text brings @8bitscript/nes's own font in".to_string());
    }
    let mut bytes = chr.bytes;
    apply_chr_patches(&mut bytes, extras.chr_patches.as_deref().unwrap_or(&[]))?;
    Ok(bytes)
}

/// The checks `file` makes before it reads any native source (image-nes.ts:157-164): the load
/// address, the end of the program against the vector table, and the offset the body is copied to.
///
/// # Errors
/// The JS error text of the first check that fails.
pub fn check_fit(load: i64, body_len: usize, code_start: i64) -> Result<usize, String> {
    if load != PRG_ORIGIN {
        return Err(format!(
            "the NES hardware sheet's defsym.__load_address is ${}, but NROM maps its 32K of PRG-ROM at $8000 — a cartridge cannot be built to load anywhere else",
            hex_upper(load, 0)
        ));
    }
    let offset = code_start.saturating_sub(PRG_ORIGIN);
    let end = offset.saturating_add(body_len as i64);
    if end > UNUSED_VECTOR_HANDLER - PRG_ORIGIN {
        return Err(format!(
            "the NES program ends at ${}, past the ${} start of the 6502's vector table",
            hex_upper(PRG_ORIGIN.saturating_add(end), 0),
            hex_upper(UNUSED_VECTOR_HANDLER, 0)
        ));
    }
    // JS `Uint8Array.set` throws a RangeError for a negative offset.
    usize::try_from(offset).map_err(|_| "offset is out of bounds".to_string())
}

/// iNES header, 32K of PRG-ROM with the code at $8000 and the vectors on top, 8K of CHR-ROM.
pub fn file(
    load: i64,
    body: &[u8],
    code_start: i64,
    extras: &ImageExtras,
) -> Result<Vec<u8>, String> {
    let at = check_fit(load, body.len(), code_start)?;

    let mut prg = vec![ROM_FILL; PRG_ROM_BYTES];
    prg[at..at + body.len()].copy_from_slice(body);
    prg[(UNUSED_VECTOR_HANDLER - PRG_ORIGIN) as usize] = RTI;
    let vt = (VECTOR_TABLE - PRG_ORIGIN) as usize;
    le16(&mut prg, vt, UNUSED_VECTOR_HANDLER); // NMI
    le16(&mut prg, vt + 2, code_start); // RESET: the program
    le16(&mut prg, vt + 4, UNUSED_VECTOR_HANDLER); // IRQ/BRK

    let chr = chr_rom(extras)?;
    let mut bytes = Vec::with_capacity(INES_HEADER_BYTES + prg.len() + chr.len());
    bytes.extend_from_slice(&ines_header(PRG_ROM_BYTES, CHR_ROM_BYTES));
    bytes.extend_from_slice(&prg);
    bytes.extend_from_slice(&chr);
    Ok(bytes)
}
