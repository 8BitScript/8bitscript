//! Port of packages/compiler/src/resolver/import-aliases.mjs:1-83

use diagnostics::is_source_file;
use indexmap::IndexMap;
use jsnum::{is_js_whitespace, object_key_order};
use serde::Deserialize;
use serde_json::Value;

use crate::posix;

/// `ALIAS_PREFIX` = `/^@[^/\s]+$/`: a single-segment @-prefix.
fn is_alias_prefix(prefix: &str) -> bool {
    let Some(rest) = prefix.strip_prefix('@') else {
        return false;
    };
    !rest.is_empty() && rest.chars().all(|c| c != '/' && !is_js_whitespace(c))
}

/// A config `imports` value that is present: `null`, an object with its keys in document order, or anything else.
///
/// `serde_json::Value` objects lose key order here (no `preserve_order`), so the object arm holds an
/// [`IndexMap`], which `serde_json` fills in the order the keys appear in the text.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum ConfigImports {
    Null(()),
    Object(IndexMap<String, Value>),
    Other(Value),
}

/// Turn a config `imports` value into absolute directory paths. `None` is `undefined`.
///
/// Entries are visited in insertion order, then `object_key_order` (integer-like keys first) is
/// applied on top, as `Object.entries` would.
///
/// # Errors
/// The JS error text when the shape is wrong, a prefix is malformed, or a directory is not relative.
pub fn resolve_import_aliases(
    imports: Option<&ConfigImports>,
    project_dir: &str,
) -> Result<IndexMap<String, String>, String> {
    match imports {
        None | Some(ConfigImports::Null(())) => Ok(IndexMap::new()),
        Some(ConfigImports::Object(map)) => {
            let entries: Vec<(String, Value)> =
                map.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            resolve_import_alias_entries(&entries, project_dir)
        }
        Some(ConfigImports::Other(_)) => Err(
            "8bitscript.config.ts's imports must be an object of @prefix \u{2192} directory path"
                .to_string(),
        ),
    }
}

/// `resolveImportAliases` over an object's entries in the caller's insertion order.
///
/// # Errors
/// As [`resolve_import_aliases`].
pub fn resolve_import_alias_entries(
    entries: &[(String, Value)],
    project_dir: &str,
) -> Result<IndexMap<String, String>, String> {
    let keys: Vec<&str> = entries.iter().map(|(k, _)| k.as_str()).collect();
    let mut import_aliases = IndexMap::new();
    for index in object_key_order(&keys) {
        let (prefix, rel) = &entries[index];
        if !is_alias_prefix(prefix) {
            return Err(format!(
                "8bitscript.config.ts's imports key {} must be a single @-prefix with no / (e.g. '@lib')",
                serde_json::to_string(prefix).unwrap_or_default()
            ));
        }
        let rel = match rel {
            Value::String(s) if !s.is_empty() && !s.starts_with('/') && !s.contains("..") => s,
            _ => {
                return Err(format!(
                    "8bitscript.config.ts's imports.{prefix} must be a relative directory path without .."
                ));
            }
        };
        import_aliases.insert(prefix.clone(), posix::resolve(project_dir, rel));
    }
    Ok(import_aliases)
}

/// `isPathForm`: the last segment is an identifier (`/^[A-Za-z_][A-Za-z0-9_]*$/`).
#[must_use]
pub fn is_path_form(specifier: &str) -> bool {
    let last = specifier.rsplit('/').next().unwrap_or(specifier);
    let mut bytes = last.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The longest configured prefix `specifier` starts with (`@lib/...`), if any.
#[must_use]
pub fn longest_alias_prefix<'a>(
    specifier: &str,
    import_aliases: &'a IndexMap<String, String>,
) -> Option<&'a str> {
    let mut best: Option<&str> = None;
    let mut best_len = 0;
    for prefix in import_aliases.keys() {
        let needle = format!("{prefix}/");
        // `prefix.length` counts UTF-16 units.
        let len = jsnum::utf16_len(prefix);
        if specifier.starts_with(&needle) && len > best_len {
            best = Some(prefix);
            best_len = len;
        }
    }
    best
}

/// The relative path after an alias prefix, or `None` when it names neither a source file nor (path form) a module.
#[must_use]
pub fn aliased_subpath(specifier: &str, prefix: &str, path_form: bool) -> Option<String> {
    // `slice(prefix.length + 1)` counts UTF-16 units.
    let skip = jsnum::utf16_len(prefix) + 1;
    let mut seen = 0;
    let mut cut = specifier.len();
    for (i, c) in specifier.char_indices() {
        if seen >= skip {
            cut = i;
            break;
        }
        seen += c.len_utf16();
    }
    let rest = if seen >= skip { &specifier[cut..] } else { "" };
    (is_source_file(rest) || (path_form && is_path_form(rest))).then(|| rest.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_entries_keep_document_order() {
        // JS reports the first bad entry in insertion order: "bad", not "@a" (sorted order).
        let imports: ConfigImports = serde_json::from_str(r#"{"bad":"x","@a":".."}"#).unwrap();
        let error = resolve_import_aliases(Some(&imports), "/p").unwrap_err();
        assert_eq!(
            error,
            "8bitscript.config.ts's imports key \"bad\" must be a single @-prefix with no / (e.g. '@lib')"
        );
    }

    #[test]
    fn shapes_parse() {
        let null: ConfigImports = serde_json::from_str("null").unwrap();
        assert_eq!(null, ConfigImports::Null(()));
        let other: ConfigImports = serde_json::from_str("[1]").unwrap();
        assert!(resolve_import_aliases(Some(&other), "/p").is_err());
    }
}
