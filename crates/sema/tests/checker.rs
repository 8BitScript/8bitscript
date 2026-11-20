//! Replays `fixtures/checker.json` (made by `gen/checker.mjs` in Node). `check` rows are front tap
//! records and go through the tap replay; `checkImmutableLets` rows are plain `{fn, args, result}`.

use std::collections::BTreeMap;

use front_replay::{Replay, compare};
use sema::checker::immutable::check_immutable_lets;
use sema::tap::check;
use serde_json::Value;
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
