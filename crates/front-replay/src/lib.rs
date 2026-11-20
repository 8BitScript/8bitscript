//! The outcome of replaying one tapped JS call, for the front-end crates.
//!
//! Same shape as `mos::tap::Replay`. The front-end crates cannot depend on `mos`, so the type
//! is repeated here; `xtask tap --front` maps one onto the other.

use serde_json::Value;

/// The outcome of replaying one record.
#[derive(Clone, Debug, PartialEq)]
pub enum Replay {
    Match,
    /// JSON pointer to the first difference, the JS value and the Rust value there.
    Mismatch(String, Value, Value),
    /// The function is not replayed yet, so the call proves nothing.
    Skip,
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
                // A key one side lacks differs from one it holds as null (R3.4, Absent against
                // Null), so it is reported even when the other value is null.
                let found = if a.contains_key(key) == b.contains_key(key) {
                    walk(x, y, pointer)
                } else {
                    Some((pointer.clone(), x.clone(), y.clone()))
                };
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
    fn an_absent_key_differs_from_an_explicit_null() {
        assert_eq!(
            compare(&json!({"component": null}), &json!({})),
            Replay::Mismatch("/component".into(), Value::Null, Value::Null)
        );
        assert_eq!(
            compare(&json!({}), &json!({"a": {"component": null}})),
            Replay::Mismatch("/a".into(), Value::Null, json!({"component": null}))
        );
        assert_eq!(
            compare(&json!({"a": {"component": null}}), &json!({"a": {}})),
            Replay::Mismatch("/a/component".into(), Value::Null, Value::Null)
        );
        assert_eq!(
            compare(&json!({"component": null}), &json!({"component": null})),
            Replay::Match
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
}
