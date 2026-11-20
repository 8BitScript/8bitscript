//! Tap replay for `foldCompileTime` (`packages/compiler/src/fold/index.mjs:597`).
//!
//! `args` is `[ast, file, options]` (the tree as plain JSON; `file` and `options` may be absent),
//! `result` the diagnostics and `after` the tree as the call left it.

use diagnostics::Diagnostic;
use front_replay::{Replay, compare};
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use syntax::{Node, NodeKind, children_mut};

use crate::facts::Json;
use crate::{DefineSite, DefineValue, Options, fold_compile_time};

/// An object option as the JS object it is, in `Object.keys` order.
fn object(value: Option<&Value>) -> Option<IndexMap<String, Json>> {
    let parsed = Json::parse(&value?.to_string()).ok()?;
    match &parsed {
        Json::Object(map) => Some(map.clone()),
        _ => None,
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

/// A site a caller already collected, as the tap writes it.
fn site(value: &Value) -> Option<DefineSite> {
    let default_value = match value.get("default")? {
        Value::Bool(b) => DefineValue::Bool(*b),
        Value::String(s) => DefineValue::Str(s.clone()),
        other => DefineValue::Int(other.as_f64()?),
    };
    Some(DefineSite {
        name: value.get("name")?.as_str()?.to_string(),
        kind: match default_value {
            DefineValue::Bool(_) => "bool",
            DefineValue::Int(_) => "int",
            DefineValue::Str(_) => "string",
        },
        default_value,
        file: value.get("file")?.as_str()?.to_string(),
        start: u32::try_from(value.get("start")?.as_u64()?).ok()?,
    })
}

/// The `n` of every `{"$node": n}` reference in `value`, and `value` with each one swapped for a
/// leaf that carries `n` in its `start`.
fn take_references(value: &Value, wanted: &mut HashSet<u32>) -> Value {
    match value {
        Value::Object(map) => {
            if let (1, Some(n)) = (map.len(), map.get("$node").and_then(Value::as_u64)) {
                let n = u32::try_from(n).unwrap_or(u32::MAX);
                wanted.insert(n);
                return json!({"type": "Identifier", "name": REFERENCE, "start": n, "length": 0});
            }
            Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), take_references(v, wanted)))
                    .collect(),
            )
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| take_references(v, wanted)).collect())
        }
        other => other.clone(),
    }
}

const REFERENCE: &str = "$node";

/// Numbers `node` in pre-order and swaps each reference leaf for a clone of the node it names. The
/// clone keeps every id, as a JS object seen twice does. The index of a node counts every visit,
/// shared ones included, as the encoder's numbering does.
fn number_expanding(
    node: &mut Node,
    next: &mut u32,
    table: &mut HashMap<u32, Node>,
    wanted: &HashSet<u32>,
) {
    if let NodeKind::Identifier { name, .. } = &node.kind
        && name == REFERENCE
    {
        if let Some(target) = table.get(&node.start) {
            *node = target.clone();
            let mut size = 0u32;
            syntax::walk(node, &mut |_, _| size += 1);
            *next += size;
        }
        return;
    }
    let index = *next;
    node.id = syntax::NodeId(index);
    *next += 1;
    for child in children_mut(node) {
        number_expanding(child, next, table, wanted);
    }
    if wanted.contains(&index) {
        table.insert(index, node.clone());
    }
}

/// A tree as the tap writes it: plain JSON, with a node seen a second time as `{"$node": n}`.
fn decode_tree(tree: &Value) -> Result<Node, String> {
    let mut wanted = HashSet::new();
    let plain = take_references(tree, &mut wanted);
    let mut root: Node = serde_json::from_value(plain).map_err(|e| e.to_string())?;
    number_expanding(&mut root, &mut 0, &mut HashMap::new(), &wanted);
    Ok(root)
}

/// Whether `tree` holds a `#package(..)` call: a CallExpression whose callee is the compile-time
/// identifier `package`.
fn has_package_call(tree: &Value) -> bool {
    match tree {
        Value::Object(map) => {
            let is_call = map.get("type").and_then(Value::as_str) == Some("CallExpression")
                && map.get("callee").is_some_and(|callee| {
                    callee.get("type").and_then(Value::as_str) == Some("Identifier")
                        && callee.get("name").and_then(Value::as_str) == Some("package")
                        && callee.get("compileTime") == Some(&Value::Bool(true))
                });
            is_call || map.values().any(has_package_call)
        }
        Value::Array(items) => items.iter().any(has_package_call),
        _ => false,
    }
}

/// A `#package` call in a file the tap wrote as `<project>/..`: `#package` reads the file system
/// there, so only the project the corpus cloned for the build can answer it, and a replay without
/// that project cannot. `fixtures/fold.json` covers `#package` over real files.
fn reads_project_package(args: &[Value]) -> bool {
    args.get(1)
        .and_then(Value::as_str)
        .is_some_and(|file| file.starts_with("<project>"))
        && args.first().is_some_and(has_package_call)
}

/// `value` of every literal a `#package` fold wrote (its `raw` is `#package(..)`) set to null: the
/// one part of the tree that depends on the files read.
fn mask_package_values(tree: &mut Value) {
    match tree {
        Value::Object(map) => {
            let folded = map
                .get("raw")
                .and_then(Value::as_str)
                .is_some_and(|raw| raw.starts_with("#package("));
            if folded {
                map.insert("value".to_string(), Value::Null);
            }
            for value in map.values_mut() {
                mask_package_values(value);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(mask_package_values),
        _ => {}
    }
}

/// What one call left behind.
pub struct Outcome {
    pub diagnostics: Vec<Diagnostic>,
    /// The tree after the fold.
    pub ast: Option<Node>,
    /// The sites `defineSites` collected, when the call was given an array.
    pub sites: Option<Vec<DefineSite>>,
}

/// Runs the port on the `args` of a record. `Err` is the text of a JS exception (the call
/// threw), or a message when `args` does not decode.
pub fn run(args: &[Value]) -> Result<Outcome, String> {
    let mut ast: Option<Node> = match args.first() {
        None | Some(Value::Null) => None,
        Some(tree) => Some(decode_tree(tree)?),
    };
    let file = text(args.get(1)).unwrap_or_else(|| "<unknown>".to_string());
    let given = args.get(2).filter(|v| v.is_object());
    let field = |name: &str| given.and_then(|o| o.get(name));
    let options = Options {
        frame_rate: field("frameRate").and_then(Value::as_f64).unwrap_or(60.0),
        machine: text(field("machine")),
        facts: object(field("facts")),
        locale: text(field("locale")),
        defines: object(field("defines")),
    };
    let mut sites: Vec<DefineSite> = match field("defineSites") {
        Some(Value::Array(list)) => list.iter().filter_map(site).collect(),
        _ => Vec::new(),
    };
    let sites_given = field("defineSites").is_some_and(Value::is_array);
    let diagnostics = fold_compile_time(
        ast.as_mut(),
        &file,
        &options,
        sites_given.then_some(&mut sites),
    )?;
    Ok(Outcome {
        diagnostics,
        ast,
        sites: sites_given.then_some(sites),
    })
}

#[must_use]
pub fn replay(record: &Value) -> Replay {
    let Some(args) = record.get("args").and_then(Value::as_array) else {
        return Replay::Skip;
    };
    let outcome = run(args);
    if let Some(thrown) = record.get("throw") {
        // The call threw in JS: the same error is a match; no recorded R7.8 site applies here.
        let expected = thrown.as_str().map(str::to_string);
        return match outcome {
            Err(message) if expected.as_deref() == Some(message.as_str()) => Replay::Match,
            Err(message) => Replay::Mismatch("/throw".into(), thrown.clone(), json!(message)),
            Ok(_) => Replay::Mismatch("/throw".into(), thrown.clone(), Value::Null),
        };
    }
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(message) => return Replay::Mismatch("/args".into(), Value::Null, json!(message)),
    };
    let got = serde_json::to_value(&outcome.diagnostics).unwrap_or(Value::Null);
    let first = compare(record.get("result").unwrap_or(&Value::Null), &got);
    if first != Replay::Match {
        return first;
    }
    let mut after = serde_json::to_value(&outcome.ast).unwrap_or(Value::Null);
    if reads_project_package(args) {
        // Only the folded values are unknowable here: everything else is compared, and a record
        // that matches is a skip, not a match.
        let mut expected = record.get("after").cloned().unwrap_or(Value::Null);
        mask_package_values(&mut expected);
        mask_package_values(&mut after);
        return match compare(&expected, &after) {
            Replay::Match => Replay::Skip,
            other => other,
        };
    }
    compare(record.get("after").unwrap_or(&Value::Null), &after)
}
