//! Replays `fixtures/media-elaborate.json` (made by `gen/media-elaborate.mjs`) against
//! `media::elaborate::elaborate_media_in`: each row is a run of modules that share one
//! `mediaSlots`, with its source files written to a scratch directory first.

mod common;

use common::{json as to_json, norm, rows};
use media::elaborate::elaborate_media_in;
use media::parse_media_module;
use media::tap::elaborate_media::{options_of, slots_json};
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::path::PathBuf;

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex byte"))
        .collect()
}

fn scratch() -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("media-elaborate");
    std::fs::create_dir_all(dir.join("sub")).expect("scratch dir");
    dir
}

/// `value` with the scratch and repo tokens replaced in every string.
fn fill(value: &Value, dir: &str, root: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace("<dir>", dir).replace("<root>", root)),
        Value::Array(a) => Value::Array(a.iter().map(|v| fill(v, dir, root)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), fill(v, dir, root)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[test]
fn every_row_matches_js() {
    let all = rows(include_str!("fixtures/media-elaborate.json"));
    assert!(all.len() >= 55, "{} rows", all.len());
    let dir = scratch();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root");
    let (dir_s, root_s) = (dir.to_str().unwrap(), root.to_str().unwrap());
    for (name, hex) in all[0]["files"].as_object().expect("assets") {
        std::fs::write(dir.join(name), unhex(hex.as_str().unwrap())).expect("write asset");
    }
    let mut thrown = 0;
    for row in &all {
        let name = row["name"].as_str().unwrap();
        let options = fill(&row["options"], dir_s, root_s);
        let mut opts = options_of(&options);
        opts.checkout = Some(root_s.to_string());
        let search = row["noPath"].as_bool().unwrap().then(|| OsStr::new(""));
        let mut diagnostics = Vec::new();
        let mut steps = Vec::new();
        for step in row["steps"].as_array().unwrap() {
            let step = fill(step, dir_s, root_s);
            let module = parse_media_module(
                step["file"].as_str().unwrap(),
                step["text"].as_str().unwrap(),
                &mut diagnostics,
                step["kind"].as_str().unwrap(),
            );
            match elaborate_media_in(&module, &mut diagnostics, &mut opts, search) {
                Ok(ir) => steps.push(json!({ "ir": to_json(&ir) })),
                Err(message) => {
                    thrown += 1;
                    steps.push(json!({ "throw": message }));
                }
            }
        }
        let got = json!({
            "steps": steps,
            "diagnostics": serde_json::to_value(&diagnostics).unwrap(),
            "slots": slots_json(opts.media_slots.as_ref()),
        });
        let want = fill(&row["result"], dir_s, root_s);
        assert_eq!(norm(&got), norm(&want), "{name}");
    }
    assert_eq!(thrown, 0, "no fixture row throws");
}
