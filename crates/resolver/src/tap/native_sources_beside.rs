//! Tap replay for `nativeSourcesBeside` (`packages/compiler/src/resolver/index.mjs:452`).
//!
//! `args` is `[file]`; `result` is `{ native }` or `{ code, message }`. The manifest is read from
//! disk, so a record that names a path token replays only when `EIGHTBS_FRONT_TAP_ROOTS` is set.

use front_replay::{Replay, compare};
use serde_json::Value;

use super::roots::{missing_root, roots, tokenize, untokenize};
use crate::package::native_sources_beside;

#[must_use]
pub fn replay(record: &Value) -> Replay {
    let roots = roots();
    if missing_root(record, &roots) {
        return Replay::Skip;
    }
    let Some(file) = record
        .get("args")
        .and_then(|a| a.get(0))
        .map(|a| untokenize(a, &roots))
    else {
        return Replay::Skip;
    };
    // R7.8 (oracle/divergences.toml): a file that is not a string makes `dirname` throw; no caller
    // produces it, and Rust's `&str` cannot hold it.
    let Some(file) = file.as_str() else {
        return Replay::Skip;
    };
    let rust = tokenize(&native_sources_beside(file).to_json(), &roots);
    if let Some(thrown) = record.get("throw") {
        // The Rust call cannot fail, so a recorded throw is a difference.
        return Replay::Mismatch("/throw".into(), thrown.clone(), rust);
    }
    compare(record.get("result").unwrap_or(&Value::Null), &rust)
}
