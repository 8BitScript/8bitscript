//! Replays `fixtures/assemble.json` (made by `gen/assemble.mjs` in Node).

mod common;

use common::{assembled_json, program};
use mos::asm::assemble::assemble;
use serde_json::Value;

#[test]
fn every_row_matches_js() {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/assemble.json")).expect("fixtures parse");
    assert!(rows.len() >= 26);
    let mut errors = 0;
    for row in &rows {
        let args = row["args"].as_array().unwrap();
        let got = assemble(&program(&args[0]), args[1].as_i64().unwrap());
        if got.is_err() {
            errors += 1;
        }
        assert_eq!(assembled_json(&got), row["result"], "{}", row["name"]);
    }
    assert!(errors >= 20);
}

#[test]
fn absent_offset_prints_undefined() {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/assemble.json")).expect("fixtures parse");
    let row = rows
        .iter()
        .find(|r| r["name"] == "origin past 16 bits")
        .unwrap();
    assert!(
        row["result"]["error"]
            .as_str()
            .unwrap()
            .contains("+ undefined is outside")
    );
}
