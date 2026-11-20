//! Replays `fixtures/ir-module.json` (made by `gen/ir-module.mjs` in Node). Every row is a front
//! tap record of `lower` over a small module; each goes through the tap replay, and the module IR
//! that comes back must survive a serde round trip.

use front_replay::Replay;
use lower::module::{ModuleIr, lower_module};
use lower::tap::lower::{encode_ir, replay};
use serde_json::Value;
use syntax::{Node, number_nodes};

fn rows() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/ir-module.json")).unwrap()
}

fn lowered(row: &Value) -> lower::module::Lowered {
    let args = row["args"].as_array().unwrap();
    let mut ast: Node = serde_json::from_value(args[0].clone()).unwrap();
    number_nodes(&mut ast);
    lower_module(
        &ast,
        args[1].as_str().unwrap(),
        args.get(2).and_then(Value::as_str),
    )
}

#[test]
fn every_row_replays() {
    let rows = rows();
    assert!(rows.len() >= 20, "{} rows", rows.len());
    let mut skipped = Vec::new();
    for row in &rows {
        let name = row["name"].as_str().unwrap();
        match replay(row) {
            Replay::Match => {}
            Replay::Skip => skipped.push(name.to_string()),
            Replay::Mismatch(pointer, js, rust) => {
                panic!("{name}: {pointer}: js {js} rust {rust}");
            }
        }
    }
    // Only the module that calls a function in an initializer is skipped.
    assert_eq!(skipped, ["call in initializer"]);
}

#[test]
fn module_rows_without_functions_match_in_full() {
    for row in rows() {
        let result = lowered(&row);
        if result.unported_function || result.unported_call {
            continue;
        }
        assert_eq!(replay(&row), Replay::Match, "{}", row["name"]);
    }
}

#[test]
fn module_ir_round_trips_through_serde() {
    for row in rows() {
        let result = lowered(&row);
        let value = serde_json::to_value(&result.ir).unwrap();
        let back: ModuleIr = serde_json::from_value(value).unwrap();
        assert_eq!(back, result.ir, "{}", row["name"]);
        // The tap's form of the same IR is a plain value too.
        assert!(encode_ir(&result.ir).is_object());
    }
}

#[test]
fn function_bodies_are_marked_not_lowered() {
    let row = rows()
        .into_iter()
        .find(|r| r["name"] == "function bodies")
        .unwrap();
    let result = lowered(&row);
    assert!(result.unported_function);
    assert!(result.ir.functions.is_empty());
}
