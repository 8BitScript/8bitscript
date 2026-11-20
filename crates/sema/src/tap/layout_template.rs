//! Tap replay for `layoutTemplate` (`packages/compiler/src/templates/index.mjs:250`).
//!
//! `args` is `[template, scope, file, source?]`; `result` is `{pieces, diagnostics}`, each piece
//! holding its `TemplateText`/`TemplateField` node as `{"$node": n}` in the template's numbering.

use front_replay::{Replay, compare};
use indexmap::IndexMap;
use serde_json::{Value, json};
use syntax::{Node, number_nodes};

use super::graph::{node_ref, number};
use crate::templates::{ArrayInfo, Layout, Piece, TypeScope, layout_template};

fn string_map(value: Option<&Value>) -> IndexMap<String, String> {
    let mut out = IndexMap::new();
    for pair in value.and_then(Value::as_array).into_iter().flatten() {
        if let (Some(k), Some(v)) = (
            pair.get(0).and_then(Value::as_str),
            pair.get(1).and_then(Value::as_str),
        ) {
            out.insert(k.to_string(), v.to_string());
        }
    }
    out
}

fn static_name(name: &str) -> Option<&'static str> {
    crate::templates::resolve_scalar_type(name, true, true)
}

/// The tapped scope object (`Map`s as `[[k, v], ...]`) as a [`TypeScope`].
#[must_use]
pub fn decode_scope(scope: &Value) -> TypeScope {
    let mut array_types = IndexMap::new();
    for pair in scope
        .get("arrayTypes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let (Some(name), Some(info)) = (pair.get(0).and_then(Value::as_str), pair.get(1)) else {
            continue;
        };
        let Some(type_) = info
            .get("type")
            .and_then(Value::as_str)
            .and_then(static_name)
        else {
            continue;
        };
        array_types.insert(
            name.to_string(),
            ArrayInfo {
                type_,
                length: info
                    .get("length")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::NAN),
                constant: info
                    .get("constant")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            },
        );
    }
    TypeScope {
        param_types: string_map(scope.get("paramTypes")),
        global_types: string_map(scope.get("globalTypes")),
        function_types: string_map(scope.get("functionTypes")),
        array_types,
    }
}

/// `result` of `layoutTemplate` in the tap's encoding.
#[must_use]
pub fn encode(layout: &Layout) -> Value {
    let pieces: Vec<Value> = layout
        .pieces
        .iter()
        .map(|piece| match piece {
            Piece::Text { offset, node } => json!({
                "kind": "text", "offset": number(f64::from(*offset)), "node": node_ref(node.id),
            }),
            Piece::Field {
                offset,
                width,
                node,
            } => json!({
                "kind": "field", "offset": number(f64::from(*offset)),
                "width": number(f64::from(*width)), "node": node_ref(node.id),
            }),
        })
        .collect();
    json!({
        "pieces": pieces,
        "diagnostics": serde_json::to_value(&layout.diagnostics).unwrap_or(Value::Null),
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
    let Some(template) = args.first() else {
        return Replay::Skip;
    };
    let mut template: Node = match serde_json::from_value(template.clone()) {
        Ok(node) => node,
        Err(error) => {
            return Replay::Mismatch("/args/0".into(), template.clone(), json!(error.to_string()));
        }
    };
    number_nodes(&mut template);
    let scope = decode_scope(args.get(1).unwrap_or(&Value::Null));
    let file = args.get(2).and_then(Value::as_str).unwrap_or("");
    let source = args.get(3).and_then(Value::as_str);
    let got = encode(&layout_template(&template, &scope, file, source));
    compare(record.get("result").unwrap_or(&Value::Null), &got)
}
