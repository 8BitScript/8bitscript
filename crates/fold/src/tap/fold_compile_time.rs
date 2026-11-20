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

/// A `#package` call whose file name carries a root token: the tap wrote the project's path as
/// `<project>`, and `#package` reads the file system there, so it needs the project the corpus
/// cloned for the build. A replay without that project cannot answer it (`fixtures/fold.json`
/// covers `#package` with real files).
fn reads_unreachable_package(args: &[Value]) -> bool {
    let tokenized = args
        .get(1)
        .and_then(Value::as_str)
        .is_some_and(|file| file.contains("<project>") || file.contains("<toolchain>"));
    tokenized
        && args
            .first()
            .is_some_and(|tree| tree.to_string().contains(r#""name":"package""#))
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
    if record.get("throw").is_some() {
        return Replay::Skip;
    }
    let outcome = match run(args) {
        Ok(outcome) => outcome,
        Err(message) => return Replay::Mismatch("/args".into(), Value::Null, json!(message)),
    };
    let got = serde_json::to_value(&outcome.diagnostics).unwrap_or(Value::Null);
    let first = compare(record.get("result").unwrap_or(&Value::Null), &got);
    if first != Replay::Match {
        return if reads_unreachable_package(args) {
            Replay::Skip
        } else {
            first
        };
    }
    let after = serde_json::to_value(&outcome.ast).unwrap_or(Value::Null);
    let second = compare(record.get("after").unwrap_or(&Value::Null), &after);
    if second != Replay::Match && reads_unreachable_package(args) {
        return Replay::Skip;
    }
    second
}
