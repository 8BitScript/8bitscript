//! Source kinds and machine names (`source/index.mjs`).

pub use syntax::SOURCE_EXTENSIONS;
use syntax::SourceKind;

/// The first extension of `SOURCE_EXTENSIONS` that `path` ends with.
#[must_use]
pub fn source_kind_of(path: &str) -> Option<SourceKind> {
    SourceKind::ALL
        .into_iter()
        .find(|kind| path.ends_with(kind.as_str()))
}

#[must_use]
pub fn is_source_file(path: &str) -> bool {
    source_kind_of(path).is_some()
}

/// Removes a trailing source extension; a path without one is unchanged.
#[must_use]
pub fn strip_source_extension(path: &str) -> &str {
    match source_kind_of(path) {
        // Every extension is ASCII, so the cut is on a char boundary.
        Some(kind) => &path[..path.len() - kind.as_str().len()],
        None => path,
    }
}

/// Every machine and its CPU family, in the JS declaration order.
pub const CPU_FAMILY: &[(&str, &str)] = &[
    ("vic20", "mos"),
    ("c64", "mos"),
    ("pet", "mos"),
    ("c128", "mos"),
    ("atari8", "mos"),
    ("nes", "mos"),
    ("cx16", "mos"),
    ("mega65", "mos"),
    ("web", "wasm"),
    ("plus4", "mos"),
    ("oric", "mos"),
    ("apple2", "mos"),
    ("bbc", "mos"),
    ("atari5200", "mos"),
    ("lynx", "mos"),
    ("pce", "mos"),
    ("supervision", "mos"),
    ("atari2600", "mos"),
    ("atari7800", "mos"),
    ("gb", "sm83"),
    ("gbc", "sm83"),
    ("sms", "z80"),
    ("gamegear", "z80"),
    ("sg1000", "z80"),
    ("msx", "z80"),
    ("coleco", "z80"),
    ("spectrum", "z80"),
    ("cpc", "z80"),
    ("coco", "m6809"),
    ("vectrex", "m6809"),
    ("odyssey2", "i8048"),
    ("channelf", "f8"),
];

/// Every machine a program can be built for, in the JS order.
pub const MACHINES: &[&str] = &[
    "vic20",
    "c64",
    "pet",
    "c128",
    "atari8",
    "nes",
    "cx16",
    "mega65",
    "web",
    "plus4",
    "oric",
    "apple2",
    "bbc",
    "atari5200",
    "lynx",
    "pce",
    "supervision",
    "atari2600",
    "atari7800",
    "gb",
    "gbc",
    "sms",
    "gamegear",
    "sg1000",
    "msx",
    "coleco",
    "spectrum",
    "cpc",
    "coco",
    "vectrex",
    "odyssey2",
    "channelf",
];

/// `cpuFamily(machine)`: `"mos"` for a name the table does not list.
#[must_use]
pub fn cpu_family(machine: &str) -> &'static str {
    CPU_FAMILY
        .iter()
        .find(|(name, _)| *name == machine)
        .map_or("mos", |(_, family)| family)
}

/// `LOCALE_NAME` = `/^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/`.
fn matches_locale_shape(name: &str) -> bool {
    let (lang, region) = match name.split_once('-') {
        Some((lang, region)) => (lang, Some(region)),
        None => (name, None),
    };
    let lang_ok = (2..=8).contains(&lang.len()) && lang.bytes().all(|b| b.is_ascii_lowercase());
    let region_ok = region.is_none_or(|r| {
        (2..=8).contains(&r.len())
            && r.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    });
    lang_ok && region_ok
}

/// Whether `name` could be a locale: the `LOCALE_NAME` shape, and not a machine.
#[must_use]
pub fn is_locale_name(name: &str) -> bool {
    matches_locale_shape(name) && !MACHINES.contains(&name)
}
