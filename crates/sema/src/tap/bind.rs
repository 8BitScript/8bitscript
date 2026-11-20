//! Tap replay for `bind` (`packages/compiler/src/binder/index.mjs:88`).
//!
//! `args` is `[ast, file]` (the tree as plain JSON), `result` the encoded `bind()` result.

use front_replay::{Replay, compare};
use serde_json::{Value, json};
use syntax::{Node, number_nodes};

use super::graph::Encoder;
use crate::binder::bind;

#[must_use]
pub fn replay(record: &Value) -> Replay {
    let Some(args) = record.get("args").and_then(Value::as_array) else {
        return Replay::Skip;
    };
    if record.get("throw").is_some() {
        return Replay::Skip;
    }
    let Some(ast) = args.first().cloned() else {
        return Replay::Skip;
    };
    let mut ast: Node = match serde_json::from_value(ast.clone()) {
        Ok(ast) => ast,
        Err(error) => return Replay::Mismatch("/args/0".into(), ast, json!(error.to_string())),
    };
    number_nodes(&mut ast);
    let file = args.get(1).and_then(Value::as_str).unwrap_or("<unknown>");
    let mut diagnostics = Vec::new();
    let modules = [bind(&ast, file, &mut diagnostics)];
    let diagnostics = serde_json::to_value(&diagnostics).unwrap_or(Value::Null);
    let got = Encoder::new(&modules).bound(0, diagnostics);
    compare(record.get("result").unwrap_or(&Value::Null), &got)
}
