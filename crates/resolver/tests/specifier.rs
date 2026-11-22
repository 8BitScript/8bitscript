//! Replays `fixtures/specifier.json` (made by `gen/specifier.mjs` in Node) over a temp tree built
//! from the fixture: `resolveSpecifier`, `nativeSourcesBeside` and `resolveImports` against the
//! JS results. Paths in the rows are written `<root>/...`.

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use indexmap::IndexSet;
use resolver::imports::ScanToken;
use resolver::package::native_sources_beside;
use resolver::specifier::{SpecifierOptions, resolve_imports, resolve_specifier};
use serde_json::Value;

struct Root(PathBuf);

impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn untokenize(value: &Value, root: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace("<root>", root)),
        Value::Array(a) => Value::Array(a.iter().map(|v| untokenize(v, root)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), untokenize(v, root)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn tokenize(value: &Value, root: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace(root, "<root>")),
        Value::Array(a) => Value::Array(a.iter().map(|v| tokenize(v, root)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), tokenize(v, root)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn build_tree(fixture: &Value, root: &Path) {
    for (file, text) in fixture["tree"].as_object().unwrap() {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text.as_str().unwrap()).unwrap();
    }
    for dir in fixture["dirs"].as_array().unwrap() {
        fs::create_dir_all(root.join(dir.as_str().unwrap())).unwrap();
    }
    for (link, target) in fixture["links"].as_object().unwrap() {
        let path = root.join(link);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        symlink(root.join(target.as_str().unwrap()), path).unwrap();
    }
}

#[test]
fn specifier_matches_js() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/specifier.json")).unwrap();
    let base = fs::canonicalize(std::env::temp_dir()).unwrap();
    let dir = base.join(format!("resolver-specifier-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let root = Root(dir);
    build_tree(&fixture, &root.0);
    let root_text = root.0.to_str().unwrap().to_string();

    let rows = fixture["rows"].as_array().unwrap();
    assert!(rows.len() > 600);
    for row in rows {
        let func = row["fn"].as_str().unwrap();
        let args: Vec<Value> = row["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| untokenize(a, &root_text))
            .collect();
        let got: Result<Value, String> = match func {
            "resolveSpecifier" => {
                let mut options = SpecifierOptions::from_json(&args[2]).unwrap();
                let mut seen: IndexSet<String> = args
                    .get(3)
                    .and_then(Value::as_array)
                    .map(|a| a.iter().map(|s| s.as_str().unwrap().to_string()).collect())
                    .unwrap_or_default();
                resolve_specifier(
                    args[0].as_str().unwrap(),
                    args[1].as_str().unwrap(),
                    &mut options,
                    &mut seen,
                )
                .map(|r| r.map_or(Value::Null, |r| r.to_json()))
            }
            "nativeSourcesBeside" => Ok(native_sources_beside(args[0].as_str().unwrap()).to_json()),
            "resolveImports" => {
                let tokens: Vec<ScanToken> = serde_json::from_value(args[0].clone()).unwrap();
                let mut options = SpecifierOptions::from_json(&args[2]).unwrap();
                resolve_imports(&tokens, args[1].as_str().unwrap(), &mut options)
                    .map(|d| serde_json::to_value(d).unwrap())
            }
            other => panic!("unknown fn {other}"),
        };
        let label = format!("{func} {}", row["args"]);
        match (got, row.get("throw")) {
            (Ok(got), None) => assert_eq!(tokenize(&got, &root_text), row["result"], "{label}"),
            (Err(error), Some(thrown)) => {
                assert_eq!(
                    &tokenize(&Value::String(error), &root_text),
                    thrown,
                    "{label}"
                );
            }
            (got, thrown) => panic!("{label}: got {got:?}, js threw {thrown:?}"),
        }
    }
}
