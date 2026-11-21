//! Replays `fixtures/ir-function.json` (made by `gen/ir-function.mjs` in Node). Every row is a
//! front tap record of `lower` over a module with function bodies; each goes through the tap
//! replay and must match in full.

use front_replay::Replay;
use lower::function::{Lowered, entry_of, lower};
use lower::tap::lower::replay;
use mos_ir::{Expr, Function, Stmt};
use serde_json::Value;
use syntax::{Node, number_nodes};

fn rows() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/ir-function.json")).unwrap()
}

fn row(name: &str) -> Value {
    rows().into_iter().find(|r| r["name"] == name).unwrap()
}

fn lowered(row: &Value) -> Lowered {
    let args = row["args"].as_array().unwrap();
    let mut ast: Node = serde_json::from_value(args[0].clone()).unwrap();
    number_nodes(&mut ast);
    lower(
        &ast,
        args[1].as_str().unwrap(),
        args.get(2).and_then(Value::as_str),
    )
}

fn messages(name: &str) -> Vec<String> {
    lowered(&row(name))
        .diagnostics
        .iter()
        .map(|d| d.message.clone())
        .collect()
}

#[test]
fn every_row_matches_in_full() {
    let rows = rows();
    assert!(rows.len() >= 20, "{} rows", rows.len());
    for row in &rows {
        let name = row["name"].as_str().unwrap();
        match replay(row) {
            Replay::Match => {}
            Replay::Skip => panic!("{name}: skipped"),
            Replay::Mismatch(pointer, js, rust) => {
                panic!("{name}: {pointer}: js {js} rust {rust}");
            }
        }
    }
}

#[test]
fn a_plain_module_lowers_its_functions_in_order() {
    let result = lowered(&row("plain functions"));
    assert!(result.diagnostics.is_empty());
    let names: Vec<&str> = result
        .ir
        .functions
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    assert_eq!(names, ["main", "add", "nothing"]);
    assert_eq!(result.ir.functions[1].return_type, "utinyint");
    assert_eq!(result.ir.functions[2].return_type, "void");
}

#[test]
fn each_refusal_is_reported_with_its_text() {
    let all: Vec<String> = [
        "intrinsic refusals",
        "return refusals",
        "local refusals",
        "statement refusals",
        "assignment refusals",
        "arity refusals",
        "parameter refusals",
        "array parameter refusals",
    ]
    .iter()
    .flat_map(|n| messages(n))
    .collect();
    for expected in [
        "memory.write needs exactly two arguments: (address, value)",
        "memory.read needs exactly one argument: (address)",
        "memory.poke is not compilable yet: only read and write exist",
        "port.write needs exactly two arguments: (port, value)",
        "port.read needs exactly one argument: (port)",
        "port.poke is not compilable yet: only read and write exist",
        "70000 does not fit in usmallint (0..65535)",
        "memory.write does not return a value and cannot be used as an expression",
        "waitFrame() does not return a value and cannot be used as an expression",
        "waitFrame() takes no arguments",
        "a call through member access is not compilable yet",
        "a fn declared to return void cannot return a value",
        "this fn must return a value of type utinyint",
        "a const is a compile-time value declared at the top level of a module, not inside a fn",
        "a local needs an explicit type to be compilable",
        "a local array is not compilable yet: declare the array at the top level",
        "'p' is already declared in this block",
        "'f' is already declared in this block",
        "@unroll takes no arguments yet: it fully unrolls the loop, however many iterations that is",
        "@other is not a loop decorator — only @unroll is",
        "'two' takes 1 to 2 arguments, not 0",
        "'one' takes 1 argument, not 2",
        "an array parameter has no default: an array is passed, never filled in",
        "'y' needs a default: every parameter after one with a default has one",
        "a parameter of type thing is not compilable yet",
        "a parameter of type (none) is not compilable yet",
        "a return type of thing is not compilable yet",
    ] {
        assert!(all.iter().any(|m| m == expected), "missing: {expected}");
    }
}

#[test]
fn a_function_the_elaborator_tagged_keeps_its_props() {
    let result = lowered(&row("elaborated function"));
    let tick = &result.ir.functions[0];
    assert_eq!(tick.component, Some(true));
    assert_eq!(tick.method, Some(true));
    let state = tick.state.as_ref().unwrap();
    assert_eq!(state[0].field, "count");
    assert_eq!(state[0].global, "Counter_count");
    let Stmt::Call(call) = &result.ir.functions[1].body[0] else {
        panic!("not a call");
    };
    assert_eq!(call.instance.as_deref(), Some("e.8bs#1"));
}

#[test]
fn a_call_keeps_its_return_type_and_a_namespace_call_has_none() {
    let result = lowered(&row("calls"));
    let run = result.ir.functions.last().unwrap();
    let Stmt::Assign(a) = &run.body[1] else {
        panic!("not an assignment");
    };
    let Expr::Call(call) = &a.value else {
        panic!("not a call");
    };
    assert_eq!(call.name, "one");
    assert_eq!(call.ty.as_option().map(String::as_str), Some("utinyint"));
    assert!(matches!(run.body[6], Stmt::NamespaceCall(_)));
}

fn function(name: &str, exported: bool) -> Function {
    Function {
        name: name.into(),
        exported,
        component: None,
        owner: jsnum::Nullable::Absent,
        method: None,
        media_bind: None,
        params: Vec::new(),
        return_type: "void".into(),
        body: Vec::new(),
        start: 0,
        length: 0,
        file: None,
        state: None,
    }
}

#[test]
fn the_entry_is_the_sole_exported_function() {
    let one = [function("a", false), function("main", true)];
    assert_eq!(entry_of(None, &one).as_deref(), Some("main"));
    let two = [function("a", true), function("b", true)];
    assert_eq!(entry_of(None, &two), None);
    assert_eq!(entry_of(None, &[]), None);
    // A recorded entry wins; an empty one is no entry, as in JS.
    assert_eq!(entry_of(Some("start"), &two).as_deref(), Some("start"));
    assert_eq!(entry_of(Some(""), &one).as_deref(), Some("main"));
}

#[test]
fn the_new_function_fields_round_trip_through_serde() {
    let mut f = function("f", false);
    f.file = Some("a.8bs".into());
    f.state = Some(vec![mos_ir::StateField {
        field: "x".into(),
        global: "G_x".into(),
    }]);
    let value = serde_json::to_value(&f).unwrap();
    assert_eq!(value["file"], "a.8bs");
    assert_eq!(value["state"][0]["global"], "G_x");
    let back: Function = serde_json::from_value(value).unwrap();
    assert_eq!(back, f);
    let bare = serde_json::to_value(function("g", true)).unwrap();
    assert!(bare.get("file").is_none() && bare.get("state").is_none());
}
