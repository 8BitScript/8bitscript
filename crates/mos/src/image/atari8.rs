//! Port of mos/image-atari8.ts: a DOS `.xex`, a `$FFFF` marker followed by
//! (start, end, bytes) segments. The RUN segment (two bytes at `$02E0`) comes
//! first, the layout that was measured to boot.

use super::{ImageKind, MachineImage};

/// `$FFFF`, the word every `.xex` opens with.
const XEX_MARKER: i64 = 0xffff;

/// RUNAD: the address the DOS loader jumps through once the file is loaded.
const RUNAD: i64 = 0x02e0;

pub static ATARI8: MachineImage = MachineImage {
    kind: ImageKind::Atari8,
    entry_is_vectored: false,
    writable_image: None,
    ends_by_halting: Some(true),
};

fn push_word(out: &mut Vec<u8>, value: i64) {
    out.push((value & 0xff) as u8);
    out.push(((value >> 8) & 0xff) as u8);
}

/// One segment header: where it loads and the address of its last byte.
fn push_segment_header(out: &mut Vec<u8>, start: i64, length: i64) {
    push_word(out, start);
    push_word(out, start + length - 1);
}

#[must_use]
pub fn file(load: i64, body: &[u8], code_start: i64) -> Vec<u8> {
    let mut out = Vec::new();
    push_word(&mut out, XEX_MARKER);
    push_segment_header(&mut out, RUNAD, 2);
    push_word(&mut out, code_start);
    push_segment_header(&mut out, load, body.len() as i64);
    out.extend_from_slice(body);
    out
}

#[cfg(test)]
mod tests {
    use super::file;

    #[test]
    fn run_segment_comes_first() {
        let out = file(0x2000, &[0xA9, 0x00, 0x60], 0x2000);
        assert_eq!(
            out,
            vec![
                0xff, 0xff, 0xe0, 0x02, 0xe1, 0x02, 0x00, 0x20, 0x00, 0x20, 0x02, 0x20, 0xA9, 0x00,
                0x60
            ]
        );
    }

    #[test]
    fn empty_body_has_an_end_before_its_start() {
        // end = start - 1, as in the JS.
        let out = file(0x2000, &[], 0x2000);
        assert_eq!(&out[10..], &[0xff, 0x1f]);
    }
}
