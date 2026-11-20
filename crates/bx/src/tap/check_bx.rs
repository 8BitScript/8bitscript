//! Tap replay for `checkBx` (`packages/compiler/src/bx/check.mjs:28`).
//!
//! A record's `args` are `[ast, file, symbols, options?, stack?]`. `symbols` is the binder's
//! flat name map in the graph form of `sema::tap::graph`: `[[name, symbol], ...]`, a symbol
//! written out in full where it is first met (possibly inside a scope's own map) and as
//! `{"$sym": n}` after. [`decode_args`] reads that into one synthetic [`Bound`] holding every
//! symbol the record mentions, by id; a `component` link then points at module 0. The fixture
//! test (`tests/bx_check.rs`) reads its rows the same way.

use std::collections::BTreeMap;

use front_replay::{Replay, compare};
use indexmap::IndexMap;
use jsnum::Nullable;
use sema::binder::types::{
    Bound, ModuleId, Prop, Scope, ScopeId, Symbol, SymbolId, SymbolKind, SymbolRef,
};
use serde_json::Value;
use syntax::{Node, NodeId, SourceKind};

use crate::check::{CheckOptions, check_bx};

/// The decoded arguments of one `checkBx` call.
pub struct CheckArgs {
    pub ast: Node,
    pub file: String,
    /// One module: its symbol table holds every symbol of the record; `symbols` is the flat map.
    pub modules: Vec<Bound>,
    pub options: CheckOptions,
    pub stack: Vec<String>,
}

fn node_id(v: Option<&Value>) -> Option<NodeId> {
    match v {
        None | Some(Value::Null) => None,
        Some(v) => Some(NodeId(
            v.get("$node")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0),
        )),
    }
}

fn link(v: Option<&Value>) -> Nullable<SymbolRef> {
    match v {
        None => Nullable::Absent,
        Some(Value::Null) => Nullable::Null,
        Some(v) => Nullable::Value(SymbolRef {
            module: ModuleId(0),
            symbol: SymbolId(sym_id(v).unwrap_or(0)),
        }),
    }
}

fn sym_id(v: &Value) -> Option<u32> {
    v.get("$sym")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

/// Every symbol written out in full anywhere under `v`, by id (the first write wins).
fn collect<'a>(v: &'a Value, out: &mut BTreeMap<u32, &'a Value>) {
    match v {
        Value::Array(items) => items.iter().for_each(|item| collect(item, out)),
        Value::Object(map) => {
            if let Some(id) = sym_id(v)
                && map.contains_key("name")
            {
                out.entry(id).or_insert(v);
            }
            map.values().for_each(|item| collect(item, out));
        }
        _ => {}
    }
}

fn decode_prop(p: &Value) -> Prop {
    Prop {
        name: p
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        type_annotation: node_id(p.get("typeAnnotation")),
        optional: p.get("optional").and_then(Value::as_bool).unwrap_or(false),
        default_value: node_id(p.get("defaultValue")),
    }
}

fn decode_symbol(v: &Value) -> Symbol {
    let flag = |key: &str| v.get(key).and_then(Value::as_bool);
    Symbol {
        name: v
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        kind: v
            .get("kind")
            .and_then(|k| serde_json::from_value(k.clone()).ok())
            .unwrap_or(SymbolKind::Variable),
        node: NodeId(0),
        scope: ScopeId(0),
        props: v
            .get("props")
            .and_then(Value::as_array)
            .map(|list| list.iter().map(decode_prop).collect()),
        allows_children: flag("allowsChildren"),
        exported: flag("exported"),
        component: link(v.get("component")),
        target: link(v.get("target")),
        file: None,
        declaration: None,
        source: match v.get("source") {
            None => Nullable::Absent,
            Some(Value::String(s)) => Nullable::Value(s.clone()),
            Some(_) => Nullable::Null,
        },
        imported: None,
        members: None,
        state: None,
        body: None,
        resolved: flag("resolved"),
    }
}

/// Reads a record's (or a fixture row's) `args`.
///
/// # Errors
/// A text naming the argument that does not have the recorded shape.
pub fn decode_args(args: &[Value]) -> Result<CheckArgs, String> {
    let ast = args.first().ok_or("missing ast")?;
    let mut ast: Node = serde_json::from_value(ast.clone()).map_err(|e| format!("ast: {e}"))?;
    syntax::number_nodes(&mut ast);
    let file = args
        .get(1)
        .and_then(Value::as_str)
        .ok_or("missing file")?
        .to_string();
    let symbols = args.get(2).ok_or("missing symbols")?;
    let mut found = BTreeMap::new();
    collect(symbols, &mut found);
    let count = found.keys().next_back().map_or(0, |max| max + 1);
    let symbol_table: Vec<Symbol> = (0..count)
        .map(|id| {
            found
                .get(&id)
                .map_or_else(|| decode_symbol(&Value::Null), |v| decode_symbol(v))
        })
        .collect();
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
    let bound = Bound {
        scopes: vec![Scope {
            parent: None,
            symbols: IndexMap::new(),
        }],
        symbol_table,
        module_scope: ScopeId(0),
        symbols: flat,
        imports: Vec::new(),
        scope_of: IndexMap::new(),
        file: file.clone(),
    };
    let options = args.get(3);
    let defaults = CheckOptions::default();
    let options = CheckOptions {
        source_kind: options
            .and_then(|o| o.get("sourceKind"))
            .and_then(Value::as_str)
            .and_then(SourceKind::from_extension)
            .unwrap_or(defaults.source_kind),
        strict: options
            .and_then(|o| o.get("strict"))
            .and_then(Value::as_bool)
            .unwrap_or(defaults.strict),
    };
    let stack = args
        .get(4)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(CheckArgs {
        ast,
        file,
        modules: vec![bound],
        options,
        stack,
    })
}

/// The diagnostics `check_bx` gives for decoded arguments, as JSON.
#[must_use]
pub fn run(args: &CheckArgs) -> Value {
    let diagnostics = check_bx(
        &args.ast,
        &args.file,
        &args.modules[0],
        &args.modules,
        &args.options,
        &args.stack,
    );
    serde_json::to_value(diagnostics).unwrap_or(Value::Null)
}

/// Runs the port on the record's arguments and compares with its `result`.
#[must_use]
pub fn replay(record: &Value) -> Replay {
    let (Some(args), Some(expected)) = (
        record.get("args").and_then(Value::as_array),
        record.get("result"),
    ) else {
        return Replay::Skip;
    };
    match decode_args(args) {
        Ok(decoded) => compare(expected, &run(&decoded)),
        Err(message) => Replay::Mismatch("/args".into(), Value::Null, Value::String(message)),
    }
}
