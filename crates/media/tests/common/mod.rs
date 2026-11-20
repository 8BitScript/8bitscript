//! Shared by the media fixture tests.

use serde_json::{Number, Value};

/// JS has one number type; serde_json keeps integers and floats apart. Turn
/// every number into an f64 so `1` and `1.0` compare equal.
pub fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => n
            .as_f64()
            .and_then(Number::from_f64)
            .map_or_else(|| v.clone(), Value::Number),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), norm(x))).collect()),
        other => other.clone(),
    }
}

pub fn rows(src: &str) -> Vec<Value> {
    serde_json::from_str(src).expect("fixtures parse")
}

pub fn json<T: serde::Serialize>(t: &T) -> Value {
    norm(&serde_json::to_value(t).expect("serializes"))
}
