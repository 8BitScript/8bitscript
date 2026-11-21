//! Tap replay for `resolveSpecifier` (`packages/compiler/src/resolver/index.mjs:702`).
//!
//! `args` is `[specifier, fromFile, options?, seen?]`; `result` is `null` or the resolution. The
//! package tree is read from disk, so a record that names the `<project>` or `<toolchain>` path
//! token replays only when `EIGHTBS_FRONT_TAP_ROOTS` says where those directories are now.
//! A record whose JS call threw replays the Rust call and compares the error text.

use front_replay::{Replay, compare};
use indexmap::IndexSet;
use serde_json::{Value, json};

use super::roots::{missing_root, roots, tokenize, untokenize};
use crate::specifier::{SpecifierOptions, resolve_specifier};

#[must_use]
pub fn replay(record: &Value) -> Replay {
    let roots = roots();
    if missing_root(record, &roots) {
        return Replay::Skip;
    }
    let Some(args) = record.get("args").and_then(Value::as_array) else {
        return Replay::Skip;
    };
    let args: Vec<Value> = args.iter().map(|a| untokenize(a, &roots)).collect();
    let Some(specifier) = args.first().and_then(Value::as_str) else {
        return Replay::Skip;
    };
    let from_file = args.get(1).and_then(Value::as_str).unwrap_or("");
    let mut options = match args.get(2) {
        None | Some(Value::Null) => SpecifierOptions::default(),
        Some(value) => match SpecifierOptions::from_json(value) {
            Ok(options) => options,
            Err(error) => {
                return Replay::Mismatch("/args/2".into(), Value::Null, json!(error));
            }
        },
    };
    let mut seen: IndexSet<String> = args
        .get(3)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let got = resolve_specifier(specifier, from_file, &mut options, &mut seen);
    if let Some(thrown) = record.get("throw") {
        return match got {
            Err(error) => compare(thrown, &tokenize(&json!(error), &roots)),
            Ok(_) => Replay::Mismatch("/throw".into(), thrown.clone(), Value::Null),
        };
    }
    let expected = record.get("result").unwrap_or(&Value::Null);
    match got {
        Ok(resolved) => {
            let rust = resolved.map_or(Value::Null, |r| r.to_json());
            compare(expected, &tokenize(&rust, &roots))
        }
        Err(error) => Replay::Mismatch("/result".into(), expected.clone(), json!(error)),
    }
}
