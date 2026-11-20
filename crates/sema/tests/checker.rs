//! Replays `fixtures/checker.json` (made by `gen/checker.mjs` in Node). `check` rows are front tap
//! records and go through the tap replay; `checkImmutableLets` rows are plain `{fn, args, result}`.

use std::collections::BTreeMap;

use front_replay::{Replay, compare};
use sema::checker::immutable::check_immutable_lets;
use sema::tap::check;
use serde_json::{Value, json};
use syntax::{Node, number_nodes};

fn rows() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/checker.json")).unwrap()
}

fn run(row: &Value) -> Value {
    let args = row["args"].as_array().unwrap();
    let mut ast: Node = serde_json::from_value(args[0].clone()).unwrap();
    number_nodes(&mut ast);
    let file = args[1].as_str().unwrap();
    serde_json::to_value(check_immutable_lets(&ast, file)).unwrap()
}

#[test]
fn checker_matches_js() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for row in rows() {
        let name = row["fn"].as_str().unwrap().to_string();
        let outcome = match name.as_str() {
            "check" => check::replay(&row),
            _ => compare(&row["result"], &run(&row)),
        };
        assert_eq!(outcome, Replay::Match, "{name} {}", row["name"]);
        *seen.entry(name).or_default() += 1;
    }
    assert_eq!(seen.len(), 2, "{seen:?}");
    assert!(seen["check"] >= 90, "{seen:?}");
    assert!(seen["checkImmutableLets"] >= 25, "{seen:?}");
}

#[test]
fn root_that_is_not_a_program_is_empty() {
    use sema::checker::{CheckOptions, check};
    for root in [
        json!({"type": "BlockStatement", "start": 0, "length": 2, "body": []}),
        json!({"type": "ExpressionStatement", "start": 0, "length": 2,
               "expression": {"type": "Identifier", "start": 0, "length": 1, "name": "a"}}),
    ] {
        let mut ast: Node = serde_json::from_value(root).unwrap();
        number_nodes(&mut ast);
        assert!(check(Some(&ast), "x.8bs", None, CheckOptions::default()).is_empty());
    }
}

#[test]
fn thrown_records_skip_only_for_a_non_program_root() {
    let program = json!({"type": "Program", "start": 0, "length": 0, "body": []});
    let block = json!({"type": "BlockStatement", "start": 0, "length": 2, "body": []});
    let record = |ast: &Value| json!({"args": [ast, "x.8bs"], "throw": "TypeError"});
    assert!(matches!(
        check::replay(&record(&program)),
        Replay::Mismatch(..)
    ));
    assert_eq!(check::replay(&record(&block)), Replay::Skip);
    assert_eq!(check::replay(&record(&Value::Null)), Replay::Skip);
}
