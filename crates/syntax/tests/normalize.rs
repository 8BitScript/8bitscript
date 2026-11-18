//! One test per normalizer rule (port spec 4.3, N1-N8) and the difference list.

use serde_json::{Value, json};
use syntax::{differences, normalize};

fn same(a: Value, b: Value) {
    assert_eq!(normalize(a.clone()), normalize(b.clone()), "{a} vs {b}");
    assert!(differences(&a, &b, 20).is_empty());
}

fn differ(a: Value, b: Value) {
    assert_ne!(normalize(a.clone()), normalize(b.clone()), "{a} vs {b}");
    assert!(!differences(&a, &b, 20).is_empty());
}

fn int(value: u32) -> Value {
    json!({"type": "IntegerLiteral", "value": value, "radix": 10})
}

fn ident(name: &str) -> Value {
    json!({"type": "Identifier", "name": name})
}

fn stmt(expression: Value) -> Value {
    json!({"type": "ExpressionStatement", "expression": expression})
}

fn block(body: Vec<Value>) -> Value {
    json!({"type": "BlockStatement", "body": body})
}

fn update(op: &str, prefix: bool) -> Value {
    json!({"type": "UpdateExpression", "operator": op, "argument": ident("a"), "prefix": prefix})
}

fn assign(op: &str) -> Value {
    json!({"type": "AssignmentExpression", "operator": op, "left": ident("a"), "right": int(1)})
}

#[test]
fn n1_spans_are_dropped() {
    same(
        json!({"type": "Identifier", "name": "a", "start": 0, "length": 1}),
        json!({"type": "Identifier", "name": "a", "start": 9, "length": 4}),
    );
}

#[test]
fn n2_integer_raw_is_dropped_but_value_and_radix_count() {
    let lit = |raw: &str, value: u32, radix: u32| json!({"type": "IntegerLiteral", "value": value, "raw": raw, "radix": radix});
    same(lit("%1010", 10, 2), lit("0b1010", 10, 2));
    differ(lit("10", 10, 10), lit("0b1010", 10, 2));
    differ(lit("11", 11, 10), lit("10", 10, 10));
}

#[test]
fn numbers_compare_as_numbers() {
    same(json!({"value": 1}), json!({"value": 1.0}));
}

#[test]
fn n3_no_return_type_is_void() {
    let func = |ret: Value| {
        json!({"type": "FunctionDeclaration", "name": ident("f"), "params": [], "returnType": ret,
               "body": block(vec![]), "exported": false})
    };
    let void = json!({"type": "TypeReference", "name": "void", "typeArguments": []});
    same(func(Value::Null), func(void));
    differ(
        func(Value::Null),
        func(json!({"type": "TypeReference", "name": "u8", "typeArguments": []})),
    );
}

#[test]
fn n4_update_statements_are_compound_assignments() {
    same(stmt(update("++", false)), stmt(assign("+=")));
    same(stmt(update("--", true)), stmt(assign("-=")));
    differ(stmt(update("++", false)), stmt(assign("-=")));
    let for_with = |update: Value| {
        json!({"type": "ForStatement", "init": null, "test": null,
                                          "update": update, "body": block(vec![])})
    };
    same(for_with(update("++", false)), for_with(assign("+=")));
    // Inside a larger expression an update stays an update.
    let nested = |e: Value| {
        stmt(json!({"type": "BinaryExpression", "operator": "+", "left": e, "right": int(1)}))
    };
    differ(nested(update("++", false)), nested(assign("+=")));
}

#[test]
fn n5_a_lone_statement_is_a_block_of_it() {
    let if_with = |c: Value, a: Value| {
        json!({"type": "IfStatement", "test": ident("t"),
                                              "consequent": c, "alternate": a})
    };
    let s = stmt(ident("x"));
    same(
        if_with(s.clone(), s.clone()),
        if_with(block(vec![s.clone()]), block(vec![s.clone()])),
    );
    let nested_if = if_with(block(vec![]), Value::Null);
    same(
        if_with(block(vec![]), nested_if.clone()),
        if_with(block(vec![]), nested_if.clone()),
    );
    // An `if` alternate stays: it is not wrapped in a block.
    differ(
        if_with(block(vec![]), nested_if.clone()),
        if_with(block(vec![]), block(vec![nested_if])),
    );
    let while_with = |b: Value| json!({"type": "WhileStatement", "test": ident("t"), "body": b});
    same(while_with(s.clone()), while_with(block(vec![s.clone()])));
    let for_body = |b: Value| json!({"type": "ForStatement", "init": null, "test": null, "update": null, "body": b});
    same(for_body(s.clone()), for_body(block(vec![s])));
}

#[test]
fn n6_import_sources_lose_their_extension_and_use_path() {
    let import = |source: &str, use_path: Option<bool>| {
        let mut node = json!({"type": "ImportDeclaration", "specifiers": [],
                              "source": {"type": "StringLiteral", "value": source}});
        if let Some(flag) = use_path {
            node["usePath"] = json!(flag);
        }
        node
    };
    same(import("./geo.8bs", None), import("./geo", Some(true)));
    same(import("./mark.8bg", None), import("./mark", Some(true)));
    same(import("x.8ba", None), import("x", None));
    differ(import("./geo.8bs", None), import("./other", Some(true)));
}

#[test]
fn n7_string_values_compare_decoded() {
    let string = |value: &str| json!({"type": "StringLiteral", "value": value});
    same(string("it\\'s"), string("it's"));
    same(string("a\\nb"), string("a\nb"));
    same(string("tab\\t\\r\\0"), string("tab\t\r\0"));
    same(string("end\\"), string("end\\"));
    differ(string("a"), string("b"));
}

#[test]
fn n8_immutable_is_dropped() {
    let var = |immutable: Option<bool>| {
        let mut node = json!({"type": "VariableDeclaration", "kind": "let", "name": ident("x"),
                              "typeAnnotation": null, "initializer": null, "exported": false});
        if let Some(flag) = immutable {
            node["immutable"] = json!(flag);
        }
        node
    };
    same(var(Some(true)), var(None));
}

#[test]
fn differences_name_the_path_and_stop_at_the_limit() {
    let old = json!({"body": [{"a": 1}, {"a": 2}, [1, 2], {"only_old": 1}]});
    let new = json!({"body": [{"a": 1}, {"a": 3}, [1], {"only_new": 1}]});
    let found = differences(&old, &new, 20);
    let paths: Vec<&str> = found.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "body[1].a",
            "body[2]",
            "body[3].only_new",
            "body[3].only_old"
        ]
    );
    assert_eq!(found[0].old, json!(2.0));
    assert_eq!(found[0].new, json!(3.0));
    assert_eq!(found[2].old, Value::Null);
    assert_eq!(differences(&old, &new, 2).len(), 2);
    assert!(differences(&old, &old, 20).is_empty());
}
