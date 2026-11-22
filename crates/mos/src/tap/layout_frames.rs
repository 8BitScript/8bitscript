//! Tap replay for `layoutFrames` (`mos/zp/frames.ts`): the JS call
//! `layoutFrames(functions, entry, needs, origin, ceiling, holes?)` and its
//! result (`{ok, starts, floor}` or `{ok: false, error}`). `needs` and `starts`
//! are Maps, so the tap records them as `[[name, value], ...]`.

use indexmap::IndexMap;
use mos_ir::Function;
use serde_json::{Value, json};

use super::{Replay, compare};
use crate::build::Counters;
use crate::zp::ZpHole;
use crate::zp::frames::{FrameNeed, layout_frames};

/// Reads the `needs` map: `[[name, {bytes}], ...]`.
fn needs_from_json(v: &Value) -> Result<IndexMap<String, FrameNeed>, String> {
    let items = v.as_array().ok_or("needs is not a list")?;
    let mut out = IndexMap::new();
    for item in items {
        let name = item.get(0).and_then(Value::as_str).ok_or("need name")?;
        let bytes = item
            .pointer("/1/bytes")
            .and_then(Value::as_i64)
            .ok_or("need bytes")?;
        out.insert(name.to_string(), FrameNeed { bytes });
    }
    Ok(out)
}

/// Replays one `layoutFrames` record. A record whose JS call threw has no
/// result, so it never matches.
#[must_use]
pub fn replay(record: &Value, _counters: &mut Counters) -> Replay {
    let input = |i: usize| record.pointer(&format!("/args/{i}"));
    let (Some(functions), Some(entry), Some(needs), Some(origin), Some(ceiling)) =
        (input(0), input(1), input(2), input(3), input(4))
    else {
        return Replay::Mismatch("/args".into(), Value::Null, json!("missing input"));
    };
    let bad =
        |at: usize, why: String| Replay::Mismatch(format!("/args/{at}"), Value::Null, json!(why));
    let functions: Vec<Function> = match serde_json::from_value(functions.clone()) {
        Ok(f) => f,
        Err(e) => return bad(0, e.to_string()),
    };
    let Some(entry) = entry.as_str() else {
        return bad(1, "entry is not a string".into());
    };
    let needs = match needs_from_json(needs) {
        Ok(n) => n,
        Err(e) => return bad(2, e),
    };
    let (Some(origin), Some(ceiling)) = (origin.as_i64(), ceiling.as_i64()) else {
        return bad(3, "origin or ceiling is not an integer".into());
    };
    let holes: Vec<ZpHole> = match input(5) {
        None | Some(Value::Null) => Vec::new(),
        Some(h) => match serde_json::from_value(h.clone()) {
            Ok(h) => h,
            Err(e) => return bad(5, e.to_string()),
        },
    };
    let rust = match layout_frames(&functions, entry, &needs, origin, ceiling, &holes) {
        Err(error) => json!({ "ok": false, "error": error }),
        Ok(layout) => json!({
            "ok": true,
            "starts": layout.starts.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
            "floor": layout.floor,
        }),
    };
    match record.get("result") {
        Some(js) => compare(js, &rust),
        None => Replay::Mismatch("/result".into(), record["throw"].clone(), rust),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<Value> {
        serde_json::from_str(include_str!("../../tests/fixtures/frames.json")).expect("fixtures")
    }

    /// The tap's form of a fixture row's arguments.
    fn args(row: &Value) -> Value {
        let functions: Vec<Value> = row["functions"]
            .as_array()
            .expect("functions")
            .iter()
            .map(|f| {
                json!({
                    "name": f["name"], "exported": false, "params": [], "returnType": "void",
                    "body": f["body"], "start": 0, "length": 0, "file": "t.8bs",
                })
            })
            .collect();
        let needs: Vec<Value> = row["needs"]
            .as_array()
            .expect("needs")
            .iter()
            .map(|p| json!([p[0], { "bytes": p[1] }]))
            .collect();
        let mut args = vec![
            json!(functions),
            row["entry"].clone(),
            json!(needs),
            row["origin"].clone(),
            row["ceiling"].clone(),
        ];
        if let Some(holes) = row.get("holes") {
            args.push(holes.clone());
        }
        json!(args)
    }

    #[test]
    fn every_fixture_row_replays_as_a_match() {
        let rows = rows();
        assert!(rows.iter().any(|r| r.get("holes").is_some()));
        assert!(rows.iter().any(|r| r.get("holes").is_none()));
        for (n, row) in rows.iter().enumerate() {
            let record = json!({ "args": args(row), "result": row["result"] });
            assert_eq!(
                replay(&record, &mut Counters::default()),
                Replay::Match,
                "case {n}"
            );
        }
    }

    #[test]
    fn a_changed_result_a_throw_and_bad_input_are_mismatches() {
        let rows = rows();
        let row = rows
            .iter()
            .find(|r| r["result"]["ok"] == json!(true))
            .expect("an ok row");
        let mut js = row["result"].clone();
        js["floor"] = json!(9999);
        let record = json!({ "args": args(row), "result": js });
        assert!(matches!(
            replay(&record, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/floor"
        ));
        let thrown = json!({ "args": args(row), "throw": "boom" });
        assert!(matches!(
            replay(&thrown, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/result"
        ));
        for (index, value, at) in [
            (0, json!(5), "/args/0"),
            (1, json!(5), "/args/1"),
            (2, json!(5), "/args/2"),
            (2, json!([["f", 5]]), "/args/2"),
            (2, json!([[5, { "bytes": 1 }]]), "/args/2"),
            (3, json!("x"), "/args/3"),
        ] {
            let mut bad = args(row);
            bad[index] = value;
            let record = json!({ "args": bad, "result": {} });
            assert!(
                matches!(
                    replay(&record, &mut Counters::default()),
                    Replay::Mismatch(p, _, _) if p == at
                ),
                "{at}"
            );
        }
        let mut holes = args(row);
        holes.as_array_mut().expect("args").truncate(5);
        holes.as_array_mut().expect("args").push(json!(5));
        assert!(matches!(
            replay(&json!({ "args": holes, "result": {} }), &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/args/5"
        ));
        assert!(matches!(
            replay(&json!({}), &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/args"
        ));
    }
}
