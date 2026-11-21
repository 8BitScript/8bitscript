//! Port of packages/compiler/src/resolver/index.mjs:452-700
//!
//! Packages: the native sources a file brings with it, the package lookup, a package's
//! `"8bitscript".exports` subpaths and its `entry` (a path, a delegation, or a machine-keyed object).

use std::fs;
use std::path::Path;

use diagnostics::codes;
use indexmap::{IndexMap, IndexSet};
use jsnum::object_key_order;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::posix::{dirname, resolve};
use crate::specifier::{Resolution, Resolved, SpecifierOptions, resolve_specifier};
use crate::variants::{Chosen, choose_variant, tags_of};

/// `path.join(a, b)`.
fn join(a: &str, b: &str) -> String {
    i18n::path::join(a, b)
}

fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// A parsed `package.json` value. `serde_json::Value` objects lose their key order, and the
/// order of `exports` and `entry` keys reaches messages and validation order, so this keeps it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Json {
    Null(()),
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(IndexMap<String, Json>),
}

impl Json {
    /// `value?.[key]` for a parsed JSON value: only an object has the property.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(map) => map.get(key),
            _ => None,
        }
    }

    /// JS truthiness.
    #[must_use]
    pub fn truthy(&self) -> bool {
        match self {
            Json::Null(()) => false,
            Json::Bool(b) => *b,
            Json::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
            Json::String(s) => !s.is_empty(),
            Json::Array(_) | Json::Object(_) => true,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }
}

/// `manifest?.['8bitscript']`.
#[must_use]
pub fn bitscript_of(manifest: Option<&Json>) -> Option<&Json> {
    manifest?.get("8bitscript")
}

/// `JSON.parse(readFileSync(path, 'utf8'))`, `None` when either throws.
#[must_use]
pub fn read_manifest(path: &str) -> Option<Json> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()
}

/// What `nativeSourcesBeside` and `nativeSourcesOf` answer: `{ native }` or `{ code, message }`.
#[derive(Debug, Clone, PartialEq)]
pub enum NativeSources {
    Sources(Vec<String>),
    Failed { code: &'static str, message: String },
}

impl NativeSources {
    /// The JS record.
    #[must_use]
    pub fn to_json(&self) -> Value {
        match self {
            NativeSources::Sources(native) => json!({ "native": native }),
            NativeSources::Failed { code, message } => json!({ "code": code, "message": message }),
        }
    }
}

/// The native sources a file brings with it by where it sits: the nearest package.json above it
/// and that manifest's `"8bitscript".native` list, if any (`index.mjs:452`).
#[must_use]
pub fn native_sources_beside(file: &str) -> NativeSources {
    let mut dir = dirname(file).to_string();
    loop {
        let manifest_path = join(&dir, "package.json");
        if exists(&manifest_path) {
            let Some(manifest) = read_manifest(&manifest_path) else {
                return NativeSources::Sources(Vec::new());
            };
            let name = match manifest.get("name") {
                Some(Json::String(name)) => name.clone(),
                _ => dir.clone(),
            };
            return native_sources_of(&name, &dir, Some(&manifest));
        }
        let parent = dirname(&dir).to_string();
        if parent == dir {
            return NativeSources::Sources(Vec::new());
        }
        dir = parent;
    }
}

/// A local checkout's `packages/<name>` for `@8bitscript/<name>` (`index.mjs:480`).
fn package_dir_in_checkout(checkout: &str, name: &str) -> Option<String> {
    // `/^@8bitscript\/([^/]+)$/`
    let rest = name.strip_prefix("@8bitscript/")?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    let dir = join(&join(checkout, "packages"), rest);
    exists(&join(&dir, "package.json")).then_some(dir)
}

/// Walk up from a directory looking for `node_modules/<name>` (`index.mjs:489`).
#[must_use]
pub fn find_package_dir(from_dir: &str, name: &str, checkout: Option<&str>) -> Option<String> {
    if let Some(checkout) = checkout.filter(|c| !c.is_empty())
        && let Some(local) = package_dir_in_checkout(checkout, name)
    {
        return Some(local);
    }
    let mut dir = from_dir.to_string();
    loop {
        let candidate = join(&join(&dir, "node_modules"), name);
        if exists(&join(&candidate, "package.json")) {
            return Some(candidate);
        }
        let parent = dirname(&dir).to_string();
        if parent == dir {
            return None;
        }
        dir = parent;
    }
}

/// A package's `"8bitscript".native` list, resolved to absolute paths (`index.mjs:517`).
#[must_use]
pub fn native_sources_of(
    specifier: &str,
    package_dir: &str,
    manifest: Option<&Json>,
) -> NativeSources {
    let Some(native) = bitscript_of(manifest).and_then(|b| b.get("native")) else {
        return NativeSources::Sources(Vec::new());
    };
    let Json::Array(items) = native else {
        return malformed_native(specifier);
    };
    if items.iter().any(|v| v.as_str().is_none()) {
        return malformed_native(specifier);
    }
    let mut resolved = Vec::new();
    for item in items {
        let value = item.as_str().unwrap_or_default();
        let target = resolve(package_dir, value);
        if !exists(&target) {
            return NativeSources::Failed {
                code: codes::MISSING_NATIVE_SOURCE,
                message: format!(
                    "'{specifier}' declares native source '{value}', which does not exist"
                ),
            };
        }
        resolved.push(target);
    }
    NativeSources::Sources(resolved)
}

fn malformed_native(specifier: &str) -> NativeSources {
    NativeSources::Failed {
        code: codes::NOT_AN_8BS_PACKAGE,
        message: format!(
            "'{specifier}' has a malformed \"8bitscript\".native value: expected an array of relative paths"
        ),
    }
}

/// The keys of an object in `Object.keys` order (integer-like keys first).
fn keys_in_order(map: &IndexMap<String, Json>) -> Vec<&str> {
    let keys: Vec<&str> = map.keys().map(String::as_str).collect();
    object_key_order(&keys)
        .into_iter()
        .map(|i| keys[i])
        .collect()
}

/// A package's `"8bitscript".exports` subpath (`index.mjs:553`).
///
/// # Errors
/// A throw of the JS (none reachable here), as its message.
pub fn resolve_subpath(
    specifier: &str,
    name: &str,
    package_dir: &str,
    manifest: Option<&Json>,
    subpath: &str,
    options: &SpecifierOptions,
) -> Result<Resolution, String> {
    let key = format!("./{subpath}");
    let exports = bitscript_of(manifest).and_then(|b| b.get("exports"));
    let exports_map = match exports {
        None => None,
        Some(Json::Object(map)) => Some(map),
        Some(_) => {
            return Ok(Resolution::failed(
                codes::NOT_AN_8BS_PACKAGE,
                format!(
                    "'{name}' has a malformed \"8bitscript\".exports value: expected an object of './subpath' keys to relative paths"
                ),
            ));
        }
    };
    let Some(value) = exports_map.and_then(|m| m.get(&key)) else {
        let offered: Vec<&str> = exports_map.map(keys_in_order).unwrap_or_default();
        return Ok(Resolution::failed(
            codes::NO_SUCH_SUBPATH,
            if offered.is_empty() {
                format!(
                    "'{name}' does not export '{key}': its package.json has no \"8bitscript\".exports field"
                )
            } else {
                format!(
                    "'{name}' does not export '{key}' (exports: {})",
                    offered.join(", ")
                )
            },
        ));
    };
    let Some(value) = value.as_str().filter(|v| v.starts_with('.')) else {
        return Ok(Resolution::failed(
            codes::NOT_AN_8BS_PACKAGE,
            format!(
                "'{name}' has a malformed \"8bitscript\".exports value for '{key}': expected a relative path"
            ),
        ));
    };
    let target = resolve(package_dir, value);
    let tags = tags_of(&options.base);
    let chosen = choose_variant(
        specifier,
        &target,
        options.base.machine.as_deref(),
        &tags,
        options.base.locale.as_deref(),
    );
    let Some(chosen) = chosen else {
        return Ok(Resolution::failed(
            codes::MISSING_PACKAGE_ENTRY,
            format!("'{name}' exports '{key}' as '{value}', which does not exist"),
        ));
    };
    if let Chosen::Failed { .. } = chosen {
        return Ok(Resolution::from_chosen(chosen, None));
    }
    match native_sources_of(name, package_dir, manifest) {
        NativeSources::Failed { code, message } => Ok(Resolution::failed(code, message)),
        NativeSources::Sources(native) => Ok(Resolution::from_chosen(chosen, Some(native))),
    }
}

/// One machine's entry value: a relative path, or a bare specifier delegating to another package
/// (`index.mjs:599`).
///
/// # Errors
/// A throw of the JS (`realpathSync`, or from the delegated resolution), as its message.
pub fn resolve_entry_value(
    specifier: &str,
    package_dir: &str,
    value: &Json,
    options: &mut SpecifierOptions,
    seen: &mut IndexSet<String>,
    native: &[String],
) -> Result<Resolution, String> {
    let Json::String(value) = value else {
        return Ok(Resolution::failed(
            codes::NOT_AN_8BS_PACKAGE,
            format!("'{specifier}' has a malformed \"8bitscript\".entry value"),
        ));
    };
    if value.starts_with('.') {
        let target = resolve(package_dir, value);
        if !exists(&target) {
            return Ok(Resolution::failed(
                codes::MISSING_PACKAGE_ENTRY,
                format!("'{specifier}' declares entry '{value}', which does not exist"),
            ));
        }
        return Ok(Resolution::Resolved(Resolved {
            path: Some(target),
            warning: None,
            native: Some(native.to_vec()),
        }));
    }
    if seen.contains(package_dir) {
        return Ok(Resolution::failed(
            codes::MISSING_PACKAGE_ENTRY,
            format!("'{specifier}' delegates its entry in a cycle"),
        ));
    }
    seen.insert(package_dir.to_string());
    // The delegation starts from the package's real directory, as Node's resolver would.
    let real = fs::canonicalize(package_dir).map_err(|error| {
        format!(
            "{}, realpath '{package_dir}'",
            crate::specifier::node_error_text(&error)
        )
    })?;
    let from = join(&real.to_string_lossy(), "package.json");
    let delegated = resolve_specifier(value, &from, options, seen)?;
    Ok(delegated.unwrap_or_else(|| {
        Resolution::failed(
            codes::NOT_AN_8BS_PACKAGE,
            format!(
                "'{specifier}' delegates its entry to '{value}', which is not a resolvable specifier"
            ),
        )
    }))
}

/// An entry object keyed by machine (`index.mjs:648`).
///
/// # Errors
/// As [`resolve_entry_value`].
pub fn resolve_conditional_entry(
    specifier: &str,
    package_dir: &str,
    entry: &IndexMap<String, Json>,
    options: &mut SpecifierOptions,
    seen: &mut IndexSet<String>,
    native: &[String],
) -> Result<Resolution, String> {
    let machine = options.base.machine.clone().filter(|m| !m.is_empty());
    if let Some(machine) = machine {
        let Some(value) = entry.get(&machine) else {
            return Ok(Resolution::failed(
                codes::NOT_ON_THIS_TARGET,
                format!(
                    "'{specifier}' has no entry for the {machine} target (targets: {})",
                    keys_in_order(entry).join(", ")
                ),
            ));
        };
        return resolve_entry_value(specifier, package_dir, value, options, seen, native);
    }

    for branch_machine in keys_in_order(entry) {
        let value = &entry[branch_machine];
        // `{ ...options, machine: branchMachine }` shares the options object: swap the machine in
        // and back out.
        let saved = options.base.machine.replace(branch_machine.to_string());
        let mut copy = seen.clone();
        let resolved =
            resolve_entry_value(specifier, package_dir, value, options, &mut copy, native);
        options.base.machine = saved;
        let resolved = resolved?;
        if let Some(code) = resolved.code() {
            return Ok(Resolution::failed(
                code,
                format!(
                    "for the {branch_machine} target: {}",
                    resolved.message().unwrap_or_default()
                ),
            ));
        }
    }
    // Every branch is sound, but there is no single file to name without a machine.
    Ok(Resolution::Resolved(Resolved {
        path: None,
        warning: None,
        native: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_keeps_key_order_and_truthiness() {
        let j: Json = serde_json::from_str(r#"{"b":1,"a":[],"2":"x","1":null,"s":""}"#).unwrap();
        let Json::Object(map) = &j else { panic!() };
        assert_eq!(keys_in_order(map), ["1", "2", "b", "a", "s"]);
        assert!(!j.get("1").unwrap().truthy());
        assert!(!j.get("s").unwrap().truthy());
        assert!(j.get("a").unwrap().truthy());
        assert!(j.get("none").is_none());
    }

    #[test]
    fn native_value_must_be_an_array_of_strings() {
        let j: Json = serde_json::from_str(r#"{"8bitscript":{"native":null}}"#).unwrap();
        assert!(matches!(
            native_sources_of("p", "/x", Some(&j)),
            NativeSources::Failed {
                code: "8BS2002",
                ..
            }
        ));
        let j: Json = serde_json::from_str(r#"{"8bitscript":{}}"#).unwrap();
        assert_eq!(
            native_sources_of("p", "/x", Some(&j)),
            NativeSources::Sources(Vec::new())
        );
        assert_eq!(
            native_sources_of("p", "/x", None),
            NativeSources::Sources(Vec::new())
        );
    }

    #[test]
    fn checkout_names_only_8bitscript_packages() {
        assert_eq!(package_dir_in_checkout("/c", "left-pad"), None);
        assert_eq!(package_dir_in_checkout("/c", "@8bitscript/"), None);
        assert_eq!(package_dir_in_checkout("/c", "@8bitscript/a/b"), None);
        assert_eq!(package_dir_in_checkout("/nope", "@8bitscript/c64"), None);
    }
}
