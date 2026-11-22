//! Round trip over the committed dumps, and one test per IR shape.

use std::fs;
use std::path::{Path, PathBuf};

use mos_ir::{
    Expr, Stmt, parse, parse_linked, roundtrip, roundtrip_linked, to_canonical, to_canonical_linked,
};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn fixture_texts() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for entry in fs::read_dir(fixtures()).unwrap() {
        let dir = entry.unwrap().path();
        let file = dir.join("backend-input.json");
        if file.is_file() {
            let name = dir.file_name().unwrap().to_string_lossy().into_owned();
            out.push((name, fs::read_to_string(file).unwrap()));
        }
    }
    out.sort();
    out
}

#[test]
fn every_fixture_round_trips_byte_for_byte() {
    let texts = fixture_texts();
    assert!(texts.len() >= 3, "fixtures missing");
    for (name, text) in texts {
        let input = parse(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(to_canonical(&input).unwrap(), text, "{name}");
        assert_eq!(roundtrip(&text), Ok(()), "{name}");
    }
}

#[test]
fn the_fixtures_cover_the_measured_node_kinds() {
    fn stmt(s: &Stmt, seen: &mut std::collections::BTreeSet<&'static str>) {
        match s {
            Stmt::For(f) => {
                seen.insert("for");
                f.body.iter().for_each(|b| stmt(b, seen));
            }
            Stmt::If(i) => {
                seen.insert("if");
                i.then
                    .iter()
                    .chain(i.r#else.iter().flatten())
                    .for_each(|b| stmt(b, seen));
            }
            Stmt::While(w) => {
                seen.insert("while");
                w.body.iter().for_each(|b| stmt(b, seen));
            }
            Stmt::Block(b) => {
                seen.insert("block");
                b.body.iter().for_each(|b| stmt(b, seen));
            }
            Stmt::StoreIndex(_) => {
                seen.insert("storeIndex");
            }
            Stmt::Asm(_) => {
                seen.insert("asm");
            }
            Stmt::StringCopy(_) => {
                seen.insert("stringCopy");
            }
            Stmt::MemoryRead(_) => {
                seen.insert("memoryRead");
            }
            Stmt::Call(_) => {
                seen.insert("call");
            }
            _ => {}
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    for (_, text) in fixture_texts() {
        for f in &parse(&text).unwrap().functions {
            f.body.iter().for_each(|s| stmt(s, &mut seen));
        }
    }
    for kind in [
        "for",
        "if",
        "while",
        "block",
        "storeIndex",
        "asm",
        "call",
        "stringCopy",
        "memoryRead",
    ] {
        assert!(seen.contains(kind), "no {kind} in the fixtures");
    }
}

#[test]
fn a_string_buffer_global_keeps_its_capacity() {
    let (_, text) = fixture_texts()
        .into_iter()
        .find(|(n, _)| n == "kinds-c64")
        .unwrap();
    let input = parse(&text).unwrap();
    let buffer = input
        .globals
        .iter()
        .find(|g| g.string_capacity.is_some())
        .unwrap();
    assert_eq!(buffer.string_capacity, Some(8));
    assert_eq!(buffer.array, Some(9));
}

#[test]
fn a_bare_string_literal_from_the_linker_round_trips() {
    // linker/index.mjs constExpression: `{kind: 'string', index}`, no type, no span.
    let text = with_body(
        r#"[{"kind": "assign", "target": "x", "value": {"kind": "string", "index": 0}}]"#,
    );
    assert_eq!(roundtrip(&text), Ok(()));
    let text = with_body(
        r#"[{"kind": "assign", "target": "x", "value": {"kind": "string", "index": 0, "type": null, "start": 1, "length": 2}}]"#,
    );
    assert_eq!(roundtrip(&text), Ok(()));
}

#[test]
fn floats_parse_to_the_nearest_double() {
    for text in [
        "5e-324",
        "1.7976931348623157e+308",
        "59.94",
        "0.30000000000000004",
        "29.97",
    ] {
        let dump = hello().replacen("\"frameRate\": 60", &format!("\"frameRate\": {text}"), 1);
        assert_eq!(roundtrip(&dump), Ok(()), "{text}");
    }
}

fn hello() -> String {
    fixture_texts()
        .into_iter()
        .find(|(n, _)| n == "hello-world-c64")
        .unwrap()
        .1
}

#[test]
fn an_unknown_top_level_field_is_refused() {
    let text = hello().replacen("\"debug\"", "\"extra\": 1,\n  \"debug\"", 1);
    let err = parse(&text).unwrap_err();
    assert!(err.contains("unknown field `extra`"), "{err}");
}

#[test]
fn an_unknown_node_kind_is_refused() {
    let text = hello().replacen("\"kind\": \"asm\"", "\"kind\": \"teleport\"", 1);
    assert!(text.contains("teleport"), "fixture has no asm node");
    let err = parse(&text).unwrap_err();
    assert!(err.contains("teleport"), "{err}");
}

#[test]
fn an_unknown_node_field_is_refused() {
    let text = hello().replacen(
        "\"kind\": \"const\"",
        "\"bogus\": true,\n \"kind\": \"const\"",
        1,
    );
    assert!(text.contains("bogus"), "fixture has no const node");
    let err = parse(&text).unwrap_err();
    assert!(err.contains("bogus"), "{err}");
}

#[test]
fn a_fractional_integer_is_refused() {
    let text = hello().replacen("\"length\": 9", "\"length\": 9.5", 1);
    assert!(text.contains("9.5"));
    assert!(parse(&text).is_err());
}

#[test]
fn a_fractional_frame_rate_keeps_its_js_text() {
    let text = hello().replacen("\"frameRate\": 60", "\"frameRate\": 59.94", 1);
    assert!(text.contains("59.94"));
    assert_eq!(roundtrip(&text), Ok(()));
    let text = hello().replacen("\"frameRate\": 60", "\"frameRate\": 0.0000001", 1);
    assert!(parse(&text).is_ok());
    // JS spells 1e-7 as `1e-7`, so the rewritten text differs from the odd spelling above.
    assert!(roundtrip(&text).is_err());
    let text = hello().replacen("\"frameRate\": 60", "\"frameRate\": 1e-7", 1);
    assert_eq!(roundtrip(&text), Ok(()));
}

#[test]
fn a_changed_byte_is_reported_with_its_line() {
    let text = hello().replacen("\"debug\": false", "\"debug\":false", 1);
    let err = roundtrip(&text).unwrap_err();
    assert!(err.starts_with("bytes differ at line "), "{err}");
}

/// A function around one statement list, in the dump's canonical layout.
fn with_body(body: &str) -> String {
    let base = hello();
    let mut v: serde_json::Value = serde_json::from_str(&base).unwrap();
    let body: serde_json::Value = serde_json::from_str(body).unwrap();
    v["functions"][0]["body"] = body;
    oracle::canonical_json(&v)
}

#[test]
fn the_shapes_no_corpus_build_has_produced_yet_round_trip() {
    let span = r#""start": 1, "length": 2"#;
    let body = format!(
        r#"[
          {{"kind": "portWrite", "port": {{"kind": "const", "value": 1}}, "value": {{"kind": "const", "value": 2}}, {span}}},
          {{"kind": "stringCopy", "target": {{"kind": "ref", "name": "buf"}}, "source": {{"kind": "string", "index": 0, "type": "string", "start": 3, "length": 4}}, "capacity": 8, {span}}},
          {{"kind": "namespaceCall", "namespace": "ns", "member": "m", "args": [{{"kind": "const", "value": 1}}], "type": null, {span}}},
          {{"kind": "assign", "target": "x", "value": {{"kind": "cond", "test": {{"kind": "ref", "name": "a"}}, "consequent": {{"kind": "const", "value": 1}}, "alternate": {{"kind": "namespaceConst", "namespace": "ns", "member": "K", "type": null, {span}}}, "type": "utinyint"}}}},
          {{"kind": "assign", "target": "y", "value": {{"kind": "portRead", "port": {{"kind": "const", "value": 4}}, "type": "utinyint", {span}}}}},
          {{"kind": "assign", "target": "z", "value": {{"kind": "record", "fields": [{{"name": "f", "value": {{"kind": "const", "value": 7}}, {span}}}], {span}}}}}
        ]"#
    );
    let text = with_body(&body);
    let input = parse(&text).unwrap();
    assert_eq!(input.functions[0].body.len(), 6);
    assert!(matches!(&input.functions[0].body[0], Stmt::PortWrite(_)));
    assert!(matches!(&input.functions[0].body[1], Stmt::StringCopy(_)));
    assert!(matches!(
        &input.functions[0].body[2],
        Stmt::NamespaceCall(_)
    ));
    let Stmt::Assign(a) = &input.functions[0].body[3] else {
        panic!()
    };
    assert!(matches!(a.value, Expr::Cond(_)));
    assert_eq!(roundtrip(&text), Ok(()));
}

#[test]
fn absent_and_null_stay_apart() {
    // `for(;;)` style: init absent, test null.
    let body = r#"[{"kind": "for", "test": null, "body": [], "init": null}]"#;
    let text = with_body(body);
    assert_eq!(roundtrip(&text), Ok(()));
    let body = r#"[{"kind": "if", "test": {"kind": "const", "value": 1}, "then": [], "start": 0, "length": 1}]"#;
    // `else` is required (may be null): an absent one reads as null, so the
    // rewrite adds a key the dump did not have and the round trip fails.
    assert!(roundtrip(&with_body(body)).is_err());
}

#[test]
fn the_linked_fixture_round_trips_byte_for_byte() {
    let text = fs::read_to_string(fixtures().join("hello-world-c64/linked.json")).unwrap();
    let program = parse_linked(&text).unwrap();
    assert_eq!(to_canonical_linked(&program).unwrap(), text);
    assert_eq!(roundtrip_linked(&text), Ok(()));
    assert_eq!(program.entry, "main");
    assert_eq!(program.functions.len(), program.functions_by_output.len());
}

#[test]
fn a_linked_program_with_an_unknown_field_is_rejected() {
    let text = fs::read_to_string(fixtures().join("hello-world-c64/linked.json")).unwrap();
    let text = text.replacen("\"entry\"", "\"surprise\": 1,\n  \"entry\"", 1);
    assert!(parse_linked(&text).unwrap_err().contains("surprise"));
    assert!(roundtrip_linked("{").is_err());
}
