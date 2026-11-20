//! Replays `fixtures/media-module.json` (made by `gen/media-module.mjs`).
//! The `.8ba` row is SKIP until the audio unit lands.

mod common;

use common::{json, norm, rows};
use media::audio::Unported;
use media::{is_media_kind, parse_media_module};
use serde_json::json as j;

#[test]
fn every_row_matches_js() {
    let rows = rows(include_str!("fixtures/media-module.json"));
    assert!(rows.len() >= 10);
    let mut checked = 0;
    for row in &rows {
        let args = row["args"].as_array().unwrap();
        if row["fn"] == "isMediaKind" {
            assert_eq!(
                j!(is_media_kind(args[0].as_str().unwrap())),
                row["result"],
                "{}",
                row["name"]
            );
            continue;
        }
        let mut diagnostics = Vec::new();
        let got = parse_media_module(
            args[0].as_str().unwrap(),
            args[1].as_str().unwrap(),
            &mut diagnostics,
            args[3].as_str().unwrap(),
        );
        if row.get("skip").is_some() {
            assert!(matches!(got, Err(Unported(_))), "{}", row["name"]);
            assert!(diagnostics.is_empty());
            continue;
        }
        let m = got.unwrap();
        let out = j!({
            "file": m.file, "text": m.text, "tokens": json(&m.tokens),
            "media": json(&m.media), "diagnostics": json(&diagnostics),
        });
        assert_eq!(out, norm(&row["result"]), "{}", row["name"]);
        checked += 1;
    }
    assert_eq!(checked, 4);
}

#[test]
fn media_has_exactly_one_of_gir_and_air() {
    let mut d = Vec::new();
    let m = parse_media_module("a.8bg", "", &mut d, ".8bg").unwrap();
    assert!(m.media.gir.is_some() && m.media.air.is_none());
}
