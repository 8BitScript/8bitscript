//! Tap replay for `lower`: the JS call `lower(body, options)` and its result
//! (`{ok, program, parts}` or `{ok: false, error}`), plus the allocator after.

use indexmap::IndexMap;
use mos_ir::Stmt;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::{Replay, compare};
use crate::build::Counters;
use crate::lower::{LowerOptions, lower};

/// A `Map` the tap encodes as `[[key, value], ...]`.
fn pairs<T: DeserializeOwned>(v: Option<&Value>) -> Result<IndexMap<String, T>, String> {
    let mut out = IndexMap::new();
    let Some(Value::Array(items)) = v else {
        return Ok(out);
    };
    for item in items {
        let key = item.get(0).and_then(Value::as_str).ok_or("map key")?;
        let value = serde_json::from_value(item.get(1).cloned().unwrap_or(Value::Null))
            .map_err(|e| e.to_string())?;
        out.insert(key.to_string(), value);
    }
    Ok(out)
}

fn field<T: DeserializeOwned>(v: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(v.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("{key}: {e}"))
}

fn optional<T: DeserializeOwned>(v: &Value, key: &str) -> Result<Option<T>, String> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(x) => serde_json::from_value(x.clone())
            .map(Some)
            .map_err(|e| format!("{key}: {e}")),
    }
}

/// Reads the `options` argument of a recorded call.
///
/// # Errors
/// The decode error text when the record does not have the expected shape.
pub fn options_from_json(v: &Value) -> Result<LowerOptions, String> {
    Ok(LowerOptions {
        globals: pairs(v.get("globals"))?,
        locals: field(v, "locals")?,
        params: optional(v, "params")?.unwrap_or_default(),
        functions: pairs(v.get("functions"))?,
        arrays: pairs(v.get("arrays"))?,
        multiply: match v.get("multiply") {
            None | Some(Value::Null) => None,
            Some(m) => Some(crate::startup::multiply::MultiplyCells {
                a: field(m, "a")?,
                b: field(m, "b")?,
                result: field(m, "result")?,
            }),
        },
        return_pair: optional(v, "returnPair")?,
        fn_name: optional(v, "fnName")?,
        fn_file: optional(v, "fnFile")?,
        origin_files: pairs(v.get("originFiles"))?,
    })
}

/// The counter `n` of the `__8bs_exit_<n>` label a successful JS result ends with.
fn exit_counter(result: &Value) -> Option<u64> {
    let last = result.get("program")?.as_array()?.last()?;
    last.get("name")?
        .as_str()?
        .strip_prefix("__8bs_exit_")?
        .parse()
        .ok()
}

fn strip_prov(v: &mut Value) {
    match v {
        Value::Object(map) => {
            map.remove("prov");
            map.values_mut().for_each(strip_prov);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_prov),
        _ => {}
    }
}

/// Replays one `lower` record.
#[must_use]
pub fn replay(record: &Value, counters: &mut Counters) -> Replay {
    let Some(args) = record.get("args").and_then(Value::as_array) else {
        return Replay::Mismatch("/args".into(), Value::Null, json!("missing input"));
    };
    let (Some(body), Some(opts)) = (args.first(), args.get(1)) else {
        return Replay::Mismatch("/args".into(), Value::Null, json!("missing input"));
    };
    let Some(js) = record.get("result") else {
        // The JS call threw, so there is no result to match.
        return Replay::Mismatch("/result".into(), record["throw"].clone(), Value::Null);
    };
    let body: Vec<Stmt> = match serde_json::from_value(body.clone()) {
        Ok(b) => b,
        Err(e) => return Replay::Mismatch("/args/0".into(), Value::Null, json!(e.to_string())),
    };
    let mut options = match options_from_json(opts) {
        Ok(o) => o,
        Err(e) => return Replay::Mismatch("/args/1".into(), Value::Null, json!(e)),
    };
    if let Some(n) = exit_counter(js) {
        counters.lower = n;
    }
    let mut rust = match lower(&body, &mut options, counters) {
        Err(error) => json!({"ok": false, "error": error}),
        Ok(done) => {
            let mut v = serde_json::to_value(&done).unwrap_or(Value::Null);
            v["ok"] = Value::Bool(true);
            v
        }
    };
    strip_prov(&mut rust);
    if let Replay::Mismatch(p, a, b) = compare(js, &rust) {
        return Replay::Mismatch(p, a, b);
    }
    match record.get("after") {
        Some(after) => {
            let rust_after = serde_json::to_value(&options.locals).unwrap_or(Value::Null);
            compare(after, &rust_after)
        }
        None => Replay::Match,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options_json() -> Value {
        json!({
            "globals": [["g", {"address": 16, "type": "utinyint"}]],
            "locals": {"origin": 128, "ceiling": 144, "holes": [], "next": 128, "high": 128},
            "params": [{"name": "p", "type": "utinyint", "address": 32}],
            "functions": [["f", {"label": "f", "params": [{"address": 1, "width": 1}], "returnType": "void"}]],
            "arrays": [["a", {"elementType": "utinyint", "length": 4}]],
            "multiply": {"a": 1, "b": 3, "result": 5},
            "returnPair": 7,
            "fnName": "main",
            "fnFile": null,
            "originFiles": [["f", "f.8bs"]]
        })
    }

    #[test]
    fn options_decode_every_field() {
        let o = options_from_json(&options_json()).unwrap();
        assert_eq!(o.globals["g"].address, 16);
        assert_eq!(o.params[0].address, 32);
        assert_eq!(o.functions["f"].return_pair, None);
        assert_eq!(o.arrays["a"].length, Some(4));
        assert_eq!(o.multiply.map(|m| m.result), Some(5));
        assert_eq!(o.return_pair, Some(7));
        assert_eq!(o.fn_name.as_deref(), Some("main"));
        assert_eq!(o.fn_file, None);
        assert_eq!(o.origin_files["f"], "f.8bs");
        let bare = options_from_json(
            &json!({"locals": {"origin": 0, "ceiling": 0, "holes": [], "next": 0, "high": 0}}),
        )
        .unwrap();
        assert!(bare.globals.is_empty() && bare.multiply.is_none() && bare.params.is_empty());
        assert!(options_from_json(&json!({})).is_err());
        assert!(options_from_json(&json!({"locals": {}, "globals": [[1, 2]]})).is_err());
        let mut bad = options_json();
        bad["params"] = json!("x");
        assert!(options_from_json(&bad).is_err());
    }

    #[test]
    fn exit_counters_come_from_the_last_label() {
        let ok = json!({"program": [{"kind": "label", "name": "__8bs_exit_12"}]});
        assert_eq!(exit_counter(&ok), Some(12));
        assert_eq!(exit_counter(&json!({"ok": false})), None);
    }

    #[test]
    fn prov_is_stripped_everywhere() {
        let mut v = json!({"a": [{"prov": 1, "b": 2}], "prov": 3});
        strip_prov(&mut v);
        assert_eq!(v, json!({"a": [{"b": 2}]}));
    }

    #[test]
    fn replay_flags_bad_input_and_a_thrown_call() {
        let mut c = Counters::default();
        let rec = |body: Value, opts: Value| json!({"args": [body, opts], "result": {"ok": true, "program": [{"kind": "label", "name": "__8bs_exit_4"}], "parts": []}});
        assert!(matches!(replay(&json!({}), &mut c), Replay::Mismatch(p, ..) if p == "/args"));
        assert!(
            matches!(replay(&json!({"args": [[]], "result": {}}), &mut c), Replay::Mismatch(p, ..) if p == "/args")
        );
        assert_eq!(
            replay(&json!({"args": [[], {}], "throw": "boom"}), &mut c),
            Replay::Mismatch("/result".into(), json!("boom"), Value::Null)
        );
        assert_eq!(
            replay(&rec(json!([]), options_json()), &mut c),
            Replay::Match
        );
        assert_eq!(c.lower, 5);
        assert!(
            matches!(replay(&rec(json!("x"), options_json()), &mut c), Replay::Mismatch(p, ..) if p == "/args/0")
        );
        assert!(
            matches!(replay(&rec(json!([]), json!({})), &mut c), Replay::Mismatch(p, ..) if p == "/args/1")
        );
    }
}
