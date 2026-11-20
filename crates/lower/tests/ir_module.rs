//! Replays `fixtures/ir-module.json` (made by `gen/ir-module.mjs` in Node). Every row is a front
//! tap record of `lower` over a small module; each goes through the tap replay, and the module IR
//! that comes back must survive a serde round trip.

use front_replay::Replay;
use lower::module::{ModuleIr, lower_module};
use lower::tap::lower::{encode_ir, replay};
use mos_ir::GlobalInit;
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
    // R7.12: a module that reaches a function body or a call is counted SKIP, never Match.
    let expected: Vec<String> = rows
        .iter()
        .filter(|row| {
            let result = lowered(row);
            result.unported_function || result.unported_call
        })
        .map(|row| row["name"].as_str().unwrap().to_string())
        .collect();
    assert!(!expected.is_empty());
    assert_eq!(skipped, expected);
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

fn row(name: &str) -> Value {
    rows().into_iter().find(|r| r["name"] == name).unwrap()
}

#[test]
fn a_throw_record_is_a_mismatch_unless_it_is_a_recorded_site() {
    // The JS call threw but the module has no R7.8 site: Rust went through, so they differ.
    let mut plain = row("empty");
    plain["throw"] = Value::String("boom".into());
    assert!(matches!(replay(&plain), Replay::Mismatch(p, _, _) if p == "/throw"));
    // R7.8: a namespace member with no name is skipped by Rust and throws in JS.
    let mut nameless = row("namespace consts");
    nameless["args"][0]["body"][0]["members"][0]["name"] = Value::Null;
    nameless["throw"] = Value::String("boom".into());
    assert_eq!(replay(&nameless), Replay::Skip);
}

#[test]
fn a_literal_past_the_i64_range_saturates_in_the_ir_but_not_in_the_message() {
    let result = lowered(&row("huge literal"));
    let messages: Vec<&str> = result
        .diagnostics
        .iter()
        .map(|d| d.message.as_str())
        .collect();
    assert_eq!(
        messages,
        [
            "100000000000000000000 does not fit in utinyint (0..255)",
            "-100000000000000000000 does not fit in utinyint (0..255)"
        ]
    );
    assert_eq!(replay(&row("huge literal")), Replay::Match);
    assert_eq!(
        result.ir.globals[0].init,
        Some(GlobalInit::Scalar(i64::MAX))
    );
}

#[test]
fn negating_a_saturated_const_does_not_overflow() {
    // `const X: i32 = -99999999999999999999; let g: i16 = -X;` negated i64::MIN once.
    let name = "negated huge const";
    assert_eq!(replay(&row(name)), Replay::Match);
    assert_eq!(
        lowered(&row(name)).ir.globals[0].init,
        Some(GlobalInit::Scalar(i64::MAX))
    );
}

#[test]
fn a_call_in_one_initializer_does_not_drop_the_globals_after_it() {
    let row = row("call then global");
    let lowered = lowered(&row);
    let names: Vec<&str> = lowered.ir.globals.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(names, ["b", "c"]);
}
