//! Tap replay for `check` (`packages/compiler/src/checker/index.mjs:239`).
//!
//! `args` is `[ast, file, source?, options?]` (the tree as plain JSON), `result` the diagnostics.

use front_replay::{Replay, compare};
use serde_json::{Value, json};
use syntax::{Node, number_nodes};

use crate::checker::{CheckOptions, check};

#[must_use]
pub fn replay(record: &Value) -> Replay {
    let Some(args) = record.get("args").and_then(Value::as_array) else {
        return Replay::Skip;
    };
    if record.get("throw").is_some() {
        return Replay::Skip;
    }
    let mut ast: Option<Node> = match args.first() {
        None | Some(Value::Null) => None,
        Some(value) => match serde_json::from_value(value.clone()) {
            Ok(ast) => Some(ast),
            Err(error) => {
                return Replay::Mismatch("/args/0".into(), value.clone(), json!(error.to_string()));
            }
        },
    };
    if let Some(ast) = ast.as_mut() {
        number_nodes(ast);
    }
    let file = args.get(1).and_then(Value::as_str).unwrap_or("<unknown>");
    let source = args.get(2).and_then(Value::as_str);
    let options = CheckOptions {
        skip_screen_text: args
            .get(3)
            .and_then(|o| o.get("skipScreenText"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    let got =
        serde_json::to_value(check(ast.as_ref(), file, source, options)).unwrap_or(Value::Null);
    compare(record.get("result").unwrap_or(&Value::Null), &got)
}
