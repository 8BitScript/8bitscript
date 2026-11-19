//! Replays `fixtures/native.json` (made by `gen/native.mjs` in Node).

use indexmap::IndexSet;
use mos::asm::assemble::Directive;
use mos::chr_nes::NativeSource;
use mos::native::{assemble_native, referenced_labels};
use serde_json::{Value, json};

#[test]
fn assemble_native_matches_js() {
    let f: Value = serde_json::from_str(include_str!("fixtures/native.json")).unwrap();
    let files = f["files"].as_object().unwrap();
    let cases = f["cases"].as_array().unwrap();
    let (mut ok, mut err) = (0, 0);
    for case in cases {
        let sources: Vec<NativeSource> = case["args"][0]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| NativeSource {
                path: p.as_str().unwrap().to_string(),
                text: files[p.as_str().unwrap()].as_str().unwrap().to_string(),
            })
            .collect();
        let referenced: IndexSet<String> = case["args"][1]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let got = match assemble_native(&sources, &referenced) {
            Ok(p) => {
                ok += 1;
                json!({
                    "ok": true,
                    "initProgram": serde_json::to_value::<&Vec<Directive>>(&p.init_program).unwrap(),
                    "textProgram": serde_json::to_value::<&Vec<Directive>>(&p.text_program).unwrap(),
                    "entries": p.entries.iter().map(|e| json!({"name": e.name, "bytes": e.bytes})).collect::<Vec<_>>(),
                })
            }
            Err(error) => {
                err += 1;
                json!({ "ok": false, "error": error })
            }
        };
        assert_eq!(got, case["result"], "{}", case["args"]);
    }
    println!(
        "native parity: {} cases ({ok} ok, {err} errors)",
        cases.len()
    );
    assert!(ok > 15 && err > 15);
}

#[test]
fn referenced_labels_matches_js() {
    let f: Value = serde_json::from_str(include_str!("fixtures/native.json")).unwrap();
    for case in f["refCases"].as_array().unwrap() {
        let program: Vec<Directive> = serde_json::from_value(case["args"][0].clone()).unwrap();
        let got: Vec<String> = referenced_labels(&program).into_iter().collect();
        assert_eq!(json!(got), case["result"]);
    }
}
