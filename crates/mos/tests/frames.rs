//! Replays `fixtures/frames.json` (made by `gen/frames.mjs` in Node).

use indexmap::IndexMap;
use mos::zp::ZpHole;
use mos::zp::frames::{FrameNeed, collect_live_parents, layout_frames};
use mos_ir::Function;
use serde_json::{Value, json};

fn functions(v: &Value) -> Vec<Function> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|f| {
            serde_json::from_value(json!({
                "name": f["name"], "exported": false, "params": [], "returnType": "void",
                "body": f["body"], "start": 0, "length": 0, "file": "t.8bs",
            }))
            .expect("function parses")
        })
        .collect()
}

#[test]
fn live_parents_and_layouts_match_the_js() {
    let rows: Vec<Value> = serde_json::from_str(include_str!("fixtures/frames.json")).unwrap();
    assert!(rows.len() >= 15);
    let (mut oks, mut errors) = (0, 0);
    for (n, row) in rows.iter().enumerate() {
        let fns = functions(&row["functions"]);

        let parents = collect_live_parents(&fns);
        let got: Vec<Value> = parents
            .iter()
            .map(|(k, v)| json!([k, v.iter().collect::<Vec<_>>()]))
            .collect();
        assert_eq!(Value::Array(got), row["parents"], "case {n} parents");

        let needs: IndexMap<String, FrameNeed> = row["needs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p[0].as_str().unwrap().to_string(),
                    FrameNeed {
                        bytes: p[1].as_i64().unwrap(),
                    },
                )
            })
            .collect();
        let holes: Vec<ZpHole> = row
            .get("holes")
            .map(|h| serde_json::from_value(h.clone()).unwrap())
            .unwrap_or_default();
        let got = layout_frames(
            &fns,
            row["entry"].as_str().unwrap(),
            &needs,
            row["origin"].as_i64().unwrap(),
            row["ceiling"].as_i64().unwrap(),
            &holes,
        );
        let want = &row["result"];
        match got {
            Ok(layout) => {
                oks += 1;
                assert_eq!(want["ok"], json!(true), "case {n}");
                let starts: Vec<Value> = layout.starts.iter().map(|(k, v)| json!([k, v])).collect();
                assert_eq!(Value::Array(starts), want["starts"], "case {n} starts");
                assert_eq!(json!(layout.floor), want["floor"], "case {n} floor");
            }
            Err(error) => {
                errors += 1;
                assert_eq!(want["ok"], json!(false), "case {n}");
                assert_eq!(json!(error), want["error"], "case {n}");
            }
        }
    }
    assert!(oks >= 8 && errors >= 4, "ok {oks}, error {errors}");
}
