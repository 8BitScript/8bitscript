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
use syntax::{Node, NodeKind, children_mut, walk};

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

const REF: &str = "$ref:";

fn mark_refs(v: &Value, wanted: &mut BTreeSet<usize>) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.iter().map(|i| mark_refs(i, wanted)).collect()),
        Value::Object(map) => {
            if map.len() == 1
                && let Some(n) = map.get("$node").and_then(Value::as_u64)
                && let Ok(n) = usize::try_from(n)
            {
                wanted.insert(n);
                return json!({"type": "Identifier", "start": 0, "length": 0, "name": format!("{REF}{n}")});
            }
            Value::Object(
                map.iter()
                    .map(|(k, x)| (k.clone(), mark_refs(x, wanted)))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

fn placeholder(n: &Node) -> Option<usize> {
    match &n.kind {
        NodeKind::Identifier { name, .. } => name.strip_prefix(REF)?.parse().ok(),
        _ => None,
    }
}

fn size(n: &Node) -> usize {
    let mut count = 0;
    walk(n, &mut |_, _| count += 1);
    count
}

fn expand(
    n: &mut Node,
    counter: &mut usize,
    wanted: &BTreeSet<usize>,
    store: &mut BTreeMap<usize, Node>,
) -> Result<(), String> {
    let at = *counter;
    *counter += 1;
    for child in children_mut(n) {
        if let Some(target) = placeholder(child) {
            let copy = store
                .get(&target)
                .ok_or_else(|| format!("$node {target} refers to a node not seen yet"))?
                .clone();
            *counter += size(&copy);
            *child = copy;
        } else {
            expand(child, counter, wanted, store)?;
        }
    }
    if wanted.contains(&at) {
        store.insert(at, n.clone());
    }
    Ok(())
}

/// `value`, a tree in graph form, with every `{"$node": n}` replaced by the node at pre-order
/// index `n` of the full tree (counted with multiplicity, as the tap's encoder does).
///
/// # Errors
/// A text when `value` is not a tree or a reference points forward.
pub fn expand_refs(value: &Value) -> Result<Value, String> {
    let mut wanted = BTreeSet::new();
    let marked = mark_refs(value, &mut wanted);
    let mut root: Node = serde_json::from_value(marked).map_err(|e| format!("tree: {e}"))?;
    expand(&mut root, &mut 0, &wanted, &mut BTreeMap::new())?;
    serde_json::to_value(&root).map_err(|e| e.to_string())
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
