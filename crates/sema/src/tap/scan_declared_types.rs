//! Tap replay for `scanDeclaredTypes` (`packages/compiler/src/templates/index.mjs:115`).
//!
//! `args` is `[ast]` (the tree as plain JSON), `result` the four maps as `[[name, value], ...]`.

use front_replay::{Replay, compare};
use serde_json::{Value, json};
use syntax::{Node, number_nodes};

use super::graph::number;
use crate::templates::{DeclaredTypes, scan_declared_types};

fn pairs<V>(map: &indexmap::IndexMap<String, V>, value: impl Fn(&V) -> Value) -> Value {
    Value::Array(map.iter().map(|(k, v)| json!([k, value(v)])).collect())
}

/// `result` of `scanDeclaredTypes` in the tap's encoding.
#[must_use]
pub fn encode(declared: &DeclaredTypes) -> Value {
    json!({
        "globalTypes": pairs(&declared.global_types, |t| json!(t)),
        "functionTypes": pairs(&declared.function_types, |t| json!(t)),
        "arrayTypes": pairs(&declared.array_types, |a| json!({
            "type": a.type_,
            "length": number(a.length),
            "constant": a.constant,
        })),
        "functionArity": pairs(&declared.function_arity, |a| json!({
            "max": a.max,
            "min": a.min,
        })),
    })
}

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
    let got = encode(&scan_declared_types(ast.as_ref()));
    compare(record.get("result").unwrap_or(&Value::Null), &got)
}
