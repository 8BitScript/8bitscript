//! Canonical dump format (spec section 2.3): sorted keys, two-space indent,
//! JS number text, `\n` at the end; `bytes.hex`; root tokens in paths.

use serde_json::Value;

/// Serialises `v` as the JS writer does: `JSON.stringify(sortKeys(v), null, 2) + "\n"`.
#[must_use]
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write_value(v, 0, &mut out);
    out.push('\n');
    out
}

fn indent(depth: usize, out: &mut String) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

fn write_value(v: &Value, depth: usize, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => out.push_str(&i.to_string()),
            (_, Some(u)) => out.push_str(&u.to_string()),
            _ => out.push_str(&jsnum::number_to_string(n.as_f64().unwrap_or(f64::NAN))),
        },
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(items) if items.is_empty() => out.push_str("[]"),
        Value::Array(items) => {
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                indent(depth + 1, out);
                write_value(item, depth + 1, out);
                out.push_str(if i + 1 < items.len() { ",\n" } else { "\n" });
            }
            indent(depth, out);
            out.push(']');
        }
        Value::Object(map) if map.is_empty() => out.push_str("{}"),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| jsnum::cmp_utf16(a, b));
            out.push_str("{\n");
            for (i, key) in keys.iter().enumerate() {
                indent(depth + 1, out);
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push_str(": ");
                write_value(&map[key.as_str()], depth + 1, out);
                out.push_str(if i + 1 < keys.len() { ",\n" } else { "\n" });
            }
            indent(depth, out);
            out.push('}');
        }
    }
}

/// `bytes.hex`: lowercase hex, 16 bytes per line, one space between bytes.
#[must_use]
pub fn hex_dump(bytes: &[u8]) -> String {
    let mut out = String::new();
    for line in bytes.chunks(16) {
        let words: Vec<String> = line.iter().map(|b| format!("{b:02x}")).collect();
        out.push_str(&words.join(" "));
        out.push('\n');
    }
    out
}

/// Reads a `bytes.hex` text back to bytes; `None` when it is not hex.
#[must_use]
pub fn parse_hex(text: &str) -> Option<Vec<u8>> {
    text.split_whitespace()
        .map(|w| {
            if w.len() == 2 {
                u8::from_str_radix(w, 16).ok()
            } else {
                None
            }
        })
        .collect()
}

/// The two roots a dump replaces with tokens.
pub struct Roots<'a> {
    pub toolchain: &'a str,
    pub project: &'a str,
}

/// Replaces an absolute root prefix with `<toolchain>` or `<project>`.
#[must_use]
pub fn tokenize_path(path: &str, roots: &Roots) -> String {
    for (root, token) in [(roots.toolchain, "<toolchain>"), (roots.project, "<project>")] {
        if root.is_empty() {
            continue;
        }
        if path == root {
            return token.to_string();
        }
        if let Some(rest) = path.strip_prefix(root).and_then(|r| r.strip_prefix('/')) {
            return format!("{token}/{rest}");
        }
    }
    path.to_string()
}
