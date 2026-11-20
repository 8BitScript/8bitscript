//! The pair normalizer (port spec 4.3). Both sides of a pair, the AST of the
//! old text from the JS parser and the AST of the converted text from the
//! Rust parser, go through [`normalize`]; what is left must be equal. It
//! works on the JSON dump (the shape both sides share), so it needs no
//! second node type. Used only by the bridge's check export and the pair
//! tests; it is deleted with the migrate code.

use serde_json::{Map, Number, Value, json};

/// One place where two normalized trees differ.
#[derive(Debug, Clone, PartialEq)]
pub struct Difference {
    pub path: String,
    pub old: Value,
    pub new: Value,
}

/// Apply N1-N8 (and number canonicalization) to an AST dump.
#[must_use]
pub fn normalize(mut value: Value) -> Value {
    walk(&mut value);
    value
}

/// Normalize both trees and list up to `limit` differences, in key order.
#[must_use]
pub fn differences(old: &Value, new: &Value, limit: usize) -> Vec<Difference> {
    let mut out = Vec::new();
    compare(
        &normalize(old.clone()),
        &normalize(new.clone()),
        &mut String::new(),
        limit,
        &mut out,
    );
    out
}

fn type_of(map: &Map<String, Value>) -> Option<&str> {
    map.get("type").and_then(Value::as_str)
}

fn is_type(value: &Value, name: &str) -> bool {
    value.as_object().and_then(type_of) == Some(name)
}

fn walk(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(walk),
        Value::Number(n) => {
            // `1` from JS text and `1.0` from a serialized f64 are one number.
            if let Some(f) = n.as_f64().and_then(Number::from_f64) {
                *n = f;
            }
        }
        Value::Object(map) => {
            // N1
            map.remove("start");
            map.remove("length");
            match type_of(map).map(str::to_string).as_deref() {
                Some("IntegerLiteral") => {
                    map.remove("raw"); // N2
                }
                Some("VariableDeclaration") => {
                    map.remove("immutable"); // N8
                }
                Some("StringLiteral") => decode_string(map), // N7
                Some("ImportDeclaration") => import_source(map), // N6
                Some("FunctionDeclaration") => void_return(map), // N3
                Some("ExpressionStatement") => {
                    if let Some(expr) = map.get_mut("expression") {
                        update_to_assignment(expr); // N4
                    }
                }
                Some("IfStatement") => {
                    block_of(map, "consequent");
                    if map.get("alternate").is_some_and(|alt| {
                        !alt.is_null()
                            && !is_type(alt, "IfStatement")
                            && !is_type(alt, "BlockStatement")
                    }) {
                        block_of(map, "alternate");
                    }
                }
                Some("WhileStatement") => block_of(map, "body"),
                Some("ForStatement") => {
                    if let Some(update) = map.get_mut("update") {
                        update_to_assignment(update); // N4
                    }
                    block_of(map, "body");
                }
                _ => {}
            }
            map.values_mut().for_each(walk);
        }
        _ => {}
    }
}

/// N3: no return type is `void` with no arguments.
fn void_return(map: &mut Map<String, Value>) {
    if map.get("returnType").is_none_or(Value::is_null) {
        map.insert(
            "returnType".to_string(),
            json!({"type": "TypeReference", "name": "void", "typeArguments": []}),
        );
    }
}

/// N4: a postfix or prefix `++`/`--` used as a statement is `+= 1`/`-= 1`.
fn update_to_assignment(expr: &mut Value) {
    if !is_type(expr, "UpdateExpression") {
        return;
    }
    let Some(map) = expr.as_object() else { return };
    let operator = match map.get("operator").and_then(Value::as_str) {
        Some("++") => "+=",
        Some("--") => "-=",
        _ => return,
    };
    let argument = map.get("argument").cloned().unwrap_or(Value::Null);
    *expr = json!({
        "type": "AssignmentExpression",
        "operator": operator,
        "left": argument,
        "right": {"type": "IntegerLiteral", "value": 1, "radix": 10},
    });
}

/// N5: a statement where a block is allowed stands for a block of it.
fn block_of(map: &mut Map<String, Value>, key: &str) {
    let Some(slot) = map.get_mut(key) else { return };
    if slot.is_null() || is_type(slot, "BlockStatement") {
        return;
    }
    let stmt = slot.take();
    *slot = json!({"type": "BlockStatement", "body": [stmt]});
}

/// N6: the import source without its source extension, and no `usePath`. The
/// old tree never has `usePath`, so its quoted path is stripped to meet the
/// new tree's path form. The new parser only ever says `usePath: true`.
fn import_source(map: &mut Map<String, Value>) {
    map.remove("usePath");
    let Some(Value::Object(source)) = map.get_mut("source") else {
        return;
    };
    if let Some(Value::String(text)) = source.get_mut("value") {
        for ext in [".8bs", ".8bx", ".8bg", ".8ba"] {
            if let Some(stripped) = text.strip_suffix(ext) {
                *text = stripped.to_string();
                break;
            }
        }
    }
}

/// N7: compare string values after decoding escapes (`\n`, `\t`, `\r`, `\0`;
/// any other escaped character stands for itself).
fn decode_string(map: &mut Map<String, Value>) {
    let Some(Value::String(text)) = map.get_mut("value") else {
        return;
    };
    if !text.contains('\\') {
        return;
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('0') => out.push('\0'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    *text = out;
}

fn compare(old: &Value, new: &Value, path: &mut String, limit: usize, out: &mut Vec<Difference>) {
    if out.len() >= limit || old == new {
        return;
    }
    let here = path.len();
    match (old, new) {
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                if !path.is_empty() {
                    path.push('.');
                }
                path.push_str(key);
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) => compare(x, y, path, limit, out),
                    (x, y) => push(out, path, x, y, limit),
                }
                path.truncate(here);
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                path.push_str(&format!("[{i}]"));
                compare(x, y, path, limit, out);
                path.truncate(here);
            }
        }
        _ => push(out, path, Some(old), Some(new), limit),
    }
}

fn push(
    out: &mut Vec<Difference>,
    path: &str,
    old: Option<&Value>,
    new: Option<&Value>,
    limit: usize,
) {
    if out.len() < limit {
        out.push(Difference {
            path: path.to_string(),
            old: old.cloned().unwrap_or(Value::Null),
            new: new.cloned().unwrap_or(Value::Null),
        });
    }
}
