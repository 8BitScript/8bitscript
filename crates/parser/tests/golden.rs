//! Golden AST dumps over the hand-written new-syntax corpus. There is no JS
//! oracle for the new syntax, so every `*.ast.json` was written by this
//! parser (`BLESS=1 cargo test -p parser --test golden`) and then read by
//! hand against the syntax spec; the diff of a changed dump is the review.

mod common;

use std::fs;

use common::{corpus, dir, kind_of, parse_kind, read};
use oracle::canonical_json;

fn dump(name: &str) -> String {
    let parsed = parse_kind(&read(name), kind_of(name));
    let value = serde_json::to_value(&parsed).expect("serialize");
    canonical_json(&value)
}

#[test]
fn every_corpus_file_matches_its_golden_dump() {
    let bless = std::env::var_os("BLESS").is_some();
    let files = corpus();
    assert!(files.len() >= 16, "corpus shrank: {}", files.len());
    for name in files {
        let actual = dump(&name);
        let golden = dir().join(format!("{name}.ast.json"));
        if bless {
            fs::write(&golden, &actual).expect("write golden");
        }
        let expected = fs::read_to_string(&golden)
            .unwrap_or_else(|e| panic!("{name}: missing golden ({e}); run with BLESS=1"));
        assert!(actual == expected, "{name}: AST dump differs from golden");
    }
}

#[test]
fn fixtures_stay_small() {
    let total: u64 = fs::read_dir(dir())
        .expect("dir")
        .filter_map(|e| e.ok()?.metadata().ok())
        .map(|m| m.len())
        .sum();
    assert!(total < 256 * 1024, "corpus is {total} bytes");
}
