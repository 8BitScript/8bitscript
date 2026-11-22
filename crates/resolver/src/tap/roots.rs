//! The `<project>` and `<toolchain>` path tokens of a tapped record, and the roots they stand
//! for in this run (`EIGHTBS_FRONT_TAP_ROOTS`, JSON `{"toolchain": dir, "project": dir}`).
//!
//! A function that reads the file system replays only when the roots are known: its arguments
//! get the real paths back, and the paths in its result go back to tokens.

use serde_json::Value;

/// `(token, root)` pairs, project first (it may live inside the toolchain).
pub fn roots() -> Vec<(&'static str, String)> {
    let Ok(text) = std::env::var("EIGHTBS_FRONT_TAP_ROOTS") else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    [("project", "<project>"), ("toolchain", "<toolchain>")]
        .into_iter()
        .filter_map(|(key, token)| {
            let root = parsed.get(key)?.as_str()?;
            (!root.is_empty()).then(|| (token, root.to_string()))
        })
        .collect()
}

/// Whether the record names a token whose root this run does not have.
pub fn missing_root(record: &Value, roots: &[(&str, String)]) -> bool {
    let text = record.to_string();
    ["<project>", "<toolchain>"]
        .iter()
        .any(|token| text.contains(token) && !roots.iter().any(|(t, _)| t == token))
}

fn map_strings(value: &Value, f: &dyn Fn(&str) -> String) -> Value {
    match value {
        Value::String(s) => Value::String(f(s)),
        Value::Array(items) => Value::Array(items.iter().map(|v| map_strings(v, f)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), map_strings(v, f)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `value` with each token replaced by its root.
pub fn untokenize(value: &Value, roots: &[(&str, String)]) -> Value {
    map_strings(value, &|s| {
        roots.iter().fold(s.to_string(), |text, (token, root)| {
            text.replace(token, root)
        })
    })
}

/// `text` with `root` replaced by `token` where no name character follows it.
fn replace_root(text: &str, root: &str, token: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find(root) {
        let after = &rest[i + root.len()..];
        let name_char = after
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
        out.push_str(&rest[..i]);
        out.push_str(if name_char { root } else { token });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// `value` with each root replaced by its token.
pub fn tokenize(value: &Value, roots: &[(&str, String)]) -> Value {
    map_strings(value, &|s| {
        roots.iter().fold(s.to_string(), |text, (token, root)| {
            replace_root(&text, root, token)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tokens_round_trip_and_respect_name_boundaries() {
        let roots = vec![("<project>", "/p/x".to_string())];
        let v = json!({"a": ["/p/x/src/a.8bs", "/p/xy/a", "/p/x"]});
        let t = tokenize(&v, &roots);
        assert_eq!(
            t,
            json!({"a": ["<project>/src/a.8bs", "/p/xy/a", "<project>"]})
        );
        assert_eq!(untokenize(&t, &roots)["a"][0], "/p/x/src/a.8bs");
    }

    #[test]
    fn a_token_without_its_root_is_missing() {
        let record = json!({"args": ["<toolchain>/a"]});
        assert!(missing_root(&record, &[]));
        assert!(!missing_root(&record, &[("<toolchain>", "/t".to_string())]));
        assert!(!missing_root(&json!({"args": ["/a"]}), &[]));
    }
}
