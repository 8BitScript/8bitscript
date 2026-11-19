//! Tap replay for `link` (`mos/link/index.ts`).

use serde_json::{Value, json};

use super::{Replay, compare};
use crate::build::Counters;
use crate::link::{LinkInput, Linked, link};

/// The JS result shape of a link, as the tap records it: `symbols` is a list of
/// `[name, address]` pairs and `prov` is left out.
fn result_json(linked: &Result<Linked, String>) -> Value {
    match linked {
        Err(error) => json!({ "ok": false, "error": error }),
        Ok(l) => json!({
            "ok": true,
            "bytes": l.bytes,
            "symbols": l.symbols.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
            "layout": l.layout,
            "memory": l.memory,
            "listing": l.listing.iter().map(|x| json!({
                "address": x.address, "bytes": x.bytes, "text": x.text,
            })).collect::<Vec<_>>(),
        }),
    }
}

/// Replays one `link` record: runs the Rust linker on `args[0]` and compares the
/// result. A record whose JS call threw has no result, so it never matches.
#[must_use]
pub fn replay(record: &Value, counters: &mut Counters) -> Replay {
    let Some(arg) = record.pointer("/args/0") else {
        return Replay::Mismatch(
            "/args/0".to_string(),
            Value::Null,
            Value::String("missing input".to_string()),
        );
    };
    let input: LinkInput = match serde_json::from_value(arg.clone()) {
        Ok(input) => input,
        Err(error) => {
            return Replay::Mismatch(
                "/args/0".to_string(),
                arg.clone(),
                Value::String(format!("unreadable input: {error}")),
            );
        }
    };
    let rust = result_json(&link(&input, counters));
    match record.get("result") {
        Some(js) => compare(js, &rust),
        None => Replay::Mismatch("/result".to_string(), record["throw"].clone(), rust),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<Value> {
        serde_json::from_str(include_str!("../../tests/fixtures/link.json")).expect("fixtures")
    }

    #[test]
    fn every_fixture_row_replays_as_a_match() {
        for row in rows() {
            let record = json!({ "args": row["args"], "result": row["result"] });
            assert_eq!(
                replay(&record, &mut Counters::default()),
                Replay::Match,
                "{}",
                row["name"]
            );
        }
    }

    #[test]
    fn a_changed_result_is_a_mismatch_and_a_throw_never_matches() {
        let row = &rows()[0];
        let mut js = row["result"].clone();
        js["memory"]["program"] = json!(9999);
        let record = json!({ "args": row["args"], "result": js });
        assert!(matches!(
            replay(&record, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/memory/program"
        ));
        let thrown = json!({ "args": row["args"], "throw": "boom" });
        assert!(matches!(
            replay(&thrown, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/result"
        ));
        let bad = json!({ "args": [{ "codeOrigin": "x" }], "result": {} });
        assert!(matches!(
            replay(&bad, &mut Counters::default()),
            Replay::Mismatch(p, _, _) if p == "/args/0"
        ));
        assert!(matches!(
            replay(&json!({}), &mut Counters::default()),
            Replay::Mismatch(..)
        ));
    }
}
