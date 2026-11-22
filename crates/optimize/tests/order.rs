//! The insertion order of the walk-based name sets: init, test, update, then body.

use indexmap::IndexSet;
use mos_ir::Stmt;
use optimize::{collect_assigned, collect_bound_names};
use serde_json::json;

fn konst(value: i64) -> serde_json::Value {
    json!({"kind": "const", "value": value, "type": "utinyint"})
}

fn for_loop() -> Stmt {
    serde_json::from_value(json!({
        "kind": "for",
        "init": {"kind": "local", "name": "i", "init": konst(0), "type": "utinyint"},
        "test": {"kind": "const", "value": 1, "type": "bool"},
        "update": {"kind": "assign", "target": "i", "value": konst(1)},
        "body": [
            {"kind": "local", "name": "inner", "init": konst(0), "type": "utinyint"},
            {"kind": "assign", "target": "total", "value": konst(1)},
        ],
        "unroll": false,
    }))
    .expect("for statement parses")
}

#[test]
fn assigned_names_come_in_walk_order() {
    let mut out = IndexSet::new();
    collect_assigned(&for_loop(), &mut out);
    assert_eq!(out.into_iter().collect::<Vec<_>>(), ["i", "total"]);
}

#[test]
fn bound_names_come_in_walk_order() {
    let mut out = IndexSet::new();
    collect_bound_names(&for_loop(), &mut out);
    assert_eq!(out.into_iter().collect::<Vec<_>>(), ["i", "inner"]);
}
