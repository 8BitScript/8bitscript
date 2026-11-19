//! Port of mos/image-raw.ts: a bare load, the linked bytes and nothing else.

use super::{ImageKind, MachineImage};

pub static RAW: MachineImage = MachineImage {
    kind: ImageKind::Raw,
    entry_is_vectored: false,
    writable_image: None,
    ends_by_halting: None,
};

#[must_use]
pub fn file(body: &[u8]) -> Vec<u8> {
    body.to_vec()
}

#[cfg(test)]
mod tests {
    #[test]
    fn body_is_returned_unchanged() {
        assert_eq!(super::file(&[1, 2, 3]), vec![1, 2, 3]);
    }
}
