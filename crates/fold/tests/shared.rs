//! Nodes shared by two places in a tree (what the component pass leaves): the clone keeps its ids,
//! so a second visit rewrites the same way but reports nothing.

use fold::{DefineSite, Options, fold_compile_time};
use serde_json::{Value, json};
use syntax::{Node, NodeId, NodeKind, children_mut, number_nodes};

fn ident(name: &str, start: u32) -> Value {
    json!({"type": "Identifier", "name": name, "start": start, "length": 1, "compileTime": true})
}

fn declaration(initializer: Value) -> Value {
    json!({
        "type": "VariableDeclaration", "start": 0, "length": 9, "kind": "let",
        "name": {"type": "Identifier", "name": "a", "start": 4, "length": 1},
        "initializer": initializer, "exported": false, "immutable": true
    })
}

fn program(statement: Value) -> Node {
    let tree = json!({"type": "Program", "start": 0, "length": 9, "body": [statement]});
    let mut root: Node = serde_json::from_value(tree).unwrap();
    number_nodes(&mut root);
    root
}

/// The program's one statement copied into a second place with the same ids.
fn share(root: &mut Node) {
    let NodeKind::Program { body, .. } = &mut root.kind else {
        unreachable!()
    };
    body.push(body[0].clone());
}

/// The same, with ids no other node has.
fn copy(root: &mut Node) {
    share(root);
    let NodeKind::Program { body, .. } = &mut root.kind else {
        unreachable!()
    };
    let mut next = 1000;
    fn renumber(node: &mut Node, next: &mut u32) {
        node.id = NodeId(*next);
        *next += 1;
        for child in children_mut(node) {
            renumber(child, next);
        }
    }
    renumber(&mut body[1], &mut next);
}

fn unknown_call() -> Value {
    json!({"type": "CallExpression", "start": 12, "length": 8, "callee": ident("nope", 12), "args": []})
}

fn run(root: &mut Node, sites: Option<&mut Vec<DefineSite>>) -> usize {
    fold_compile_time(Some(root), "a.8bs", &Options::default(), sites)
        .unwrap()
        .len()
}

fn is_folded(root: &Node) -> bool {
    let NodeKind::Program { body, .. } = &root.kind else {
        unreachable!()
    };
    body.iter().all(|statement| {
        matches!(
            &statement.kind,
            NodeKind::VariableDeclaration { initializer: Some(init), .. }
                if matches!(init.kind, NodeKind::IntegerLiteral { .. })
        )
    })
}

#[test]
fn a_shared_call_reports_once() {
    let mut root = program(declaration(unknown_call()));
    share(&mut root);
    assert_eq!(run(&mut root, None), 1);
    assert!(is_folded(&root));
}

#[test]
fn a_copy_with_fresh_ids_reports_again() {
    let mut root = program(declaration(unknown_call()));
    copy(&mut root);
    assert_eq!(run(&mut root, None), 2);
    assert!(is_folded(&root));
}

#[test]
fn a_shared_decimal_reports_once() {
    let decimal = json!({"type": "DecimalLiteral", "start": 12, "length": 3, "numerator": 3, "denominator": 2, "raw": "1.5"});
    let mut root = program(declaration(decimal));
    share(&mut root);
    assert_eq!(run(&mut root, None), 1);
    assert!(is_folded(&root));
}

#[test]
fn a_shared_bare_name_reports_every_visit() {
    let mut root = program(declaration(ident("frames", 12)));
    share(&mut root);
    assert_eq!(run(&mut root, None), 2);
}

#[test]
fn a_shared_define_makes_one_site() {
    let call = json!({
        "type": "CallExpression", "start": 12, "length": 16, "callee": ident("define", 12),
        "args": [
            {"type": "StringLiteral", "value": "X", "start": 20, "length": 3},
            {"type": "IntegerLiteral", "value": 1, "raw": "1", "radix": 10, "start": 25, "length": 1}
        ]
    });
    let mut root = program(declaration(call));
    share(&mut root);
    let mut sites = Vec::new();
    assert_eq!(run(&mut root, Some(&mut sites)), 0);
    assert_eq!(sites.len(), 1);
}

#[test]
fn a_replaced_node_keeps_its_id() {
    let mut root = program(declaration(unknown_call()));
    let before = match &root.kind {
        NodeKind::Program { body, .. } => match &body[0].kind {
            NodeKind::VariableDeclaration {
                initializer: Some(init),
                ..
            } => init.id,
            _ => unreachable!(),
        },
        _ => unreachable!(),
    };
    run(&mut root, None);
    let NodeKind::Program { body, .. } = &root.kind else {
        unreachable!()
    };
    let NodeKind::VariableDeclaration {
        initializer: Some(init),
        ..
    } = &body[0].kind
    else {
        unreachable!()
    };
    assert_eq!(init.id, before);
    assert!(matches!(init.kind, NodeKind::IntegerLiteral { .. }));
}
