//! Port of types/index.mjs (`storageBytes`, `resolveIntegerType` only)

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IntegerType {
    pub canonical_name: &'static str,
    pub signed: bool,
    pub bits: i64,
    pub bytes: i64,
    pub min: i64,
    pub max: i64,
}

const fn int(canonical_name: &'static str, signed: bool, bits: i64) -> IntegerType {
    let range = 1i64 << bits;
    IntegerType {
        canonical_name,
        signed,
        bits,
        bytes: bits / 8,
        min: if signed { -(range / 2) } else { 0 },
        max: if signed { range / 2 - 1 } else { range - 1 },
    }
}

static TINYINT: IntegerType = int("tinyint", true, 8);
static UTINYINT: IntegerType = int("utinyint", false, 8);
static SMALLINT: IntegerType = int("smallint", true, 16);
static USMALLINT: IntegerType = int("usmallint", false, 16);
static MEDIUMINT: IntegerType = int("mediumint", true, 24);
static UMEDIUMINT: IntegerType = int("umediumint", false, 24);
static INT: IntegerType = int("int", true, 32);
static UINT: IntegerType = int("uint", false, 32);

/// The 16 spellings in `BY_SPELLING` order.
static BY_SPELLING: [(&str, &IntegerType); 16] = [
    ("tinyint", &TINYINT),
    ("i8", &TINYINT),
    ("utinyint", &UTINYINT),
    ("u8", &UTINYINT),
    ("smallint", &SMALLINT),
    ("i16", &SMALLINT),
    ("usmallint", &USMALLINT),
    ("u16", &USMALLINT),
    ("mediumint", &MEDIUMINT),
    ("i24", &MEDIUMINT),
    ("umediumint", &UMEDIUMINT),
    ("u24", &UMEDIUMINT),
    ("int", &INT),
    ("i32", &INT),
    ("uint", &UINT),
    ("u32", &UINT),
];

#[must_use]
pub fn resolve_integer_type(name: &str) -> Option<&'static IntegerType> {
    BY_SPELLING
        .iter()
        .find(|(s, _)| *s == name)
        .map(|(_, t)| *t)
}

/// Bytes one value takes in memory: bool 1, string 2, 24-bit 4, unknown or
/// `None` 0.
#[must_use]
pub fn storage_bytes(name: Option<&str>) -> i64 {
    match name {
        Some("bool") => 1,
        Some("string") => 2,
        Some(n) => match resolve_integer_type(n) {
            Some(t) if t.bits == 24 => 4,
            Some(t) => t.bits / 8,
            None => 0,
        },
        None => 0,
    }
}
