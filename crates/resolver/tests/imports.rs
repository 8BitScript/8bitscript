//! Replays `fixtures/imports.json` (made by `gen/imports.mjs` in Node): `findImports`,
//! `pathFormSpecifiers` and `withPathForm` against the JS results.

use resolver::imports::ScanToken;
use resolver::imports::{find_imports, path_form_specifiers, with_path_form};
use resolver::variants::Options;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/imports.json")).unwrap()
}

#[test]
fn find_imports_and_path_form_specifiers_match_js() {
    let fixture = fixture();
    let rows = fixture["rows"].as_array().unwrap();
    assert!(rows.len() > 200);
    for row in rows {
        let tokens: Vec<ScanToken> = serde_json::from_value(row["args"][0].clone()).unwrap();
        let got = match row["fn"].as_str().unwrap() {
            "findImports" => serde_json::to_value(find_imports(&tokens)).unwrap(),
            "pathFormSpecifiers" => serde_json::to_value(
                path_form_specifiers(&tokens)
                    .into_iter()
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
            other => panic!("unknown fn {other}"),
        };
        assert_eq!(got, row["result"], "{} {:?}", row["fn"], row["text"]);
    }
}

#[test]
fn with_path_form_matches_js() {
    let fixture = fixture();
    for row in fixture["options"].as_array().unwrap() {
        let input = &row["options"];
        let options = Options {
            machine: input["machine"].as_str().map(str::to_string),
            locale: input["locale"].as_str().map(str::to_string),
            tags: input["tags"]
                .as_array()
                .map(|t| t.iter().map(|s| s.as_str().unwrap().to_string()).collect()),
            path_form: input["pathForm"].as_bool().unwrap_or(false),
            profile: None,
        };
        // `pathForm: undefined` is `null` in the fixture, and false is falsy.
        let path_form = row["pathForm"].as_bool().unwrap_or(false);
        let got = with_path_form(&options, path_form);
        let expected = &row["result"];
        assert_eq!(got.machine.as_deref(), expected["machine"].as_str());
        assert_eq!(got.locale.as_deref(), expected["locale"].as_str());
        assert_eq!(
            got.path_form,
            expected["pathForm"].as_bool().unwrap_or(false),
            "{row}"
        );
    }
}

#[test]
fn scan_token_converts_from_a_syntax_token() {
    let token: syntax::Token = serde_json::from_value(
        serde_json::json!({"kind": "identifier", "start": 3, "length": 2, "text": "ab"}),
    )
    .unwrap();
    let scan = ScanToken::from(&token);
    assert_eq!((scan.start, scan.length, scan.text.as_str()), (3, 2, "ab"));
}
