//! `NodeId`s after `elaborate_bx` (R1.10), on the fixture row of a slotted component with a
//! parameter: `component Frame(title: u8) { before(); <slot />; after(); }` (row slot-element).

use std::collections::{BTreeMap, BTreeSet};

use bx::elaborate::elaborate_bx;
use bx::tap::elaborate_bx::decode_args;
use sema::binder::types::ModuleId;
use serde_json::Value;
use syntax::{Node, NodeId, NodeKind, walk};

const ROW: &str = "slot-element";

fn run() -> (Node, Node) {
    let text = include_str!("fixtures/bx-elaborate.json");
    let rows: Vec<Value> = serde_json::from_str(text).expect("fixture parses");
    let row = rows
        .iter()
        .find(|r| r["name"] == ROW)
        .expect("the row is in the fixture");
    let args = decode_args(row["args"].as_array().expect("args")).expect("decodes");
    let input = args.ast.clone();
    let mut ast = args.ast.clone();
    elaborate_bx(
        &mut ast,
        &args.modules,
        ModuleId(0),
        &[None, None],
        &args.file,
    )
    .expect("no foreign tree needed");
    (input, ast)
}

fn ids_of(n: &Node) -> Vec<NodeId> {
    let mut ids = Vec::new();
    walk(n, &mut |n, _| ids.push(n.id));
    ids
}

fn function<'a>(ast: &'a Node, name: &str) -> &'a Node {
    let NodeKind::Program { body } = &ast.kind else {
        panic!("not a program");
    };
    body.iter()
        .find(|s| {
            matches!(&s.kind, NodeKind::FunctionDeclaration { name: Some(n), .. }
                if matches!(&n.kind, NodeKind::Identifier { name: x, .. } if x == name))
        })
        .unwrap_or_else(|| panic!("no function {name}"))
}

fn parts(f: &Node) -> (&[Node], &[Node]) {
    let NodeKind::FunctionDeclaration { params, body, .. } = &f.kind else {
        panic!("not a function");
    };
    let Some(NodeKind::BlockStatement { body }) = body.as_deref().map(|b| &b.kind) else {
        panic!("no block");
    };
    (params, body)
}

#[test]
fn a_statement_before_the_slot_keeps_its_ids_in_both_functions() {
    let (_, out) = run();
    let (_, whole) = parts(function(&out, "Frame"));
    let (_, open) = parts(function(&out, "Frame__open"));
    assert_eq!(whole[0], open[0]);
    assert_eq!(ids_of(&whole[0]), ids_of(&open[0]));
}

#[test]
fn the_params_of_a_half_are_fresh() {
    let (input, out) = run();
    let seen: BTreeSet<NodeId> = ids_of(&input).into_iter().collect();
    let (frame_params, _) = parts(function(&out, "Frame"));
    let frame: BTreeSet<NodeId> = frame_params.iter().flat_map(ids_of).collect();
    let mut halves = Vec::new();
    for name in ["Frame__open", "Frame__close"] {
        let (params, _) = parts(function(&out, name));
        assert!(!params.is_empty());
        let ids: BTreeSet<NodeId> = params.iter().flat_map(ids_of).collect();
        assert!(ids.is_disjoint(&seen), "{name} reuses an input id");
        assert!(ids.is_disjoint(&frame), "{name} shares an id with Frame");
        halves.push(ids);
    }
    assert!(halves[0].is_disjoint(&halves[1]));
}

#[test]
fn nodes_with_one_id_are_equal() {
    let (_, out) = run();
    let mut by_id: BTreeMap<NodeId, String> = BTreeMap::new();
    walk(&out, &mut |n, _| {
        let json = serde_json::to_string(n).expect("serializes");
        let first = by_id.entry(n.id).or_insert_with(|| json.clone());
        assert_eq!(*first, json, "two different nodes carry id {:?}", n.id);
    });
}
