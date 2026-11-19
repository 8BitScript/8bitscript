//! Port of mos/image-cart.ts: a 6502 cartridge ROM with the reset vector at
//! the top of the image.

use super::{ImageKind, MachineImage};

const fn cart_image(rom_size: i64) -> MachineImage {
    MachineImage {
        kind: ImageKind::Cart(rom_size),
        entry_is_vectored: true,
        writable_image: Some(false),
        ends_by_halting: Some(true),
    }
}

pub static CART_4K: MachineImage = cart_image(4096);
pub static CART_32K: MachineImage = cart_image(32768);

fn write16(buf: &mut [u8], offset: usize, value: i64) {
    buf[offset] = (value & 0xff) as u8;
    buf[offset + 1] = ((jsnum::to_uint32(value as f64) >> 8) & 0xff) as u8;
}

#[must_use]
pub fn file(rom_size: i64, load: i64, body: &[u8], code_start: i64) -> Vec<u8> {
    let size = if rom_size > 0 { rom_size } else { 4096 } as usize;
    let mut out = vec![0xffu8; size];
    let copy = body.len().min(size - 7);
    out[..copy].copy_from_slice(&body[..copy]);
    let rti = size - 7;
    out[rti] = 0x40; // RTI
    write16(&mut out, size - 6, load + rti as i64); // NMI
    write16(&mut out, size - 4, code_start); // RESET
    write16(&mut out, size - 2, load + rti as i64); // IRQ
    out
}

#[cfg(test)]
mod tests {
    use super::file;

    #[test]
    fn vectors_sit_at_the_top() {
        let out = file(4096, 0xF000, &[0xEA, 0xEA], 0xF000);
        assert_eq!(out.len(), 4096);
        assert_eq!(&out[..3], &[0xEA, 0xEA, 0xFF]);
        assert_eq!(out[4096 - 7], 0x40);
        assert_eq!(&out[4096 - 6..], &[0xF9, 0xFF, 0x00, 0xF0, 0xF9, 0xFF]);
    }

    #[test]
    fn oversize_body_is_truncated_and_zero_size_defaults() {
        let body = vec![1u8; 5000];
        let out = file(0, 0, &body, 0);
        assert_eq!(out.len(), 4096);
        assert_eq!(out[4088], 1);
        assert_eq!(out[4089], 0x40);
    }
}
