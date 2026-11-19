//! Port of mos/prg.ts: the Commodore `.prg` format, a little-endian load
//! address followed by the bytes that land there.

/// `load`, little-endian, followed by `body`.
#[must_use]
pub fn prg_bytes(load: i64, body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(2 + body.len());
    bytes.push((load & 0xff) as u8);
    bytes.push(((load >> 8) & 0xff) as u8);
    bytes.extend_from_slice(body);
    bytes
}

#[cfg(test)]
mod tests {
    use super::prg_bytes;

    #[test]
    fn prepends_the_load_address_little_endian() {
        assert_eq!(prg_bytes(0x0801, &[1, 2]), vec![0x01, 0x08, 1, 2]);
        assert_eq!(prg_bytes(0x1234, &[]), vec![0x34, 0x12]);
    }
}
