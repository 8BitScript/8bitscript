//! Replays `fixtures/variants.json` (made by `gen/variants.mjs` in Node) over a temp tree built from
//! the fixture: the variant functions, `chooseVariant` and `chooseModule` against the JS results.

use std::fs;
use std::path::PathBuf;

use resolver::variants::{
    MACHINES, Options, RELEASE_MACHINES, choose_module, choose_variant, is_release_machine,
    is_variant_path, machine_of_variant, tags_of, variant_of, variants_present,
};
use serde_json::{Value, json};

struct Root(PathBuf);

impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn opt(v: &Value) -> Option<&str> {
    v.as_str()
}

fn options_of(v: &Value) -> Options {
    if v.get("$undefined").is_some() {
        return Options::default();
    }
    Options {
        machine: opt(&v["machine"]).map(str::to_string),
        tags: v["tags"]
            .as_array()
            .map(|t| t.iter().map(|s| s.as_str().unwrap().to_string()).collect()),
        profile: opt(&v["profile"]).map(str::to_string),
        locale: opt(&v["locale"]).map(str::to_string),
        path_form: v["pathForm"].as_bool().unwrap_or(false),
    }
}

/// The result with its `path` made relative to the temp root again.
fn relative(mut value: Value, root: &str) -> Value {
    if let Some(Value::String(p)) = value.get_mut("path") {
        *p = p.strip_prefix(&format!("{root}/")).unwrap_or(p).to_string();
    }
    value
}

#[test]
fn variants_match_js() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/variants.json")).unwrap();
    let dir = std::env::temp_dir().join(format!("resolver-variants-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let root = Root(dir);
    for file in fixture["tree"].as_object().unwrap().keys() {
        let path = root.0.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "").unwrap();
    }
    for d in fixture["dirs"].as_array().unwrap() {
        fs::create_dir_all(root.0.join(d.as_str().unwrap())).unwrap();
    }
    let base = root.0.to_string_lossy().into_owned();
    let abs = |rel: &Value| format!("{base}/{}", rel.as_str().unwrap());
    let rows = fixture["rows"].as_array().unwrap();
    assert!(rows.len() > 2000);
    for row in rows {
        let a = row["args"].as_array().unwrap();
        let arg = |i: usize| a.get(i).unwrap_or(&Value::Null);
        let got: Value = match row["fn"].as_str().unwrap() {
            "MACHINES" => json!(MACHINES),
            "RELEASE_MACHINES" => json!(RELEASE_MACHINES),
            "isReleaseMachine" => json!(is_release_machine(arg(0).as_str().unwrap())),
            "variantOf" => json!(variant_of(
                arg(0).as_str().unwrap(),
                opt(arg(1)),
                opt(arg(2)),
                opt(arg(3))
            )),
            "tagsOf" => json!(tags_of(&options_of(arg(0)))),
            "isVariantPath" => json!(is_variant_path(arg(0).as_str().unwrap(), opt(arg(1)))),
            "machineOfVariant" => json!(machine_of_variant(arg(0).as_str().unwrap())),
            "variantsPresent" => Value::Array(
                variants_present(&abs(arg(0)))
                    .iter()
                    .map(|v| v.to_json())
                    .collect(),
            ),
            "chooseVariant" => {
                let tags: Vec<String> = if arg(3).get("$undefined").is_some() {
                    Vec::new()
                } else {
                    arg(3)
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|t| t.as_str().unwrap().to_string())
                        .collect()
                };
                let chosen = choose_variant(
                    arg(0).as_str().unwrap(),
                    &abs(arg(1)),
                    opt(arg(2)),
                    &tags,
                    opt(arg(4)),
                );
                chosen.map_or(Value::Null, |c| relative(c.to_json(), &base))
            }
            "chooseModule" => {
                let chosen =
                    choose_module(arg(0).as_str().unwrap(), &abs(arg(1)), &options_of(arg(2)));
                chosen.map_or(Value::Null, |c| relative(c.to_json(), &base))
            }
            other => panic!("unknown fn {other}"),
        };
        assert_eq!(got, row["result"], "{} {a:?}", row["fn"]);
    }
}

#[test]
fn variants_present_of_a_missing_directory_is_empty() {
    assert!(variants_present("/definitely/not/here/x.8bs").is_empty());
}
