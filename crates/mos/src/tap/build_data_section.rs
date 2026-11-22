//! Tap replay for `buildDataSection` (`mos/data.ts`): the JS call
//! `buildDataSection(strings, arrays, usedIndexes?)` and the directive list it
//! returns. An absent `usedIndexes` is recorded as `null`.

use indexmap::IndexSet;
use serde_json::{Value, json};

use super::{Replay, compare};
use crate::build::Counters;
use crate::data::{DataArrayGlobal, IrString, build_data_section};

/// Replays one `buildDataSection` record. A record whose JS call threw has no
/// result, so it never matches.
#[must_use]
pub fn replay(record: &Value, _counters: &mut Counters) -> Replay {
    let input = |i: usize| record.pointer(&format!("/args/{i}"));
    let (Some(strings), Some(arrays)) = (input(0), input(1)) else {
        return Replay::Mismatch("/args".into(), Value::Null, json!("missing input"));
    };
    let strings: Vec<IrString> = match serde_json::from_value(strings.clone()) {
        Ok(s) => s,
        Err(e) => return Replay::Mismatch("/args/0".into(), Value::Null, json!(e.to_string())),
    };
    let arrays: Vec<DataArrayGlobal> = match serde_json::from_value(arrays.clone()) {
        Ok(a) => a,
        Err(e) => return Replay::Mismatch("/args/1".into(), Value::Null, json!(e.to_string())),
    };
    let used: Option<IndexSet<i64>> = match input(2) {
        None | Some(Value::Null) => None,
        Some(v) => match serde_json::from_value::<Vec<i64>>(v.clone()) {
            Ok(list) => Some(list.into_iter().collect()),
            Err(e) => {
                return Replay::Mismatch("/args/2".into(), Value::Null, json!(e.to_string()));
            }
        },
    };
    let rust = serde_json::to_value(build_data_section(&strings, &arrays, used.as_ref()))
        .unwrap_or(Value::Null);
    match record.get("result") {
        Some(js) => compare(js, &rust),
        None => Replay::Mismatch("/result".into(), record["throw"].clone(), rust),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cases() -> Vec<Value> {
        let f: Value = serde_json::from_str(include_str!("../../tests/fixtures/image.json"))
            .expect("fixtures");
        f["dataCases"].as_array().expect("dataCases").clone()
    }

    #[test]
    fn every_fixture_case_replays_as_a_match() {
        let cases = cases();
        assert!(cases.iter().any(|c| c["usedIndexes"].is_array()));
        assert!(cases.iter().any(|c| c["usedIndexes"].is_null()));
        for case in cases {
            let record = json!({
                "args": [case["strings"], case["arrays"], case["usedIndexes"]],
                "result": case["result"],
            });
            assert_eq!(replay(&record, &mut Counters::default()), Replay::Match);
        }
    }

    #[test]
    fn a_changed_result_a_throw_and_bad_input_are_mismatches() {
        let case = &cases()[0];
        let args = json!([case["strings"], case["arrays"]]);
        let mut js = case["result"].clone();
        js[0]["name"] = json!("other");
        let record = json!({ "args": args, "result": js });
        assert!(matches!(
            replay(&record, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/0/name"
        ));
        let thrown = json!({ "args": args, "throw": "boom" });
        assert!(matches!(
            replay(&thrown, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/result"
        ));
        for (bad, at) in [
            (json!([5, case["arrays"]]), "/args/0"),
            (json!([case["strings"], 5]), "/args/1"),
            (json!([case["strings"], case["arrays"], "x"]), "/args/2"),
            (json!([]), "/args"),
        ] {
            let record = json!({ "args": bad, "result": [] });
            assert!(matches!(
                replay(&record, &mut Counters::default()),
                Replay::Mismatch(p, _, _) if p == at
            ));
        }
    }
}
