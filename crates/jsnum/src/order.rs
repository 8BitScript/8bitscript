use std::cmp::Ordering;

/// JavaScript string `<` / `>`: compare UTF-16 code units.
#[must_use]
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// The array-index value of a property key, if it is a canonical one
/// (`"0"`, `"17"`; no sign, no leading zeros, below 2^32 - 1).
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// The order `Object.keys` visits keys given in insertion order: integer-like
/// keys ascending first, then the rest in insertion order. Returns indices
/// into `keys`.
#[must_use]
pub fn object_key_order<S: AsRef<str>>(keys: &[S]) -> Vec<usize> {
    let mut ints: Vec<(u32, usize)> = Vec::new();
    let mut rest: Vec<usize> = Vec::new();
    for (i, key) in keys.iter().enumerate() {
        match array_index(key.as_ref()) {
            Some(n) => ints.push((n, i)),
            None => rest.push(i),
        }
    }
    ints.sort_by_key(|(n, _)| *n);
    ints.into_iter().map(|(_, i)| i).chain(rest).collect()
}
