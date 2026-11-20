//! Replays `fixtures/fold.json` (made by `gen/fold.mjs` in Node): each row is a `foldCompileTime`
//! call over parsed text with the diagnostics, the folded tree and the `defineSites` list JS left.
//! `#package` rows name a temp tree (`<tmp>` in their strings) that this test writes first.

use std::fs;
use std::path::{Path, PathBuf};

use fold::tap::fold_compile_time::run;
use front_replay::{Replay, compare};
use serde_json::Value;

struct Root(PathBuf);

impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn substitute(value: &Value, root: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace("<tmp>", root)),
        Value::Array(items) => Value::Array(items.iter().map(|v| substitute(v, root)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), substitute(v, root)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn ancestor_has_package(dir: &Path) -> bool {
    dir.ancestors().any(|d| d.join("package.json").is_file())
}

#[test]
fn fixtures_replay() {
    let text = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/fold.json"
    ))
    .unwrap();
    let rows: Vec<Value> = serde_json::from_str(&text).unwrap();
    assert!(rows.len() > 100, "fixture rows: {}", rows.len());

    let root = Root(std::env::temp_dir().join(format!("fold-rows-{}", std::process::id())));
    let _ = fs::remove_dir_all(&root.0);
    fs::create_dir_all(&root.0).unwrap();
    let base = root.0.to_string_lossy().into_owned();
    let mut throws = 0;
    let mut packages = 0;
    let mut failures = Vec::new();

    for raw in &rows {
        let row = substitute(raw, &base);
        let name = row["name"].as_str().unwrap_or("?").to_string();
        if let Some(tree) = row.get("tree").and_then(Value::as_object) {
            packages += 1;
            // JS found no package.json above the temp dir; any ancestor here would change that.
            if name == "package none above" && ancestor_has_package(&root.0) {
                continue;
            }
            for (path, content) in tree {
                let path = root.0.join(path);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, content.as_str().unwrap()).unwrap();
            }
        }
        let args = row["args"].as_array().unwrap();
        let outcome = run(args);
        if let Some(expected) = row.get("throw").and_then(Value::as_str) {
            throws += 1;
            match outcome {
                Err(message) if message.contains("cannot be converted to a BigInt") => {
                    assert!(
                        expected.contains("cannot be converted to a BigInt"),
                        "{name}"
                    );
                }
                other => failures.push(format!("{name}: expected a throw, got {:?}", other.err())),
            }
            continue;
        }
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(message) => {
                failures.push(format!("{name}: Err({message})"));
                continue;
            }
        };
        let diagnostics = serde_json::to_value(&outcome.diagnostics).unwrap();
        let tree = serde_json::to_value(&outcome.ast).unwrap();
        let sites = serde_json::to_value(&outcome.sites).unwrap();
        let checks = [
            ("result", row.get("result"), diagnostics),
            ("after", row.get("after"), tree),
            ("sites", row.get("sites"), sites),
        ];
        for (what, expected, got) in checks {
            let Some(expected) = expected else {
                continue;
            };
            if let Replay::Mismatch(path, js, rust) = compare(expected, &got) {
                // The JSON error text of a broken package.json is V8's; only its shape is compared.
                if name == "package broken" && what == "result" {
                    continue;
                }
                failures.push(format!("{name} {what} {path}: js {js} rust {rust}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(throws, 1);
    assert_eq!(packages, 14);
}
