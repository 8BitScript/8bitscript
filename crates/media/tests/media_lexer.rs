//! Replays `fixtures/media-lexer.json` (made by `gen/media-lexer.mjs`).

mod common;

use common::{json, norm, rows};
use media::tokenize_media;
use serde_json::json as j;

#[test]
fn every_row_matches_js() {
    let rows = rows(include_str!("fixtures/media-lexer.json"));
    assert!(rows.len() >= 25);
    for row in &rows {
        let args = row["args"].as_array().unwrap();
        let (tokens, diagnostics) = tokenize_media(
            args[0].as_str().unwrap(),
            args[1].as_str().unwrap(),
            args[2].as_str().unwrap(),
        );
        let got = j!({ "tokens": json(&tokens), "diagnostics": json(&diagnostics) });
        // A JS Infinity is `null` in JSON; serde_json writes a non-finite f64 as null too.
        assert_eq!(got, norm(&row["result"]), "{}", row["name"]);
    }
}

#[test]
fn spans_are_utf16_units() {
    let (tokens, _) = tokenize_media("/* 😀 */ ab", "a.8bg", ".8bg");
    assert_eq!(tokens[0].length, 8);
    assert_eq!(tokens[1].start, 9);
}

#[test]
fn unexpected_code_follows_the_source_kind() {
    let (_, g) = tokenize_media("@", "a.8bg", ".8bg");
    let (_, a) = tokenize_media("@", "a.8ba", ".8ba");
    assert_eq!(g[0].code, "8BS2102");
    assert_eq!(a[0].code, "8BS2202");
}

#[test]
fn a_character_outside_the_bmp_shows_as_two_replacement_characters() {
    // JS reports each surrogate half alone; a Rust string cannot hold one.
    let (_, d) = tokenize_media("\u{1F600}", "a.8bg", ".8bg");
    assert_eq!(d.len(), 2);
    assert_eq!(d[0].message, "unexpected '\u{fffd}'");
    assert_eq!(d[1].message, "unexpected '\u{fffd}'");
    assert_eq!((d[0].start, d[1].start), (0, 1));
}
