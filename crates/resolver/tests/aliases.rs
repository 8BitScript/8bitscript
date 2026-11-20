//! Replays `fixtures/aliases.json` (made by `gen/aliases.mjs` in Node): the four exports of
//! `import-aliases.mjs` against the JS results.

use indexmap::IndexMap;
use resolver::aliases::{
    aliased_subpath, is_path_form, longest_alias_prefix, resolve_import_alias_entries,
    resolve_import_aliases,
};
use serde_json::{Value, json};

fn aliases_of(v: &Value) -> IndexMap<String, String> {
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
        .collect()
}

#[test]
fn exports_match_js() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/aliases.json")).unwrap();
    let rows = fixture["rows"].as_array().unwrap();
    assert!(rows.len() > 150);
    for row in rows {
        let args = row["args"].as_array().unwrap();
        let expected = &row["result"];
        let note = format!("{} {args:?}", row["fn"]);
        match row["fn"].as_str().unwrap() {
            "resolveImportAliases" => {
                let dir = args[1].as_str().unwrap();
                let got = if let Some(entries) = args[0].get("$entries") {
                    let entries: Vec<(String, Value)> = entries
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|e| (e[0].as_str().unwrap().to_string(), e[1].clone()))
                        .collect();
                    resolve_import_alias_entries(&entries, dir)
                } else if args[0].get("$undefined").is_some() {
                    resolve_import_aliases(None, dir)
                } else {
                    resolve_import_aliases(Some(&args[0]), dir)
                };
                let got = match got {
                    Ok(map) => json!({ "ok": true, "importAliases": map }),
                    Err(error) => json!({ "ok": false, "error": error }),
                };
                assert_eq!(&got, expected, "{note}");
            }
            "isPathForm" => assert_eq!(
                &json!(is_path_form(args[0].as_str().unwrap())),
                expected,
                "{note}"
            ),
            "longestAliasPrefix" => {
                let map = aliases_of(&args[1]);
                let got = longest_alias_prefix(args[0].as_str().unwrap(), &map);
                assert_eq!(&json!(got), expected, "{note}");
            }
            "aliasedSubpath" => {
                let path_form = args.get(2).and_then(Value::as_bool).unwrap_or(false);
                let got = aliased_subpath(
                    args[0].as_str().unwrap(),
                    args[1].as_str().unwrap(),
                    path_form,
                );
                assert_eq!(&json!(got), expected, "{note}");
            }
            other => panic!("unknown fn {other}"),
        }
    }
}

#[test]
fn alias_order_follows_insertion() {
    let entries = vec![
        ("@z".to_string(), json!("z")),
        ("@a".to_string(), json!("a")),
    ];
    let got = resolve_import_alias_entries(&entries, "/p").unwrap();
    assert_eq!(got.keys().collect::<Vec<_>>(), ["@z", "@a"]);
}
