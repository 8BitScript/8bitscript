//! Parity with the JS dump shape. Each fixture was written by
//! `make-fixtures.mjs` from the JS lexer and parser; deserializing it into the
//! Rust types and writing it back through `canonical_json` must give the same
//! bytes (R6.2), and the walker must visit nodes in the JS `walk` order.

use std::fs;
use std::path::PathBuf;

use oracle::canonical_json;
use serde::Serialize;
use serde::de::DeserializeOwned;
use syntax::{Node, NodeId, Token, number_nodes, utf16_len, walk};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn read(name: &str) -> String {
    fs::read_to_string(dir().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn round_trip<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let text = read(name);
    let value: T = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
    let json = serde_json::to_value(&value).unwrap_or_else(|e| panic!("{name}: {e}"));
    assert!(canonical_json(&json) == text, "{name}: round trip differs");
    value
}

struct Case {
    name: String,
    utf16_length: u32,
    source: Option<String>,
}

fn cases() -> Vec<Case> {
    let list: serde_json::Value = serde_json::from_str(&read("cases.json")).expect("cases.json");
    list.as_array()
        .expect("array")
        .iter()
        .map(|c| Case {
            name: c["name"].as_str().expect("name").to_string(),
            utf16_length: u32::try_from(c["utf16Length"].as_u64().expect("len")).expect("u32"),
            source: c["source"].as_str().map(str::to_string),
        })
        .collect()
}

#[test]
fn there_are_nineteen_cases() {
    assert_eq!(cases().len(), 19);
}

#[test]
fn every_ast_round_trips_byte_for_byte() {
    for case in cases() {
        let ast: Node = round_trip(&format!("{}.ast.json", case.name));
        // The Program spans the whole text, in UTF-16 units (R6.1).
        assert_eq!(ast.start, 0, "{}", case.name);
        assert_eq!(ast.length, case.utf16_length, "{}", case.name);
    }
}

#[test]
fn every_token_dump_round_trips_byte_for_byte() {
    let mut seen = 0;
    for case in cases() {
        let name = format!("{}.tokens.json", case.name);
        if dir().join(&name).exists() {
            let tokens: Vec<Token> = round_trip(&name);
            assert!(!tokens.is_empty(), "{name}");
            seen += 1;
        }
    }
    assert!(seen >= 8, "only {seen} token dumps");
}

#[test]
fn walker_visits_in_js_order() {
    for case in cases() {
        let ast: Node = round_trip(&format!("{}.ast.json", case.name));
        let expected: Vec<String> =
            serde_json::from_str(&read(&format!("{}.walk.json", case.name))).expect("walk fixture");
        let mut got = Vec::new();
        walk(&ast, &mut |node, parent| {
            got.push(format!(
                "{}@{}+{}<{}",
                node.type_name(),
                node.start,
                node.length,
                parent.map_or("", Node::type_name)
            ));
        });
        assert_eq!(got, expected, "{}", case.name);
    }
}

#[test]
fn node_numbering_is_pre_order_and_unique() {
    for case in cases() {
        let mut ast: Node = round_trip(&format!("{}.ast.json", case.name));
        let next = number_nodes(&mut ast);
        let mut ids = Vec::new();
        walk(&ast, &mut |node, _| ids.push(node.id));
        let expected: Vec<NodeId> = (0..next).map(NodeId).collect();
        assert_eq!(ids, expected, "{}", case.name);
        // Ids are not part of the dump.
        let json = serde_json::to_string(&ast).expect("json");
        assert!(!json.contains("\"id\""), "{}", case.name);
    }
}

#[test]
fn spans_after_non_ascii_text_are_utf16_not_bytes() {
    let case = cases()
        .into_iter()
        .find(|c| c.name == "utf16_astral.8bs")
        .expect("case");
    let source = case.source.expect("source kept");
    assert!(
        source.len() > source.encode_utf16().count(),
        "needs multi-byte text"
    );
    assert_eq!(utf16_len(&source), case.utf16_length);
    assert_ne!(u32::try_from(source.len()).expect("u32"), case.utf16_length);
}

#[test]
fn em_dash_corpus_file_keeps_its_source_and_length() {
    let case = cases()
        .into_iter()
        .find(|c| c.name.ends_with("index.nl.8bs"))
        .expect("case");
    let source = case.source.expect("source kept");
    assert_eq!(utf16_len(&source), case.utf16_length);
}

#[test]
fn recovery_nulls_survive() {
    let text = read("recovery.8bs.ast.json");
    assert!(
        text.contains(": null"),
        "fixture should hold error-recovery nulls"
    );
    let _: Node = round_trip("recovery.8bs.ast.json");
}
