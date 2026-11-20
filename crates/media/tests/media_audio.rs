//! Replays `fixtures/media-audio.json` (made by `gen/media-audio.mjs`).

mod common;

use common::{json, norm, rows};
use media::audio::Air;
use media::audio::check::song_rows;
use media::audio::parse::note_value;
use media::audio::song::{encode_song, song_events};
use media::{check_audio, parse_audio, tokenize_media};
use serde_json::{Value, json as j};

fn parse(text: &str, file: &str) -> (Air, Vec<diagnostics::Diagnostic>) {
    let (tokens, _) = tokenize_media(text, file, ".8ba");
    parse_audio(&tokens, text, file)
}

#[test]
fn every_row_matches_js() {
    let rows = rows(include_str!("fixtures/media-audio.json"));
    assert!(rows.len() >= 300, "{} rows", rows.len());
    let mut counts = std::collections::BTreeMap::new();
    for row in &rows {
        let f = row["fn"].as_str().unwrap();
        let name = row["name"].as_str().unwrap();
        let args = row["args"].as_array().unwrap();
        let (text, file) = (args[0].as_str().unwrap(), args[1].as_str().unwrap());
        let (air, diagnostics) = parse(text, file);
        let got: Value = match f {
            "parseAudio" => {
                let checked = check_audio(&air, file);
                j!({ "air": json(&air), "diagnostics": json(&diagnostics), "checked": json(&checked) })
            }
            "songRows" => json(&song_rows(&air.songs[args[2].as_u64().unwrap() as usize])),
            "songEvents" => json(&song_events(
                &air,
                &air.songs[args[2].as_u64().unwrap() as usize],
            )),
            "encodeSong" => json(&encode_song(
                &air,
                &air.songs[args[2].as_u64().unwrap() as usize],
            )),
            other => panic!("unknown fn {other}"),
        };
        assert_eq!(got, norm(&row["result"]), "{f}: {name}");
        *counts.entry(f.to_string()).or_insert(0) += 1;
    }
    assert!(counts["parseAudio"] >= 130, "{counts:?}");
    assert!(counts["encodeSong"] >= 40, "{counts:?}");
    assert_eq!(counts["songRows"], counts["songEvents"]);
    assert_eq!(counts["songRows"], counts["encodeSong"]);
}

#[test]
fn the_corpus_is_all_covered() {
    let rows = rows(include_str!("fixtures/media-audio.json"));
    let count = |f: &str| {
        rows.iter()
            .filter(|r| r["fn"] == f && r["name"].as_str().unwrap().starts_with("corpus "))
            .count()
    };
    // Six `.8ba` files, one song among them.
    assert_eq!(count("parseAudio"), 6);
    assert_eq!(count("encodeSong"), 1);
}

#[test]
fn note_names_span_c0_to_b6() {
    assert_eq!(note_value("C0"), Some(0.0));
    assert_eq!(note_value("CS0"), Some(1.0));
    assert_eq!(note_value("B6"), Some(83.0));
    assert_eq!(note_value("C7"), None);
    assert_eq!(note_value("H4"), None);
    assert_eq!(note_value("c4"), None);
}

// media: R7.5: parseOrder: JS never advances past a token that is not a
// name (`order { 5 }`) and loops forever; Rust stops at the first such token.
#[test]
fn an_order_with_a_non_name_token_terminates() {
    let text = "song s { order { 5 } }";
    let (air, diagnostics) = parse(text, "a.8ba");
    assert_eq!(air.songs.len(), 1);
    assert!(air.songs[0].order.is_empty());
    assert!(!diagnostics.is_empty());
}
