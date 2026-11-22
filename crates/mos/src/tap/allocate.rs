//! Tap replay for `allocate` (`mos/zp/index.ts`): the JS call
//! `allocate(globals, budget)` and its result (`{ok, globals, zpUsed}` or
//! `{ok: false, error}`).

use serde_json::{Value, json};

use super::{Replay, compare};
use crate::build::Counters;
use crate::zp::{Budget, IrGlobal, allocate};

/// Replays one `allocate` record. A record whose JS call threw has no result,
/// so it never matches.
#[must_use]
pub fn replay(record: &Value, _counters: &mut Counters) -> Replay {
    let input = |i: usize| record.pointer(&format!("/args/{i}"));
    let (Some(globals), Some(budget)) = (input(0), input(1)) else {
        return Replay::Mismatch("/args".into(), Value::Null, json!("missing input"));
    };
    let globals: Vec<IrGlobal> = match serde_json::from_value(globals.clone()) {
        Ok(g) => g,
        Err(e) => return Replay::Mismatch("/args/0".into(), Value::Null, json!(e.to_string())),
    };
    let budget: Budget = match serde_json::from_value(budget.clone()) {
        Ok(b) => b,
        Err(e) => return Replay::Mismatch("/args/1".into(), Value::Null, json!(e.to_string())),
    };
    let rust = match allocate(&globals, &budget) {
        Err(error) => json!({ "ok": false, "error": error }),
        Ok(done) => {
            let mut v = serde_json::to_value(&done).unwrap_or(Value::Null);
            v["ok"] = Value::Bool(true);
            v
        }
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
        let all: Vec<Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/zp.json")).expect("fixtures");
        all.into_iter().filter(|r| r["fn"] == "allocate").collect()
    }

    #[test]
    fn every_fixture_row_replays_as_a_match() {
        let rows = rows();
        assert!(rows.len() > 20);
        for row in rows {
            let record = json!({ "args": row["args"], "result": row["result"] });
            assert_eq!(
                replay(&record, &mut Counters::default()),
                Replay::Match,
                "{}",
                row["args"]
            );
        }
    }

    #[test]
    fn a_changed_result_a_throw_and_bad_input_are_mismatches() {
        let row = rows()
            .into_iter()
            .find(|r| r["result"]["ok"] == json!(true))
            .expect("an ok row");
        let mut js = row["result"].clone();
        js["zpUsed"] = json!(9999);
        let record = json!({ "args": row["args"], "result": js });
        assert!(matches!(
            replay(&record, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/zpUsed"
        ));
        let thrown = json!({ "args": row["args"], "throw": "boom" });
        assert!(matches!(
            replay(&thrown, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/result"
        ));
        let globals = json!({ "args": [5, row["args"][1]], "result": {} });
        assert!(matches!(
            replay(&globals, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/args/0"
        ));
        let budget = json!({ "args": [row["args"][0], 5], "result": {} });
        assert!(matches!(
            replay(&budget, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/args/1"
        ));
        assert!(matches!(
            replay(&json!({}), &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/args"
        ));
    }
}
