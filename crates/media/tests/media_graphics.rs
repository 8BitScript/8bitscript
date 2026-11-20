//! Replays `fixtures/media-graphics.json` (made by `gen/media-graphics.mjs`).
//!
//! Known edge: JS computes a sprite's `sizeLength` as a difference that can be
//! negative (`size 8 x` with no height). The GIR keeps the signed value; the
//! diagnostic length is clamped to 0 because `Diagnostic.length` is unsigned.
//! Fixtures whose checked diagnostics would carry a negative length are
//! compared with that length clamped.

mod common;

use common::{json, norm, rows};
use media::{check_graphics, parse_graphics, tokenize_media};
use serde_json::{Value, json as j};

/// The only rows whose checked diagnostics carry a negative length in JS.
const NEGATIVE_LENGTH_ROWS: [&str; 2] = ["size missing height", "size width only"];

/// Clamps negative lengths; returns how many it changed.
fn clamp_lengths(v: &mut Value) -> usize {
    let mut changed = 0;
    if let Value::Array(a) = v {
        for d in a {
            if d["length"].as_f64().is_some_and(|n| n < 0.0) {
                d["length"] = j!(0.0);
                changed += 1;
            }
        }
    }
    changed
}

#[test]
fn every_row_matches_js() {
    let rows = rows(include_str!("fixtures/media-graphics.json"));
    assert!(rows.len() >= 55);
    for row in &rows {
        let args = row["args"].as_array().unwrap();
        let (text, file) = (args[0].as_str().unwrap(), args[1].as_str().unwrap());
        let (tokens, _) = tokenize_media(text, file, ".8bg");
        let (gir, diagnostics) = parse_graphics(&tokens, text, file);
        let checked = check_graphics(&gir, file);
        let got =
            j!({ "gir": json(&gir), "diagnostics": json(&diagnostics), "checked": json(&checked) });
        let mut want = norm(&row["result"]);
        let name = row["name"].as_str().unwrap();
        let clamped = clamp_lengths(&mut want["checked"]);
        assert_eq!(
            clamped > 0,
            NEGATIVE_LENGTH_ROWS.contains(&name),
            "unexpected negative length in {name}"
        );
        assert_eq!(got, want, "{}", row["name"]);
    }
}

#[test]
fn a_clean_sprite_has_no_diagnostics() {
    let text = r#"sprite hero { source "hero.png" size 16x16 }"#;
    let (tokens, lexical) = tokenize_media(text, "a.8bg", ".8bg");
    let (gir, parsed) = parse_graphics(&tokens, text, "a.8bg");
    assert!(lexical.is_empty() && parsed.is_empty());
    assert!(check_graphics(&gir, "a.8bg").is_empty());
    assert_eq!(gir.sprites[0].width, 16.0);
}
