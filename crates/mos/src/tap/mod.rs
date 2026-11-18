//! Replay of tapped JS calls, one module per tapped function (`xtask tap`).
//!
//! `scripts/oracle/mos-tap` records `{seq, fn, args, result, after?}` for each
//! call of the six tapped functions while the corpus builds. A unit's `replay`
//! reads `args` from its record, runs the Rust port, and compares the outcome
//! with `result` (and `after`) through [`first_difference`].

use serde_json::Value;

use crate::build::Counters;

pub mod allocate;
pub mod assemble_native;
pub mod build_data_section;
pub mod layout_frames;
pub mod link;
pub mod lower;

/// The outcome of replaying one record.
#[derive(Clone, Debug, PartialEq)]
pub enum Replay {
    Match,
    /// JSON pointer to the first difference, the JS value and the Rust value there.
    Mismatch(String, Value, Value),
    /// The port is not there yet (`unported:`), so the call proves nothing.
    Skip,
}

/// The tapped functions, as the JS names them.
pub const TAPPED: [&str; 6] = [
    "link",
    "buildDataSection",
    "allocate",
    "assembleNative",
    "layoutFrames",
    "lower",
];

/// Replays `record` of the JS function `name`; `None` when `name` is not tapped.
/// `counters` carries the label counters between the calls of one build.
pub fn replay(name: &str, record: &Value, counters: &mut Counters) -> Option<Replay> {
    Some(match name {
        "link" => link::replay(record, counters),
        "buildDataSection" => build_data_section::replay(record, counters),
        "allocate" => allocate::replay(record, counters),
        "assembleNative" => assemble_native::replay(record, counters),
        "layoutFrames" => layout_frames::replay(record, counters),
        "lower" => lower::replay(record, counters),
        _ => return None,
    })
}

/// Match, or a mismatch at the first difference between `js` and `rust`.
#[must_use]
pub fn compare(js: &Value, rust: &Value) -> Replay {
    match first_difference(js, rust) {
        None => Replay::Match,
        Some((pointer, a, b)) => Replay::Mismatch(pointer, a, b),
    }
}

/// The first difference between two JSON values as `(pointer, js, rust)`.
/// Numbers compare by value (`1` equals `1.0`), objects by key regardless of
/// order, arrays by position. A missing key reads as `null`.
#[must_use]
pub fn first_difference(js: &Value, rust: &Value) -> Option<(String, Value, Value)> {
    let mut pointer = String::new();
    walk(js, rust, &mut pointer)
}

fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn walk(js: &Value, rust: &Value, pointer: &mut String) -> Option<(String, Value, Value)> {
    let here = |p: &String| (p.clone(), js.clone(), rust.clone());
    match (js, rust) {
        (Value::Number(a), Value::Number(b)) => (a.as_f64() != b.as_f64()).then(|| here(pointer)),
        (Value::Array(a), Value::Array(b)) => {
            for i in 0..a.len().max(b.len()) {
                let (x, y) = (
                    a.get(i).unwrap_or(&Value::Null),
                    b.get(i).unwrap_or(&Value::Null),
                );
                if i >= a.len() || i >= b.len() {
                    return Some((format!("{pointer}/{i}"), x.clone(), y.clone()));
                }
                let keep = pointer.len();
                pointer.push_str(&format!("/{i}"));
                let found = walk(x, y, pointer);
                pointer.truncate(keep);
                if found.is_some() {
                    return found;
                }
            }
            None
        }
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().collect();
            keys.extend(b.keys().filter(|k| !a.contains_key(*k)));
            for key in keys {
                let (x, y) = (
                    a.get(key).unwrap_or(&Value::Null),
                    b.get(key).unwrap_or(&Value::Null),
                );
                let keep = pointer.len();
                pointer.push_str(&format!("/{}", escape(key)));
                let found = walk(x, y, pointer);
                pointer.truncate(keep);
                if found.is_some() {
                    return found;
                }
            }
            None
        }
        _ => (js != rust).then(|| here(pointer)),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn equal_values_match_whatever_the_key_order_or_number_spelling() {
        let js = json!({"a": 1, "b": [1, 2.0], "c": {"d": null}});
        let rust = json!({"c": {"d": null}, "b": [1.0, 2], "a": 1});
        assert_eq!(compare(&js, &rust), Replay::Match);
    }

    #[test]
    fn the_first_difference_gets_an_escaped_pointer() {
        let js = json!({"a/b": [1, {"~": 2}]});
        let rust = json!({"a/b": [1, {"~": 3}]});
        assert_eq!(
            compare(&js, &rust),
            Replay::Mismatch("/a~1b/1/~0".into(), json!(2), json!(3))
        );
    }

    #[test]
    fn length_and_key_differences_point_at_the_extra_element() {
        assert_eq!(
            first_difference(&json!([1, 2]), &json!([1])),
            Some(("/1".into(), json!(2), Value::Null))
        );
        assert_eq!(
            first_difference(&json!({"a": 1}), &json!({"a": 1, "b": 2})),
            Some(("/b".into(), Value::Null, json!(2)))
        );
        assert_eq!(
            first_difference(&json!("x"), &json!(1)),
            Some((String::new(), json!("x"), json!(1)))
        );
    }

    #[test]
    fn every_tapped_function_has_a_replay_and_stubs_skip() {
        let mut counters = Counters::default();
        for name in TAPPED {
            assert_eq!(
                replay(name, &json!({}), &mut counters),
                Some(Replay::Skip),
                "{name}"
            );
        }
        assert_eq!(replay("nope", &json!({}), &mut counters), None);
    }
}
