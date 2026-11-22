//! Tap replay for `assembleNative` (`mos/native.ts`): the JS call
//! `assembleNative(sources, referenced)` and its result
//! (`{ok, initProgram, textProgram, entries}` or `{ok: false, error}`).
//! `referenced` is a Set, so the tap records it as a list.

use indexmap::IndexSet;
use serde_json::{Value, json};

use super::{Replay, compare};
use crate::build::Counters;
use crate::chr_nes::NativeSource;
use crate::native::assemble_native;

/// Replays one `assembleNative` record. A record whose JS call threw has no
/// result, so it never matches.
#[must_use]
pub fn replay(record: &Value, _counters: &mut Counters) -> Replay {
    let input = |i: usize| record.pointer(&format!("/args/{i}"));
    let (Some(sources), Some(referenced)) = (input(0), input(1)) else {
        return Replay::Mismatch("/args".into(), Value::Null, json!("missing input"));
    };
    let sources: Vec<NativeSource> = match serde_json::from_value(sources.clone()) {
        Ok(s) => s,
        Err(e) => return Replay::Mismatch("/args/0".into(), Value::Null, json!(e.to_string())),
    };
    let referenced: IndexSet<String> =
        match serde_json::from_value::<Vec<String>>(referenced.clone()) {
            Ok(r) => r.into_iter().collect(),
            Err(e) => return Replay::Mismatch("/args/1".into(), Value::Null, json!(e.to_string())),
        };
    let rust = match assemble_native(&sources, &referenced) {
        Err(error) => json!({ "ok": false, "error": error }),
        Ok(p) => json!({
            "ok": true,
            "initProgram": serde_json::to_value(&p.init_program).unwrap_or(Value::Null),
            "textProgram": serde_json::to_value(&p.text_program).unwrap_or(Value::Null),
            "entries": p.entries.iter().map(|e| json!({"name": e.name, "bytes": e.bytes})).collect::<Vec<_>>(),
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

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/native.json")).expect("fixtures")
    }

    /// The tap's form of a fixture case: the sources carry their text.
    fn args(fixture: &Value, case: &Value) -> Value {
        let sources: Vec<Value> = case["args"][0]
            .as_array()
            .expect("paths")
            .iter()
            .map(|p| json!({ "path": p, "text": fixture["files"][p.as_str().expect("path")] }))
            .collect();
        json!([sources, case["args"][1]])
    }

    #[test]
    fn every_fixture_case_replays_as_a_match() {
        let fixture = fixture();
        let cases = fixture["cases"].as_array().expect("cases");
        assert!(cases.len() > 30);
        for case in cases {
            let record = json!({ "args": args(&fixture, case), "result": case["result"] });
            assert_eq!(
                replay(&record, &mut Counters::default()),
                Replay::Match,
                "{}",
                case["args"]
            );
        }
    }

    #[test]
    fn a_changed_result_a_throw_and_bad_input_are_mismatches() {
        let fixture = fixture();
        let case = fixture["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .find(|c| c["result"]["ok"] == json!(true))
            .expect("an ok case");
        let mut js = case["result"].clone();
        js["entries"] = json!([]);
        let record = json!({ "args": args(&fixture, case), "result": js });
        assert!(matches!(
            replay(&record, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p.starts_with("/entries")
        ));
        let thrown = json!({ "args": args(&fixture, case), "throw": "boom" });
        assert!(matches!(
            replay(&thrown, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/result"
        ));
        for (bad, at) in [
            (json!([5, []]), "/args/0"),
            (json!([[], 5]), "/args/1"),
            (json!([]), "/args"),
        ] {
            let record = json!({ "args": bad, "result": {} });
            assert!(matches!(
                replay(&record, &mut Counters::default()),
                Replay::Mismatch(p, _, _) if p == at
            ));
        }
    }
}
