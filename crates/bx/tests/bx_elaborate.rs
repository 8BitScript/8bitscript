//! `elaborateBx` against rows recorded from the JS (`tests/gen/bx-elaborate.mjs`). Each row is a
//! tap record: the arguments in graph form (a fifth-position `foreign` tree for an imported
//! component), the returned program and the program after the call.

use bx::tap::elaborate_bx::{decode_args, expand_refs, run};
use front_replay::{Replay, compare};
use serde_json::Value;

#[test]
fn rows_match_the_js() {
    let text = include_str!("fixtures/bx-elaborate.json");
    let rows: Vec<Value> = serde_json::from_str(text).expect("fixture parses");
    assert!(rows.len() >= 59, "fixture has {} rows", rows.len());
    let mut failures = Vec::new();
    for row in &rows {
        let name = row["name"].as_str().unwrap_or("?");
        let args = row["args"].as_array().expect("args");
        let decoded = match decode_args(args) {
            Ok(d) => d,
            Err(m) => {
                failures.push(format!("{name}: {m}"));
                continue;
            }
        };
        let got = match run(&decoded) {
            Ok(v) => v,
            Err(_) => {
                failures.push(format!("{name}: a node the row does not carry"));
                continue;
            }
        };
        for key in ["result", "after"] {
            let expected = expand_refs(&row[key]).expect("expands");
            if let Replay::Mismatch(p, a, b) = compare(&expected, &got) {
                failures.push(format!("{name}: {key}{p}: js {a} rust {b}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} rows differ; first: {}",
        failures.len(),
        failures[0]
    );
}

#[test]
fn shared_nodes_are_expanded_by_multiplicity() {
    let tree = serde_json::json!({
        "type": "Program", "start": 0, "length": 0,
        "body": [
            {"type": "ExpressionStatement", "start": 0, "length": 0,
             "expression": {"type": "Identifier", "start": 0, "length": 0, "name": "a"}},
            {"type": "ExpressionStatement", "start": 0, "length": 0,
             "expression": {"$node": 2}}
        ]
    });
    let out = expand_refs(&tree).expect("expands");
    assert_eq!(out["body"][1]["expression"]["name"], "a");
    assert_eq!(out["body"][1]["expression"]["type"], "Identifier");
}
