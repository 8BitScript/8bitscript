//! Replays `fixtures/parse.json` (made by `gen/parse.mjs` in Node).

use mos::asm::assemble::Directive;
use mos::asm::parse::parse_asm;
use serde_json::{Value, json};

#[test]
fn parse_asm_matches_js() {
    let f: Value = serde_json::from_str(include_str!("fixtures/parse.json")).unwrap();
    let cases = f["cases"].as_array().unwrap();
    let (mut ok, mut err) = (0, 0);
    for case in cases {
        let text = case["args"][0].as_str().unwrap();
        let id = case["args"][1].as_str().unwrap();
        let got = match parse_asm(text, id) {
            Ok(directives) => {
                ok += 1;
                json!({ "ok": true, "directives": serde_json::to_value::<&Vec<Directive>>(&directives).unwrap() })
            }
            Err(error) => {
                err += 1;
                json!({ "ok": false, "error": error })
            }
        };
        assert_eq!(got, case["result"], "parseAsm({text:?}, {id:?})");
    }
    println!(
        "parse parity: {} cases ({ok} ok, {err} errors)",
        cases.len()
    );
    assert!(ok > 50 && err > 50);
}
