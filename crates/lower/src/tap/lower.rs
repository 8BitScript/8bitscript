//! Tap replay for `lower` (`packages/compiler/src/ir/index.mjs:1564`).
//!
//! `args` is `[ast, file, source?]` (the tree as plain JSON), `result` is `{ir, diagnostics}`.
//! A Map is `[[k, v], ...]` in the tap's encoding, so a namespace's `functions`, `consts` and
//! `constTypes` are written as pairs here.
//!
//! The whole result is compared: functions, bodies and calls are lowered. A record whose JS call
//! threw follows R7.11 (see `replay_throw`).

use front_replay::{Replay, compare};
use serde_json::{Value, json};
use syntax::{Node, number_nodes};

use crate::function::{Lowered, lower};
use crate::module::ModuleIr;

fn pairs<V: serde::Serialize>(map: &indexmap::IndexMap<String, V>) -> Value {
    Value::Array(
        map.iter()
            .map(|(k, v)| json!([k, serde_json::to_value(v).unwrap_or(Value::Null)]))
            .collect(),
    )
}

fn each<T: serde::Serialize>(items: &[T]) -> Value {
    serde_json::to_value(items).unwrap_or(Value::Null)
}

/// The `ir` of a `lower()` result in the tap's encoding.
#[must_use]
pub fn encode_ir(ir: &ModuleIr) -> Value {
    let namespaces: Vec<Value> = ir
        .namespaces
        .iter()
        .map(|n| {
            json!({
                "name": n.name,
                "exported": n.exported,
                "functions": pairs(&n.functions),
                "consts": pairs(&n.consts),
                "constTypes": pairs(&n.const_types),
                "start": n.start,
                "length": n.length,
            })
        })
        .collect();
    json!({
        "imports": each(&ir.imports),
        "globals": each(&ir.globals),
        "functions": each(&ir.functions),
        "namespaces": namespaces,
        "strings": each(&ir.strings),
        "consts": each(&ir.consts),
    })
}

/// `result` of `lower` in the tap's encoding.
#[must_use]
pub fn encode(lowered: &Lowered) -> Value {
    json!({
        "ir": encode_ir(&lowered.ir),
        "diagnostics": each(&lowered.diagnostics),
    })
}

/// R2.1: an IR integer past the `i64` range saturates in Rust, so the JS number is read the same
/// way before the two are compared. (A message that prints the number is not touched.)
fn saturated(value: &mut Value) {
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64()
                && f.abs() >= 9.2e18
                && !n.is_i64()
            {
                let clamped = if f < 0.0 { i64::MIN } else { i64::MAX };
                *value = Value::from(clamped);
            }
        }
        Value::Object(fields) => fields.values_mut().for_each(saturated),
        Value::Array(items) => items.iter_mut().for_each(saturated),
        _ => {}
    }
}

/// `lower` never throws here, so a record whose JS call threw can only be explained by a
/// recorded R7.8 site (R7.11): `Skip` when the Rust call went through one, `Mismatch` when not.
fn replay_throw(record: &Value, lowered: &Lowered) -> Replay {
    if lowered.skipped_unnamed_member {
        // R7.8: a namespace member declaration with no name throws in JS; the parser never
        // builds one.
        return Replay::Skip;
    }
    Replay::Mismatch(
        "/throw".into(),
        record.get("throw").cloned().unwrap_or(Value::Null),
        Value::Null,
    )
}

#[must_use]
pub fn replay(record: &Value) -> Replay {
    let Some(args) = record.get("args").and_then(Value::as_array) else {
        return Replay::Skip;
    };
    let mut ast: Node = match args.first() {
        Some(value) => match serde_json::from_value(value.clone()) {
            Ok(ast) => ast,
            Err(error) => {
                return Replay::Mismatch("/args/0".into(), value.clone(), json!(error.to_string()));
            }
        },
        None => return Replay::Skip,
    };
    number_nodes(&mut ast);
    let file = args.get(1).and_then(Value::as_str).unwrap_or("<unknown>");
    let source = args.get(2).and_then(Value::as_str);
    let lowered = lower(&ast, file, source);
    if record.get("throw").is_some() {
        return replay_throw(record, &lowered);
    }
    let mut js = record.get("result").cloned().unwrap_or(Value::Null);
    saturated(&mut js);
    let js = &js;
    let got = encode(&lowered);
    compare(js, &got)
}
