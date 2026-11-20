//! Tap replay for `resolveCatalogSpecifier` (`packages/compiler/src/i18n/index.mjs:469`).
//!
//! `args` is `[specifier, fromFile, options]`; `result` is `null` or the resolution. The
//! catalog is read from disk, so a catalog record that names the `<project>` or `<toolchain>`
//! path token replays only when `EIGHTBS_FRONT_TAP_ROOTS` (JSON `{"toolchain": dir,
//! "project": dir}`) says where those directories are now; otherwise it is skipped.

use front_replay::{Replay, compare};
use serde_json::{Value, json};

use crate::{ResolveOptions, RootedFs, resolve_catalog_specifier};

fn rooted() -> RootedFs {
    let mut fs = RootedFs::new();
    let Ok(text) = std::env::var("EIGHTBS_FRONT_TAP_ROOTS") else {
        return fs;
    };
    let Ok(roots) = serde_json::from_str::<Value>(&text) else {
        return fs;
    };
    for name in ["toolchain", "project"] {
        if let Some(dir) = roots.get(name).and_then(Value::as_str) {
            fs = fs.with(&format!("<{name}>"), dir);
        }
    }
    fs
}

#[must_use]
pub fn replay(record: &Value) -> Replay {
    if record.get("throw").is_some() {
        return Replay::Skip;
    }
    let Some(args) = record.get("args").and_then(Value::as_array) else {
        return Replay::Skip;
    };
    let Some(specifier) = args.first().and_then(Value::as_str) else {
        return Replay::Skip;
    };
    let from_file = args.get(1).and_then(Value::as_str).unwrap_or("");
    let mut options: ResolveOptions = match args.get(2) {
        None | Some(Value::Null) => ResolveOptions::default(),
        Some(value) => match serde_json::from_value(value.clone()) {
            Ok(options) => options,
            Err(error) => {
                return Replay::Mismatch("/args/2".into(), Value::Null, json!(error.to_string()));
            }
        },
    };
    let fs = rooted();
    let text = record.to_string();
    let needs_root = text.contains("<project>") || text.contains("<toolchain>");
    if specifier == crate::CATALOG_SPECIFIER && needs_root && fs.is_empty() {
        return Replay::Skip;
    }
    let got = match resolve_catalog_specifier(&fs, specifier, from_file, &mut options) {
        Ok(got) => serde_json::to_value(got).unwrap_or(Value::Null),
        Err(error) => return Replay::Mismatch("/result".into(), Value::Null, json!(error)),
    };
    compare(record.get("result").unwrap_or(&Value::Null), &got)
}
