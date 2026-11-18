//! Replays `fixtures/link.json` (made by `gen/link.mjs` in Node).

use mos::build::Counters;
use mos::link::{LinkInput, SectionContent, link};
use serde_json::{Value, json};

fn linked_json(r: &Result<mos::link::Linked, String>) -> Value {
    match r {
        Err(error) => json!({ "ok": false, "error": error }),
        Ok(l) => json!({
            "ok": true,
            "bytes": l.bytes,
            "symbols": l.symbols.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
            "layout": l.layout,
            "memory": l.memory,
            "listing": l.listing.iter().map(|x| json!({
                "address": x.address, "bytes": x.bytes, "text": x.text,
            })).collect::<Vec<_>>(),
        }),
    }
}

#[test]
fn every_row_matches_js() {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/link.json")).expect("fixtures parse");
    assert!(rows.len() >= 19);
    for row in &rows {
        let input: LinkInput = serde_json::from_value(row["args"][0].clone()).expect("input");
        let mut c = Counters::default();
        let got = link(&input, &mut c);
        assert_eq!(linked_json(&got), row["result"], "{}", row["name"]);
    }
}

#[test]
fn input_round_trips_through_json() {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/link.json")).expect("fixtures parse");
    for row in &rows {
        let input: LinkInput = serde_json::from_value(row["args"][0].clone()).expect("input");
        assert_eq!(
            serde_json::to_value(&input).unwrap(),
            row["args"][0],
            "{}",
            row["name"]
        );
    }
    let bytes = SectionContent::Bytes(vec![1, 2]);
    assert_eq!(
        serde_json::to_value(&bytes).unwrap(),
        json!({"kind": "bytes", "bytes": [1, 2]})
    );
}
