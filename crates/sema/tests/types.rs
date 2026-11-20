//! Replays `fixtures/types.json` (made by `gen/types.mjs` in Node).

use front_replay::{Replay, compare};
use sema::types::{
    INTEGER_RANGES, INTEGER_TYPE_NAMES, PRIMITIVE_INTEGER_TYPES, narrowest_integer_type,
    resolve_integer_type, storage_bytes,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn rows() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/types.json")).unwrap()
}

fn integer_type(t: &sema::types::IntegerType) -> Value {
    json!({
        "canonicalName": t.canonical_name,
        "legacyAlias": t.legacy_alias,
        "aliases": t.aliases,
        "signed": t.signed,
        "bits": t.bits,
        "bytes": t.bytes,
        "min": t.min,
        "max": t.max,
        "summary": t.summary,
    })
}

#[test]
fn types_match_js() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for row in rows() {
        let name = row["fn"].as_str().unwrap().to_string();
        let args = row["args"].as_array().unwrap();
        let got = match name.as_str() {
            "PRIMITIVE_INTEGER_TYPES" => {
                Value::Array(PRIMITIVE_INTEGER_TYPES.iter().map(integer_type).collect())
            }
            "INTEGER_TYPE_NAMES" => json!(*INTEGER_TYPE_NAMES),
            "INTEGER_RANGES" => json!(*INTEGER_RANGES),
            "resolveIntegerType" => {
                resolve_integer_type(args[0].as_str().unwrap()).map_or(Value::Null, integer_type)
            }
            "storageBytes" => json!(storage_bytes(args[0].as_str().unwrap())),
            "narrowestIntegerType" => json!(narrowest_integer_type(args[0].as_f64().unwrap())),
            other => panic!("unknown fn {other}"),
        };
        assert_eq!(
            compare(&row["result"], &got),
            Replay::Match,
            "{name} {args:?}"
        );
        *seen.entry(name).or_default() += 1;
    }
    assert_eq!(seen.len(), 6, "{seen:?}");
    assert!(seen["narrowestIntegerType"] >= 30);
}

#[test]
fn spellings_share_one_descriptor() {
    let a = resolve_integer_type("u8").unwrap();
    let b = resolve_integer_type("utinyint").unwrap();
    assert!(std::ptr::eq(a, b));
    assert!(resolve_integer_type("u64").is_none());
}
