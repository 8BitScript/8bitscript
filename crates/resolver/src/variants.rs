//! Port of packages/compiler/src/resolver/index.mjs:1-451 (variants)

use std::fs;
use std::path::Path;

use diagnostics::codes;
use diagnostics::{
    SOURCE_EXTENSIONS, is_locale_name, is_source_file, source_kind_of, strip_source_extension,
};
use jsnum::cmp_utf16;
use serde_json::{Value, json};

use crate::posix::{basename, dirname};

/// Every machine a program can be built for (`index.mjs:44`, re-exported from `source`).
pub use diagnostics::MACHINES;

/// The machines this release builds for (`index.mjs:60`).
pub const RELEASE_MACHINES: [&str; 5] = ["pet", "c64", "vic20", "cx16", "web"];

/// Whether a machine is one this release builds for (`index.mjs:65`).
#[must_use]
pub fn is_release_machine(machine: &str) -> bool {
    RELEASE_MACHINES.contains(&machine)
}

/// The resolver options this unit reads: `machine`, `tags`, `profile`, `locale`, `pathForm`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Options {
    pub machine: Option<String>,
    /// `Some` is the `Array.isArray(options.tags)` case.
    pub tags: Option<Vec<String>>,
    pub profile: Option<String>,
    pub locale: Option<String>,
    pub path_form: bool,
}

/// A non-empty string, the JS truthiness of an optional string.
fn truthy(s: Option<&str>) -> Option<&str> {
    s.filter(|v| !v.is_empty())
}

/// `variantOf` (`index.mjs:90`): the machine, tag and locale slotted in before the extension.
#[must_use]
pub fn variant_of(
    path: &str,
    machine: Option<&str>,
    tag: Option<&str>,
    locale: Option<&str>,
) -> String {
    let ext = source_kind_of(path).map_or(".8bs", |k| k.as_str());
    let stem = strip_source_extension(path);
    let parts: Vec<&str> = [machine, tag, locale].into_iter().flatten().collect();
    format!("{stem}.{}{ext}", parts.join("."))
}

/// `tagsOf` (`index.mjs:100`).
#[must_use]
pub fn tags_of(options: &Options) -> Vec<String> {
    if let Some(tags) = &options.tags {
        return tags.clone();
    }
    match truthy(options.profile.as_deref()) {
        Some(profile) => vec![profile.to_string()],
        None => Vec::new(),
    }
}

/// `isVariantPath` (`index.mjs:116`).
#[must_use]
pub fn is_variant_path(path: &str, locale: Option<&str>) -> bool {
    if source_kind_of(path).is_none() {
        return false;
    }
    let stem = strip_source_extension(path);
    if let Some(locale) = truthy(locale)
        && stem.ends_with(&format!(".{locale}"))
    {
        return true;
    }
    is_variant_stem(stem)
}

/// Whether `word` is one tag word: `[A-Za-z0-9_-]+`.
fn is_word(word: &str) -> bool {
    !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `stem` ends in `.<machine>` or `.<machine>.<word>`.
fn stem_has_machine(stem: &str, machine: &str) -> bool {
    if stem.ends_with(&format!(".{machine}")) {
        return true;
    }
    let needle = format!(".{machine}.");
    // `\.machine\.[A-Za-z0-9_-]+$`: some occurrence of the needle is followed by one word to the end.
    stem.match_indices(&needle)
        .any(|(i, _)| is_word(&stem[i + needle.len()..]))
}

fn is_variant_stem(stem: &str) -> bool {
    MACHINES
        .iter()
        .any(|machine| stem_has_machine(stem, machine))
}

/// `machineOfVariant` (`index.mjs:140`).
#[must_use]
pub fn machine_of_variant(path: &str) -> Option<&'static str> {
    source_kind_of(path)?;
    let stem = strip_source_extension(path);
    MACHINES
        .iter()
        .copied()
        .find(|machine| stem_has_machine(stem, machine))
}

/// One twin found beside a path (`index.mjs:150`): each field present only where the name carries it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Variant {
    pub machine: Option<String>,
    pub tag: Option<String>,
    pub locale: Option<String>,
}

impl Variant {
    /// The JS record `{ machine?, tag?, locale? }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        if let Some(m) = &self.machine {
            map.insert("machine".into(), json!(m));
        }
        if let Some(t) = &self.tag {
            map.insert("tag".into(), json!(t));
        }
        if let Some(l) = &self.locale {
            map.insert("locale".into(), json!(l));
        }
        Value::Object(map)
    }
}

/// `variantsPresent` (`index.mjs:172`): every twin of `path` that exists beside it.
#[must_use]
pub fn variants_present(path: &str) -> Vec<Variant> {
    let ext = source_kind_of(path).map_or(".8bs", |k| k.as_str());
    let stem = basename(strip_source_extension(path));
    let Ok(read) = fs::read_dir(dirname(path)) else {
        return Vec::new();
    };
    let mut entries: Vec<String> = read
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    // Ordinal (UTF-16 code unit) order, not the filesystem's.
    entries.sort_by(|a, b| cmp_utf16(a, b));
    let mut found = Vec::new();
    for entry in &entries {
        if !entry.starts_with(&format!("{stem}.")) || !entry.ends_with(ext) {
            continue;
        }
        let from = stem.len() + 1;
        let to = entry.len() - ext.len();
        let middle = if from <= to { &entry[from..to] } else { "" };
        let suffix: Vec<&str> = middle.split('.').collect();
        if !MACHINES.contains(&suffix[0]) {
            if suffix.len() == 1 && is_locale_name(suffix[0]) {
                found.push(Variant {
                    locale: Some(suffix[0].into()),
                    ..Variant::default()
                });
            }
            continue;
        }
        if suffix.len() == 1 {
            found.push(Variant {
                machine: Some(suffix[0].into()),
                ..Variant::default()
            });
        } else if suffix.len() == 2 && is_word(suffix[1]) {
            found.push(Variant {
                machine: Some(suffix[0].into()),
                tag: Some(suffix[1].into()),
                locale: None,
            });
        } else if suffix.len() == 3 && is_word(suffix[1]) && is_locale_name(suffix[2]) {
            found.push(Variant {
                machine: Some(suffix[0].into()),
                tag: Some(suffix[1].into()),
                locale: Some(suffix[2].into()),
            });
        }
    }
    found
}

/// `describeVariant` (`index.mjs:204`).
fn describe_variant(v: &Variant) -> String {
    let Some(machine) = &v.machine else {
        return format!("locale {}", v.locale.as_deref().unwrap_or("undefined"));
    };
    let inner: Vec<&str> = [v.tag.as_deref(), v.locale.as_deref()]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect();
    if inner.is_empty() {
        machine.clone()
    } else {
        format!("{machine} ({})", inner.join(", "))
    }
}

/// A diagnostic-shaped warning that rides along with a chosen path.
#[derive(Debug, Clone, PartialEq)]
pub struct Warning {
    pub code: &'static str,
    pub message: String,
}

/// What `chooseVariant` / `chooseModule` return, apart from `null`.
#[derive(Debug, Clone, PartialEq)]
pub enum Chosen {
    /// `{ path }`
    Path(String),
    /// `{ path: null }`: valid, and target-dependent.
    TargetDependent,
    /// `{ path, warning }`
    Warned { path: String, warning: Warning },
    /// `{ code, message }`
    Failed { code: &'static str, message: String },
}

impl Chosen {
    /// The JS record.
    #[must_use]
    pub fn to_json(&self) -> Value {
        match self {
            Chosen::Path(path) => json!({ "path": path }),
            Chosen::TargetDependent => json!({ "path": null }),
            Chosen::Warned { path, warning } => json!({
                "path": path,
                "warning": { "code": warning.code, "message": warning.message },
            }),
            Chosen::Failed { code, message } => json!({ "code": code, "message": message }),
        }
    }
}

fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// `chooseVariant` (`index.mjs:262`): the file a `.8bs` path actually means for the build.
#[must_use]
pub fn choose_variant(
    specifier: &str,
    path: &str,
    machine: Option<&str>,
    tags: &[String],
    locale: Option<&str>,
) -> Option<Chosen> {
    let machine = truthy(machine);
    let locale = truthy(locale);
    let base = exists(path);
    if is_variant_path(path, locale) {
        return base.then(|| Chosen::Path(path.to_string()));
    }
    // The two spellings of one level: with the locale, and without.
    let localized =
        |m: Option<&str>, t: Option<&str>| locale.map(|l| variant_of(path, m, t, Some(l)));
    let present = |m: Option<&str>, t: Option<&str>| {
        exists(&variant_of(path, m, t, None)) || localized(m, t).is_some_and(|p| exists(&p))
    };
    let pick = |m: Option<&str>, t: Option<&str>| {
        let plain = variant_of(path, m, t, None);
        match localized(m, t) {
            Some(with_locale) if exists(&with_locale) => with_locale,
            _ => plain,
        }
    };
    if let Some(machine) = machine {
        let for_tags: Vec<&String> = tags
            .iter()
            .filter(|tag| present(Some(machine), Some(tag)))
            .collect();
        if for_tags.len() > 1 {
            let names: Vec<&str> = for_tags.iter().map(|s| s.as_str()).collect();
            return Some(Chosen::Failed {
                code: codes::AMBIGUOUS_VARIANT,
                message: format!(
                    "'{specifier}' has a version for each of this build's '{}' hardware — one file cannot serve two tags at once; give the build one of them, or one file both",
                    names.join("' and '")
                ),
            });
        }
        if for_tags.len() == 1 {
            return Some(Chosen::Path(pick(Some(machine), Some(for_tags[0]))));
        }
        if present(Some(machine), None) {
            let chosen = pick(Some(machine), None);
            let plain_locale = localized(None, None);
            if let (Some(locale), Some(plain_locale)) = (locale, &plain_locale)
                && chosen == variant_of(path, Some(machine), None, None)
                && exists(plain_locale)
            {
                let with_machine = localized(Some(machine), None).unwrap_or_default();
                return Some(Chosen::Warned {
                    warning: Warning {
                        code: codes::LOCALE_FALLBACK,
                        message: format!(
                            "'{specifier}' has no '{locale}' version for the {machine} — {} is used, not {}; add {} to translate it",
                            basename(&chosen),
                            basename(plain_locale),
                            basename(&with_machine)
                        ),
                    },
                    path: chosen,
                });
            }
            return Some(Chosen::Path(chosen));
        }
        if let Some(p) = localized(None, None)
            && exists(&p)
        {
            return Some(Chosen::Path(p));
        }
        if base {
            return Some(Chosen::Path(path.to_string()));
        }
        let others = variants_present(path);
        if !others.is_empty() {
            let mut names: Vec<String> = Vec::new();
            for v in &others {
                let d = describe_variant(v);
                if !names.contains(&d) {
                    names.push(d);
                }
            }
            let here = if tags.is_empty() {
                format!("{machine} target")
            } else {
                format!("{machine} target's {} hardware", tags.join(", "))
            };
            let in_locale = locale.map_or(String::new(), |l| format!(" in locale {l}"));
            return Some(Chosen::Failed {
                code: codes::NOT_ON_THIS_TARGET,
                message: format!(
                    "'{specifier}' has no version for the {here}{in_locale} (targets: {})",
                    names.join(", ")
                ),
            });
        }
        return None;
    }
    if let Some(p) = localized(None, None)
        && exists(&p)
    {
        return Some(Chosen::Path(p));
    }
    if base {
        return Some(Chosen::Path(path.to_string()));
    }
    if !variants_present(path).is_empty() {
        return Some(Chosen::TargetDependent);
    }
    None
}

/// `chooseModule` (`index.mjs:323`): the file a relative or alias specifier means.
#[must_use]
pub fn choose_module(specifier: &str, target: &str, options: &Options) -> Option<Chosen> {
    let tags = tags_of(options);
    let machine = options.machine.as_deref();
    let locale = options.locale.as_deref();
    if !options.path_form || is_source_file(target) {
        return choose_variant(specifier, target, machine, &tags, locale);
    }
    let mut hits: Vec<(&str, Chosen)> = Vec::new();
    for ext in SOURCE_EXTENSIONS {
        if let Some(chosen) =
            choose_variant(specifier, &format!("{target}{ext}"), machine, &tags, locale)
        {
            hits.push((ext, chosen));
        }
    }
    if hits.len() < 2 {
        let folded = folded_extensions(target);
        if folded.len() < 2 {
            return hits.into_iter().next().map(|(_, chosen)| chosen);
        }
        return Some(ambiguous(specifier, target, &folded));
    }
    let exts: Vec<&str> = hits.iter().map(|(ext, _)| *ext).collect();
    Some(ambiguous(specifier, target, &exts))
}

fn ascii_lower(s: &str) -> String {
    s.to_ascii_lowercase()
}

/// `foldedExtensions` (`index.mjs:297`): the source extensions that name a file beside `target` once
/// case is folded (a read of the directory, so it sees `Mark.8bx` for `./mark` on any file system).
fn folded_extensions(target: &str) -> Vec<&'static str> {
    let dir = dirname(target);
    let name = basename(target);
    let fold = ascii_lower(name);
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let prefix = format!("{fold}.");
    let mut stems: Vec<String> = Vec::new();
    for entry in read.filter_map(Result::ok) {
        let e = entry.file_name().to_string_lossy().into_owned();
        if ascii_lower(&e).starts_with(&prefix) {
            // ASCII lowering keeps byte length, so the slice is on a char boundary.
            let stem = e[..name.len()].to_string();
            if !stems.contains(&stem) {
                stems.push(stem);
            }
        }
    }
    SOURCE_EXTENSIONS
        .iter()
        .copied()
        .filter(|ext| {
            stems.iter().any(|stem| {
                let sep = if dir.ends_with('/') { "" } else { "/" };
                let file = format!("{dir}{sep}{stem}{ext}");
                exists(&file) || !variants_present(&file).is_empty()
            })
        })
        .collect()
}

fn ambiguous(specifier: &str, target: &str, exts: &[&str]) -> Chosen {
    let names: Vec<String> = exts
        .iter()
        .map(|ext| format!("{}{ext}", basename(target)))
        .collect();
    Chosen::Failed {
        code: codes::AMBIGUOUS_IMPORT,
        message: format!(
            "'{specifier}' names more than one file ({}) — keep one, or write the extension in a string path to choose",
            names.join(", ")
        ),
    }
}
