//! Tap replay for `applyCatalogCharset` (`packages/compiler/src/i18n/index.mjs:166`).
//!
//! `args` is `[ast, file, charset?]`, `result` the diagnostics, `after` the tree whose string
//! literals the call rewrote.

use front_replay::{Replay, compare};
use serde_json::{Value, json};
use syntax::{Node, number_nodes};

use crate::{DEFAULT_CHARSET, apply_catalog_charset};

#[must_use]
pub fn replay(record: &Value) -> Replay {
    if record.get("throw").is_some() {
        return Replay::Skip;
    }
    let Some(args) = record.get("args").and_then(Value::as_array) else {
        return Replay::Skip;
    };
    let Some(file) = args.get(1).and_then(Value::as_str) else {
        return Replay::Mismatch("/args/1".into(), Value::Null, json!("expected a file name"));
    };
    let mut ast: Node = match args.first().cloned().map(serde_json::from_value) {
        Some(Ok(ast)) => ast,
        Some(Err(error)) => {
            return Replay::Mismatch("/args/0".into(), Value::Null, json!(error.to_string()));
        }
        None => return Replay::Mismatch("/args".into(), Value::Null, json!("expected an AST")),
    };
    number_nodes(&mut ast);
    let charset = args
        .get(2)
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_CHARSET);
    let diagnostics = apply_catalog_charset(&mut ast, file, charset);
    let after = serde_json::to_value(&ast).unwrap_or(Value::Null);
    match compare(record.get("after").unwrap_or(&Value::Null), &after) {
        Replay::Match => {
            let result = serde_json::to_value(&diagnostics).unwrap_or(Value::Null);
            compare(record.get("result").unwrap_or(&Value::Null), &result)
        }
        other => other,
    }
}
