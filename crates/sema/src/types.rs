//! Port of packages/compiler/src/types/index.mjs:1-137
//!
//! The primitive integer type registry: one description of `utinyint`/`u8` and their siblings.

use std::sync::LazyLock;

use indexmap::IndexMap;

/// One primitive integer type (`IntegerType` in the JS JSDoc).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegerType {
    /// Preferred spelling, also the id every compiler stage stores internally.
    pub canonical_name: String,
    /// The short systems-programming spelling (`u8`).
    pub legacy_alias: String,
    /// Every spelling other than the canonical one.
    pub aliases: Vec<String>,
    pub signed: bool,
    pub bits: u32,
    pub bytes: u32,
    /// Inclusive.
    pub min: i64,
    /// Inclusive.
    pub max: i64,
    pub summary: String,
}

/// Signed base name by bit width; the unsigned spelling is always `u` + this.
fn width_name(bits: u32) -> &'static str {
    match bits {
        8 => "tinyint",
        16 => "smallint",
        24 => "mediumint",
        _ => "int",
    }
}

fn make_integer_type(bits: u32, signed: bool) -> IntegerType {
    let range = 1i64 << bits;
    let bytes = bits / 8;
    let base = width_name(bits);
    let canonical_name = if signed {
        base.to_string()
    } else {
        format!("u{base}")
    };
    let legacy_alias = format!("{}{bits}", if signed { 'i' } else { 'u' });
    IntegerType {
        canonical_name,
        aliases: vec![legacy_alias.clone()],
        legacy_alias,
        signed,
        bits,
        bytes,
        min: if signed { -(range / 2) } else { 0 },
        max: if signed { range / 2 - 1 } else { range - 1 },
        summary: format!(
            "{} {bytes}-byte integer.",
            if signed { "Signed" } else { "Unsigned" }
        ),
    }
}

/// Every canonical primitive integer type, narrowest first and signed before unsigned within a
/// width: tinyint, utinyint, smallint, usmallint, mediumint, umediumint, int, uint.
pub static PRIMITIVE_INTEGER_TYPES: LazyLock<Vec<IntegerType>> = LazyLock::new(|| {
    [8, 16, 24, 32]
        .into_iter()
        .flat_map(|bits| {
            [
                make_integer_type(bits, true),
                make_integer_type(bits, false),
            ]
        })
        .collect()
});

/// `BY_SPELLING`: every spelling to an index into [`PRIMITIVE_INTEGER_TYPES`], in insertion order.
static BY_SPELLING: LazyLock<IndexMap<String, usize>> = LazyLock::new(|| {
    let mut map = IndexMap::new();
    for (i, ty) in PRIMITIVE_INTEGER_TYPES.iter().enumerate() {
        map.insert(ty.canonical_name.clone(), i);
        for alias in &ty.aliases {
            map.insert(alias.clone(), i);
        }
    }
    map
});

/// Bytes one value of a type takes in the target's memory. The 24-bit types widen to 4 bytes;
/// `bool` is a byte; a `string` is a 2-byte pointer. 0 for a name that is none of them.
#[must_use]
pub fn storage_bytes(name: &str) -> u32 {
    if name == "bool" {
        return 1;
    }
    if name == "string" {
        return 2;
    }
    let Some(ty) = resolve_integer_type(name) else {
        return 0;
    };
    if ty.bits == 24 { 4 } else { ty.bits / 8 }
}

/// Every spelling a primitive integer type can be written with, canonical or alias.
pub static INTEGER_TYPE_NAMES: LazyLock<Vec<String>> =
    LazyLock::new(|| BY_SPELLING.keys().cloned().collect());

/// Resolve any spelling, canonical (`utinyint`) or legacy alias (`u8`), to its descriptor.
#[must_use]
pub fn resolve_integer_type(name: &str) -> Option<&'static IntegerType> {
    BY_SPELLING.get(name).map(|&i| &PRIMITIVE_INTEGER_TYPES[i])
}

/// Inclusive `[min, max]` ranges, keyed by every recognized spelling.
pub static INTEGER_RANGES: LazyLock<IndexMap<String, [i64; 2]>> = LazyLock::new(|| {
    INTEGER_TYPE_NAMES
        .iter()
        .filter_map(|name| resolve_integer_type(name).map(|ty| (name.clone(), [ty.min, ty.max])))
        .collect()
});

/// The narrowest primitive integer type a value fits in: unsigned from utinyint upward for a
/// non-negative value, signed from tinyint upward for a negative one.
#[must_use]
pub fn narrowest_integer_type(value: f64) -> String {
    // `value < 0` is false for NaN, like JS.
    let negative = value < 0.0;
    let fit = PRIMITIVE_INTEGER_TYPES
        .iter()
        .filter(|t| t.signed == negative)
        .find(|t| value >= t.min as f64 && value <= t.max as f64);
    match fit {
        Some(t) => t.canonical_name.clone(),
        None => (if negative { "int" } else { "uint" }).to_string(),
    }
}
