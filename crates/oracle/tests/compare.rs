use std::fs;
use std::path::{Path, PathBuf};

use oracle::{
    Options, Roots, canonical_json, compare, glob_match, hex_dump, parse_hex, tokenize_path,
};
use serde_json::json;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("oracle-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(dir: &Path, rel: &str, text: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn fixture(dir: &Path, byte: u8, symbol: i64) {
    let bytes: Vec<u8> = (0..40u8)
        .map(|i| if i == 0x1b { byte } else { i })
        .collect();
    write(dir, "2048/main/pet/bytes.hex", &hex_dump(&bytes));
    write(
        dir,
        "2048/main/pet/link.json",
        &canonical_json(&json!({"symbols": [["a", 1], ["b", symbol]]})),
    );
    write(dir, "2048/main/pet/error.txt", "boom\n");
    write(
        dir,
        "2048/main/pet/modules/project/src/main.8bs.tokens.json",
        &canonical_json(&json!([{"k": 1}])),
    );
}

fn opts(divergences: &str) -> Options {
    Options {
        divergences: divergences.to_string(),
        ..Options::default()
    }
}

const GOOD: &str = "[[divergence]]\nid = \"D001\"\ncorpus = \"2048/*/pet\"\nstage = \"link\"\npointer = \"/symbols/*\"\nreason = \"the port orders symbols by address\"\n";

#[test]
fn identical_dirs_have_no_errors() {
    let (a, b) = (scratch("same-a"), scratch("same-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa9, 5);
    let r = compare(&a, &b, &opts("")).unwrap();
    assert_eq!((r.errors, r.exit_code(), r.files), (0, 0, 4));
    assert_eq!(
        r.summary(),
        "compare: 4 files, 0 ERROR, 0 accepted, 0 stale"
    );
}

#[test]
fn flipped_byte_is_one_error_with_offset() {
    let (a, b) = (scratch("flip-a"), scratch("flip-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa5, 5);
    let r = compare(&a, &b, &opts("")).unwrap();
    assert_eq!(r.errors, 1);
    assert_eq!(
        r.lines,
        vec!["ERROR 2048/main/pet bytes @0x001b: js=a9 other=a5"]
    );
    assert_eq!(r.exit_code(), 1);
}

#[test]
fn json_locator_and_more_count() {
    let (a, b) = (scratch("json-a"), scratch("json-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa9, 7);
    write(
        &b,
        "2048/main/pet/link.json",
        &canonical_json(&json!({"symbols": [["a", 2], ["b", 7]]})),
    );
    let r = compare(&a, &b, &opts("")).unwrap();
    assert_eq!(
        r.lines,
        vec!["ERROR 2048/main/pet link /symbols/0/1: js=1 other=2 (+1 more)"]
    );
}

#[test]
fn missing_file_and_module_label() {
    let (a, b) = (scratch("miss-a"), scratch("miss-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa9, 5);
    fs::remove_file(b.join("2048/main/pet/modules/project/src/main.8bs.tokens.json")).unwrap();
    let r = compare(&a, &b, &opts("")).unwrap();
    assert_eq!(
        r.lines,
        vec!["ERROR 2048/main/pet tokens(project/src/main.8bs) missing in other"]
    );
}

#[test]
fn text_diff_reports_the_line() {
    let (a, b) = (scratch("text-a"), scratch("text-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa9, 5);
    write(&b, "2048/main/pet/error.txt", "bang\n");
    let r = compare(&a, &b, &opts("")).unwrap();
    assert_eq!(
        r.lines,
        vec!["ERROR 2048/main/pet error line 1: js=boom other=bang"]
    );
}

#[test]
fn matching_divergence_is_accepted() {
    let (a, b) = (scratch("div-a"), scratch("div-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa9, 6);
    let r = compare(&a, &b, &opts(GOOD)).unwrap();
    assert_eq!((r.errors, r.accepted, r.stale, r.exit_code()), (0, 1, 0, 0));
}

#[test]
fn empty_reason_fails() {
    let (a, b) = (scratch("reason-a"), scratch("reason-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa9, 6);
    let r = compare(
        &a,
        &b,
        &opts(&GOOD.replace("the port orders symbols by address", "")),
    )
    .unwrap();
    assert_eq!(r.exit_code(), 1);
    let short = compare(
        &a,
        &b,
        &opts(&GOOD.replace("the port orders symbols by address", "too short")),
    )
    .unwrap();
    assert_eq!((short.invalid, short.exit_code()), (1, 1));
}

#[test]
fn stale_entry_fails() {
    let (a, b) = (scratch("stale-a"), scratch("stale-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa9, 5);
    let r = compare(&a, &b, &opts(GOOD)).unwrap();
    assert_eq!((r.errors, r.stale, r.exit_code()), (0, 1, 1));
}

#[test]
fn filters_select_stages_and_corpus() {
    let (a, b) = (scratch("filter-a"), scratch("filter-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa5, 5);
    let mut o = opts("");
    o.stages = Some(vec!["link".into()]);
    assert_eq!(compare(&a, &b, &o).unwrap().errors, 0);
    let mut o = opts("");
    o.corpus = Some("vegas-nights/*".into());
    assert_eq!(compare(&a, &b, &o).unwrap().files, 0);
}

#[test]
fn bad_toml_is_an_error() {
    let a = scratch("toml");
    assert!(compare(&a, &a, &opts("[[divergence]]\nbogus = 1\n")).is_err());
}

#[test]
fn canonical_format() {
    let v = json!({"b": [1, 2.5, "x\"y"], "a": {}, "c": [], "\u{1F600}": null, "\u{FF5E}": true});
    let text = canonical_json(&v);
    assert_eq!(
        text,
        "{\n  \"a\": {},\n  \"b\": [\n    1,\n    2.5,\n    \"x\\\"y\"\n  ],\n  \"c\": [],\n  \"\u{1F600}\": null,\n  \"\u{FF5E}\": true\n}\n"
    );
}

#[test]
fn hex_roundtrip_and_tokens_and_glob() {
    let bytes: Vec<u8> = (0..20).collect();
    let text = hex_dump(&bytes);
    assert_eq!(text.lines().count(), 2);
    assert_eq!(parse_hex(&text), Some(bytes));
    assert_eq!(parse_hex("zz"), None);
    let roots = Roots {
        toolchain: "/r/tc",
        project: "/r/pj",
    };
    assert_eq!(
        tokenize_path("/r/tc/packages/x", &roots),
        "<toolchain>/packages/x"
    );
    assert_eq!(tokenize_path("/r/pj", &roots), "<project>");
    assert_eq!(tokenize_path("/r/tcx/y", &roots), "/r/tcx/y");
    assert!(glob_match("vegas-nights/*/c64", "vegas-nights/slots/c64"));
    assert!(glob_match("*", ""));
    assert!(glob_match("a?c", "abc") && !glob_match("a?c", "ac"));
    assert!(!glob_match("a*b", "acd"));
}

#[test]
fn divergence_covers_only_the_differences_it_matches() {
    let (a, b) = (scratch("cover-a"), scratch("cover-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa9, 6);
    write(
        &a,
        "2048/main/pet/link.json",
        &canonical_json(&json!({"symbols": [["a", 1], ["b", 5]], "z": 1})),
    );
    write(
        &b,
        "2048/main/pet/link.json",
        &canonical_json(&json!({"symbols": [["a", 1], ["b", 6]], "z": 2})),
    );
    let only_symbols = GOOD.replace("/symbols/*", "/symbols/*/1");
    let r = compare(&a, &b, &opts(&only_symbols)).unwrap();
    assert_eq!((r.errors, r.accepted), (1, 0));
    assert_eq!(
        r.lines,
        vec!["ERROR 2048/main/pet link /z: js=1 other=2 (+1 more)"]
    );
}

#[test]
fn missing_pointer_is_invalid_but_star_is_allowed() {
    let (a, b) = (scratch("ptr-a"), scratch("ptr-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa9, 6);
    let none = GOOD.replace("pointer = \"/symbols/*\"\n", "");
    let r = compare(&a, &b, &opts(&none)).unwrap();
    assert_eq!((r.invalid, r.exit_code()), (1, 1));
    let star = GOOD.replace("/symbols/*", "*");
    let r = compare(&a, &b, &opts(&star)).unwrap();
    assert_eq!((r.invalid, r.accepted, r.exit_code()), (0, 1, 0));
}

#[test]
fn missing_in_js_is_an_error() {
    let (a, b) = (scratch("mjs-a"), scratch("mjs-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa9, 5);
    write(&b, "2048/main/pet/size-report.json", "{}\n");
    let r = compare(&a, &b, &opts("")).unwrap();
    assert_eq!(
        r.lines,
        vec!["ERROR 2048/main/pet size-report missing in js"]
    );
}

#[test]
fn formatting_only_difference_is_still_an_error() {
    let (a, b) = (scratch("fmt-a"), scratch("fmt-b"));
    fixture(&a, 0xa9, 5);
    fixture(&b, 0xa9, 5);
    write(
        &b,
        "2048/main/pet/link.json",
        "{\"symbols\":[[\"a\",1],[\"b\",5]]}\n",
    );
    let hex = fs::read_to_string(a.join("2048/main/pet/bytes.hex"))
        .unwrap()
        .replace('\n', " \n");
    write(&b, "2048/main/pet/bytes.hex", &hex);
    let r = compare(&a, &b, &opts("")).unwrap();
    assert_eq!(r.errors, 2);
    assert!(
        r.lines[0].starts_with("ERROR 2048/main/pet bytes line 1:"),
        "{:?}",
        r.lines
    );
    assert!(
        r.lines[1].starts_with("ERROR 2048/main/pet link line 1:"),
        "{:?}",
        r.lines
    );
}
