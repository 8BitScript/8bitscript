//! The pair fixtures (port spec W-01). `<n>.old.8bs` is old syntax and
//! `<n>.old.ast.json` its AST from the JS parser (`make-pairs.mjs`);
//! `<n>.8bs` is the same program in the new syntax and `<n>.ast.json` the
//! Rust parser's AST of it (hand-read, then blessed with `BLESS=1`). After
//! the normalizer the two ASTs must be equal.

use std::fs;
use std::path::PathBuf;

use front_wasm::check_json;
use lexer::{Options as LexOptions, tokenize};
use oracle::canonical_json;
use parser::{Options as ParseOptions, parse};
use serde_json::{Value, json};
use syntax::{SourceKind, differences, normalize};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/pairs")
}

fn names() -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir())
        .expect("pairs dir")
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            let stem = name
                .strip_suffix(".old.8bs")
                .or_else(|| name.strip_suffix(".old.8bx"))?;
            Some(stem.to_string())
        })
        .collect();
    names.sort();
    names
}

/// `.8bx` when the pair is a component file, else `.8bs`.
fn kind_of(stem: &str) -> SourceKind {
    if dir().join(format!("{stem}.8bx")).exists() {
        SourceKind::Bx
    } else {
        SourceKind::Bs
    }
}

fn ext(stem: &str) -> &'static str {
    match kind_of(stem) {
        SourceKind::Bx => ".8bx",
        _ => ".8bs",
    }
}

fn read(name: &str) -> String {
    fs::read_to_string(dir().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn new_ast(stem: &str) -> Value {
    let kind = kind_of(stem);
    let text = read(&format!("{stem}{}", ext(stem)));
    let lexed = tokenize(
        &text,
        stem,
        &LexOptions {
            source_kind: Some(kind),
        },
    );
    assert!(
        lexed.diagnostics.is_empty(),
        "{stem}: {:?}",
        lexed.diagnostics
    );
    let parsed = parse(
        &lexed.tokens,
        &text,
        stem,
        &ParseOptions {
            source_kind: Some(kind),
        },
    );
    assert!(
        parsed.diagnostics.is_empty(),
        "{stem}: {:?}",
        parsed.diagnostics
    );
    serde_json::to_value(&parsed.ast).expect("serialize")
}

fn old_ast(stem: &str) -> Value {
    serde_json::from_str(&read(&format!("{stem}.old.ast.json"))).expect("old ast json")
}

#[test]
fn there_are_pairs() {
    assert!(names().len() >= 19, "pairs shrank: {:?}", names());
}

#[test]
fn normalized_asts_are_equal_on_every_pair() {
    for stem in names() {
        let old = old_ast(&stem);
        let new = new_ast(&stem);
        let found = differences(&old, &new, 5);
        assert!(found.is_empty(), "{stem}: {found:#?}");
        assert_eq!(normalize(old), normalize(new), "{stem}");
    }
}

#[test]
fn the_bridge_check_agrees_on_every_pair() {
    for stem in names() {
        let request = json!({
            "file": format!("{stem}{}", ext(&stem)),
            "sourceKind": ext(&stem),
            "oldAst": old_ast(&stem),
            "newText": read(&format!("{stem}{}", ext(&stem))),
        });
        let reply: Value =
            serde_json::from_slice(&check_json(&serde_json::to_vec(&request).unwrap())).unwrap();
        assert_eq!(reply["equal"], json!(true), "{stem}: {reply}");
    }
}

#[test]
fn native_ast_dumps_match_their_goldens() {
    let bless = std::env::var_os("BLESS").is_some();
    for stem in names() {
        let actual = canonical_json(&new_ast(&stem));
        let golden = dir().join(format!("{stem}.ast.json"));
        if bless {
            fs::write(&golden, &actual).expect("write golden");
        }
        let expected = fs::read_to_string(&golden)
            .unwrap_or_else(|e| panic!("{stem}: missing golden ({e}); run with BLESS=1"));
        assert!(
            actual == expected,
            "{stem}: AST dump differs from its golden"
        );
    }
}

#[test]
fn a_changed_pair_is_not_equal() {
    let mut old = old_ast("02-declarations");
    old["body"][1]["name"]["name"] = json!("renamed");
    let request = json!({
        "file": "t.8bs",
        "oldAst": old,
        "newText": read("02-declarations.8bs"),
    });
    let reply: Value =
        serde_json::from_slice(&check_json(&serde_json::to_vec(&request).unwrap())).unwrap();
    assert_eq!(reply["equal"], json!(false));
    assert_eq!(reply["differences"][0]["path"], json!("body[1].name.name"));
    assert_eq!(reply["differences"][0]["old"], json!("renamed"));
    assert_eq!(reply["differences"][0]["new"], json!("add"));
}
