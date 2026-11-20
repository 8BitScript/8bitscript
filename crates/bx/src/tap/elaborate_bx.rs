//! Tap replay for `elaborateBx` (`packages/compiler/src/bx/elaborate.mjs:400`).
//!
//! A record's `args` are `[ast, symbols, file, foreign?]`. `symbols` is the binder's flat name
//! map in the graph form of `sema::tap::graph` (`[[name, symbol], ...]`); the decoding is the one
//! of `check_bx`, with the node references kept. A component imported from another module has
//! its props' nodes in that module's tree, which a tap record does not carry: such symbols go
//! into module 1, and `foreign` (a fixture row's extra argument) is that module's tree. Without
//! it, a call that needs one of those nodes replays as `Skip`.
//!
//! The JS result and `after` are the same tree, written with `{"$node": n}` for a node it shares
//! between parents (the statements around a slot). The Rust tree has no sharing, so the expected
//! value is expanded first ([`expand_refs`]).

use std::collections::{BTreeMap, BTreeSet};

use front_replay::{Replay, compare};
use indexmap::IndexMap;
use sema::binder::types::{Bound, ModuleId, Scope, ScopeId, Symbol, SymbolId, SymbolKind};
use serde_json::{Value, json};
use syntax::{Node, NodeKind, children};

use super::check_bx::{collect, decode_symbol, sym_id};
use crate::elaborate::{MissingNode, elaborate_bx};

/// The decoded arguments of one `elaborateBx` call.
pub struct ElaborateArgs {
    pub ast: Node,
    pub file: String,
    /// Module 0 is the call's module; module 1 holds the imported components' own symbols.
    pub modules: Vec<Bound>,
    /// The tree module 1 was bound from, when the row carries it.
    pub foreign: Option<Node>,
}

/// Reads a record's (or a fixture row's) `args`.
///
/// # Errors
/// A text naming the argument that does not have the recorded shape.
pub fn decode_args(args: &[Value]) -> Result<ElaborateArgs, String> {
    let ast = args.first().ok_or("missing ast")?;
    let mut ast: Node = serde_json::from_value(ast.clone()).map_err(|e| format!("ast: {e}"))?;
    syntax::number_nodes(&mut ast);
    let symbols = args.get(1).ok_or("missing symbols")?;
    let file = args
        .get(2)
        .and_then(Value::as_str)
        .ok_or("missing file")?
        .to_string();
    let foreign = match args.get(3) {
        None | Some(Value::Null) => None,
        Some(v) => {
            let mut tree: Node =
                serde_json::from_value(v.clone()).map_err(|e| format!("foreign: {e}"))?;
            syntax::number_nodes(&mut tree);
            Some(tree)
        }
    };
    let mut found = BTreeMap::new();
    collect(symbols, &mut found);
    let count = found.keys().next_back().map_or(0, |max| max + 1);
    let table: Vec<Symbol> = (0..count)
        .map(|id| {
            found
                .get(&id)
                .map_or_else(|| decode_symbol(&Value::Null), |v| decode_symbol(v))
        })
        .collect();
    // The components an import stands for live in another module.
    let foreign_ids: BTreeSet<u32> = found
        .values()
        .filter(|v| v.get("kind").and_then(Value::as_str) == Some("Import"))
        .filter_map(|v| v.get("component").and_then(sym_id))
        .collect();
    let mut local = table.clone();
    for symbol in &mut local {
        if symbol.kind != SymbolKind::Import {
            continue;
        }
        for link in [&mut symbol.component, &mut symbol.target] {
            if let jsnum::Nullable::Value(r) = link
                && foreign_ids.contains(&r.symbol.0)
            {
                r.module = ModuleId(1);
            }
        }
    }
    let mut flat = IndexMap::new();
    for entry in symbols.as_array().ok_or("symbols is not a list")? {
        let (Some(name), Some(sym)) = (
            entry.get(0).and_then(Value::as_str),
            entry.get(1).and_then(sym_id),
        ) else {
            return Err("symbols entry is not [name, symbol]".into());
        };
        flat.insert(name.to_string(), SymbolId(sym));
    }
    let bound = |symbol_table: Vec<Symbol>, symbols: IndexMap<String, SymbolId>| Bound {
        scopes: vec![Scope {
            parent: None,
            symbols: IndexMap::new(),
        }],
        symbol_table,
        module_scope: ScopeId(0),
        symbols,
        imports: Vec::new(),
        scope_of: IndexMap::new(),
        file: file.clone(),
    };
    let modules = vec![bound(local, flat), bound(table, IndexMap::new())];
    Ok(ElaborateArgs {
        ast,
        file,
        modules,
        foreign,
    })
}

/// The program after `elaborate_bx`, as JSON.
///
/// # Errors
/// [`MissingNode`] when the call needs a tree the record does not carry.
pub fn run(args: &ElaborateArgs) -> Result<Value, MissingNode> {
    let mut ast = args.ast.clone();
    let trees = [None, args.foreign.as_ref()];
    elaborate_bx(&mut ast, &args.modules, ModuleId(0), &trees, &args.file)?;
    Ok(serde_json::to_value(&ast).unwrap_or(Value::Null))
}

const SLOT: &str = "$slot:";

fn ref_target(v: &Value) -> Option<usize> {
    let map = v.as_object()?;
    if map.len() != 1 {
        return None;
    }
    usize::try_from(map.get("$node")?.as_u64()?).ok()
}

fn is_node_like(v: &Value) -> bool {
    ref_target(v).is_some() || v.get("type").is_some_and(Value::is_string)
}

fn leaf(at: &str) -> Value {
    json!({"type": "Identifier", "start": 0, "length": 0, "name": format!("{SLOT}{at}")})
}

/// Where the node-like children of the object `v` sit, in the order `syntax::children` visits
/// them: `(key, index)`, the index being `None` for a single node and the array position
/// otherwise. The order is the port's own: a shallow copy of `v`, each child replaced by a leaf
/// that names its place, goes through `syntax::Node`. Keys the port does not know are left
/// alone, so they stay in `v` for the comparison.
fn child_places(v: &Value) -> Result<Vec<(String, Option<usize>)>, String> {
    let Some(map) = v.as_object() else {
        return Ok(Vec::new());
    };
    let mut shallow = map.clone();
    for (key, x) in map {
        if is_node_like(x) {
            shallow.insert(key.clone(), leaf(key));
        } else if let Some(items) = x.as_array()
            && items.iter().any(is_node_like)
        {
            let replaced = items
                .iter()
                .enumerate()
                .map(|(i, item)| {
                    if is_node_like(item) {
                        leaf(&format!("{key}:{i}"))
                    } else {
                        item.clone()
                    }
                })
                .collect();
            shallow.insert(key.clone(), Value::Array(replaced));
        }
    }
    let node: Node =
        serde_json::from_value(Value::Object(shallow)).map_err(|e| format!("tree: {e}"))?;
    Ok(children(&node)
        .into_iter()
        .filter_map(|c| match &c.kind {
            NodeKind::Identifier { name, .. } => {
                let at = name.strip_prefix(SLOT)?;
                Some(match at.rsplit_once(':') {
                    Some((key, i)) if map.get(key).is_some_and(Value::is_array) => {
                        (key.to_string(), i.parse().ok())
                    }
                    _ => (at.to_string(), None),
                })
            }
            _ => None,
        })
        .collect())
}

fn slot_mut<'a>(v: &'a mut Value, key: &str, index: Option<usize>) -> Option<&'a mut Value> {
    let x = v.get_mut(key)?;
    match index {
        Some(i) => x.get_mut(i),
        None => Some(x),
    }
}

fn size(v: &Value) -> Result<usize, String> {
    let mut count = 1;
    for (key, index) in child_places(v)? {
        let x = v.get(&key).ok_or("child vanished")?;
        count += size(match index {
            Some(i) => x.get(i).ok_or("child vanished")?,
            None => x,
        })?;
    }
    Ok(count)
}

fn expand(
    v: &mut Value,
    counter: &mut usize,
    wanted: &BTreeSet<usize>,
    store: &mut BTreeMap<usize, Value>,
) -> Result<(), String> {
    let at = *counter;
    *counter += 1;
    for (key, index) in child_places(v)? {
        let child = slot_mut(v, &key, index).ok_or("child vanished")?;
        if let Some(target) = ref_target(child) {
            let copy = store
                .get(&target)
                .ok_or_else(|| format!("$node {target} refers to a node not seen yet"))?
                .clone();
            *counter += size(&copy)?;
            *child = copy;
        } else {
            expand(child, counter, wanted, store)?;
        }
    }
    if wanted.contains(&at) {
        store.insert(at, v.clone());
    }
    Ok(())
}

fn collect_refs(v: &Value, wanted: &mut BTreeSet<usize>) {
    match v {
        Value::Array(items) => items.iter().for_each(|i| collect_refs(i, wanted)),
        Value::Object(map) => {
            if let Some(n) = ref_target(v) {
                wanted.insert(n);
            } else {
                map.values().for_each(|x| collect_refs(x, wanted));
            }
        }
        _ => {}
    }
}

/// `value`, a tree in graph form, with every `{"$node": n}` replaced by the node at pre-order
/// index `n` of the full tree (counted with multiplicity, as the tap's encoder does). The tree
/// stays a `serde_json::Value` throughout, so a key the port does not write, or one absent where
/// it writes `null`, still shows in the comparison.
///
/// # Errors
/// A text when `value` is not a tree or a reference points forward.
pub fn expand_refs(value: &Value) -> Result<Value, String> {
    let mut wanted = BTreeSet::new();
    collect_refs(value, &mut wanted);
    let mut root = value.clone();
    expand(&mut root, &mut 0, &wanted, &mut BTreeMap::new())?;
    Ok(root)
}

/// Runs the port on the record's arguments and compares with its `result` and `after`.
#[must_use]
pub fn replay(record: &Value) -> Replay {
    let Some(args) = record.get("args").and_then(Value::as_array) else {
        return Replay::Skip;
    };
    let decoded = match decode_args(args) {
        Ok(d) => d,
        Err(message) => {
            return Replay::Mismatch("/args".into(), Value::Null, Value::String(message));
        }
    };
    let Ok(got) = run(&decoded) else {
        return Replay::Skip;
    };
    let mut checked = false;
    for key in ["result", "after"] {
        let Some(expected) = record.get(key).filter(|v| v.is_object()) else {
            continue;
        };
        checked = true;
        let expected = match expand_refs(expected) {
            Ok(v) => v,
            Err(message) => {
                return Replay::Mismatch(format!("/{key}"), Value::Null, Value::String(message));
            }
        };
        if let Replay::Mismatch(p, a, b) = compare(&expected, &got) {
            return Replay::Mismatch(format!("/{key}{p}"), a, b);
        }
    }
    if checked { Replay::Match } else { Replay::Skip }
}
