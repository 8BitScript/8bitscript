//! Replays `fixtures/templates.json` (made by `gen/templates.mjs` in Node). `scanDeclaredTypes`
//! and `layoutTemplate` rows are front tap records and go through the tap replays; the other
//! rows are plain `{fn, args, result}`.

use std::collections::BTreeMap;

use front_replay::{Replay, compare};
use indexmap::IndexMap;
use sema::tap::graph::number;
use sema::tap::layout_template::decode_scope;
use sema::tap::{layout_template, scan_declared_types};
use sema::templates::{
    COMPARISON_OPERATORS, MAX_ARRAY_LENGTH, MAX_STRING_LENGTH, digits_for, infer_type,
    is_template_call, misplaced_template, parameter_types, resolve_array_type, resolve_scalar_type,
    type_for_count, wider_of,
};
use serde_json::{Value, json};
use syntax::{Node, number_nodes};

fn rows() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/templates.json")).unwrap()
}

fn node(value: &Value) -> Option<Node> {
    if value.is_null() {
        return None;
    }
    let mut node: Node = serde_json::from_value(value.clone()).unwrap();
    number_nodes(&mut node);
    Some(node)
}

fn text(value: &Value) -> Option<&str> {
    value.as_str()
}

fn pairs(map: &IndexMap<String, String>) -> Value {
    Value::Array(map.iter().map(|(k, v)| json!([k, v])).collect())
}

fn consts(value: Option<&Value>) -> IndexMap<String, f64> {
    let mut out = IndexMap::new();
    for pair in value.and_then(Value::as_array).into_iter().flatten() {
        out.insert(
            pair[0].as_str().unwrap().to_string(),
            pair[1].as_f64().unwrap(),
        );
    }
    out
}

fn run(name: &str, row: &Value) -> Value {
    let args = row["args"].as_array().unwrap();
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    match name {
        "MAX_STRING_LENGTH" => json!(MAX_STRING_LENGTH),
        "MAX_ARRAY_LENGTH" => json!(MAX_ARRAY_LENGTH),
        "COMPARISON_OPERATORS" => json!(COMPARISON_OPERATORS),
        "resolveScalarType" => {
            let option = |key: &str| arg(1).get(key).and_then(Value::as_bool).unwrap_or(false);
            json!(resolve_scalar_type(
                arg(0).as_str().unwrap(),
                option("allowVoid"),
                option("allowString"),
            ))
        }
        "digitsFor" => json!(digits_for(arg(0).as_str().unwrap())),
        "widerOf" => json!(wider_of(text(arg(0)), text(arg(1)))),
        "typeForCount" => json!(type_for_count(arg(0).as_f64().unwrap())),
        "resolveArrayType" => {
            let annotation = node(arg(0));
            match resolve_array_type(annotation.as_ref(), &consts(args.get(1))) {
                Ok(array) => json!({ "type": array.type_, "length": number(array.length) }),
                Err(error) => json!({ "error": error }),
            }
        }
        "parameterTypes" => pairs(&parameter_types(&node(arg(0)).unwrap())),
        "inferType" => {
            let expression = node(arg(0)).unwrap();
            let scope = decode_scope(arg(1));
            json!(infer_type(&expression, &scope))
        }
        "isTemplateCall" => json!(is_template_call(node(arg(0)).as_ref())),
        "misplacedTemplate" => {
            let template = node(arg(0)).unwrap();
            let file = arg(1).as_str().unwrap();
            serde_json::to_value(misplaced_template(&template, file, text(arg(2)))).unwrap()
        }
        other => panic!("unknown fn {other}"),
    }
}

#[test]
fn templates_match_js() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for row in rows() {
        let name = row["fn"].as_str().unwrap().to_string();
        let outcome = match name.as_str() {
            "scanDeclaredTypes" => scan_declared_types::replay(&row),
            "layoutTemplate" => layout_template::replay(&row),
            _ => compare(&row["result"], &run(&name, &row)),
        };
        assert_eq!(outcome, Replay::Match, "{name} {}", row["name"]);
        *seen.entry(name).or_default() += 1;
    }
    assert_eq!(seen.len(), 14, "{seen:?}");
    assert!(seen["layoutTemplate"] >= 90, "{seen:?}");
    assert!(seen["inferType"] >= 300, "{seen:?}");
}
