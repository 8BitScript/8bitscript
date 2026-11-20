//! `checkBx` against rows recorded from the JS (`tests/gen/bx-check.mjs`). Each row is a tap
//! record: the arguments in graph form and the diagnostics the JS gave.

use bx::tap::check_bx::{decode_args, run};
use serde_json::Value;

#[test]
fn rows_match_the_js() {
    let text = include_str!("fixtures/bx-check.json");
    let rows: Vec<Value> = serde_json::from_str(text).expect("fixture parses");
    assert!(rows.len() > 250, "fixture has {} rows", rows.len());
    let mut failures = Vec::new();
    for row in &rows {
        let name = row["name"].as_str().unwrap_or("?");
        let args = row["args"].as_array().expect("args");
        match decode_args(args) {
            Ok(decoded) => {
                let got = run(&decoded);
                if got != row["result"] {
                    failures.push(format!("{name}: js {} rust {got}", row["result"]));
                }
            }
            Err(message) => failures.push(format!("{name}: {message}")),
        }
    }
    assert!(
        failures.is_empty(),
        "{} rows differ; first: {}",
        failures.len(),
        failures[0]
    );
}
