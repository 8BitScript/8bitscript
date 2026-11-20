//! The canonical JSON form of the binder's cyclic values: the Rust side of
//! `scripts/oracle/front-tap/graph.mjs` (`encodeGraph`).
//!
//! * AST node: `{"$node": n}`, n the pre-order index (`syntax::number_nodes`). The tree itself is
//!   written out once as plain JSON by [`ast`].
//! * Scope: first encounter `{"$scope": n, "parent": ..., "symbols": [[name, ref], ...]}`, then
//!   `{"$scope": n}`. Symbol: first encounter `{"$sym": n, ...fields}`, then `{"$sym": n}`. Ids
//!   count in the order of first encounter, a scope's parent before its symbols, a symbol's
//!   `scope` before `members`, `component` and `target`: the order JS builds those fields in.
//! * `Symbol.members` is a scope id here, JS keeps the Map itself, so it is written as that
//!   scope's `symbols` map: `[[name, ref], ...]`.
//! * A symbol another module owns (`SymbolRef`) is written in full where it is first met,
//!   from the module it names.
//! * Numbers print the way JS does: `8`, never `8.0` ([`number`]).

use std::collections::HashMap;

use jsnum::Nullable;
use serde_json::{Map, Value, json};
use syntax::{Node, NodeId};

use crate::binder::types::{Bound, ScopeId, Symbol, SymbolId, SymbolRef};

/// A JS number as JSON: whole values without a fraction (`8`), `-0` as `0`, NaN and the
/// infinities as `null` (what `JSON.stringify` writes).
#[must_use]
pub fn number(v: f64) -> Value {
    if !v.is_finite() {
        return Value::Null;
    }
    // `v` is whole and below 2^53 in magnitude, so the cast is exact.
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        return Value::from(v as i64);
    }
    serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number)
}

/// A reference to an AST node.
#[must_use]
pub fn node_ref(id: NodeId) -> Value {
    json!({ "$node": id.0 })
}

/// A tree written out as plain JSON (the dump shape of `syntax::Node`).
#[must_use]
pub fn ast(root: &Node) -> Value {
    serde_json::to_value(root).unwrap_or(Value::Null)
}

fn optional_node(id: Option<NodeId>) -> Value {
    id.map_or(Value::Null, node_ref)
}

/// Encodes values of the modules in `modules` (load order), keeping one id space.
pub struct Encoder<'a> {
    modules: &'a [Bound],
    scopes: HashMap<(usize, ScopeId), usize>,
    symbols: HashMap<(usize, SymbolId), usize>,
}

impl<'a> Encoder<'a> {
    #[must_use]
    pub fn new(modules: &'a [Bound]) -> Self {
        Self {
            modules,
            scopes: HashMap::new(),
            symbols: HashMap::new(),
        }
    }

    /// The `bind()` result of module `module`, in JS key order. JS `scopes` is the module scope
    /// only. The Rust `Bound` stores no diagnostics, so the caller passes them.
    pub fn bound(&mut self, module: usize, diagnostics: Value) -> Value {
        let Some(bound) = self.modules.get(module) else {
            return Value::Null;
        };
        let scopes = vec![self.scope(module, bound.module_scope)];
        let symbols: Vec<Value> = bound
            .symbols
            .iter()
            .map(|(name, id)| json!([name, self.symbol(module, *id)]))
            .collect();
        let imports: Vec<Value> = bound
            .imports
            .iter()
            .map(|id| self.symbol(module, *id))
            .collect();
        let scope_of: Vec<Value> = bound
            .scope_of
            .iter()
            .map(|(node, scope)| json!([node_ref(*node), self.scope(module, *scope)]))
            .collect();
        json!({
            "scopes": scopes,
            "symbols": symbols,
            "imports": imports,
            "diagnostics": diagnostics,
            "scopeOf": scope_of,
            "file": bound.file,
        })
    }

    /// A scope of module `module`.
    pub fn scope(&mut self, module: usize, id: ScopeId) -> Value {
        if let Some(n) = self.scopes.get(&(module, id)) {
            return json!({ "$scope": n });
        }
        let n = self.scopes.len();
        self.scopes.insert((module, id), n);
        let Some(scope) = self
            .modules
            .get(module)
            .and_then(|b| b.scopes.get(id.0 as usize))
        else {
            return json!({ "$scope": n });
        };
        let parent = scope.parent.map_or(Value::Null, |p| self.scope(module, p));
        let symbols = self.symbol_map(module, id);
        json!({ "$scope": n, "parent": parent, "symbols": symbols })
    }

    /// The `symbols` map of a scope: `[[name, ref], ...]`.
    fn symbol_map(&mut self, module: usize, id: ScopeId) -> Value {
        let Some(scope) = self
            .modules
            .get(module)
            .and_then(|b| b.scopes.get(id.0 as usize))
        else {
            return Value::Null;
        };
        Value::Array(
            scope
                .symbols
                .iter()
                .map(|(name, sym)| json!([name, self.symbol(module, *sym)]))
                .collect(),
        )
    }

    fn link(&mut self, link: SymbolRef) -> Value {
        self.symbol(link.module.0 as usize, link.symbol)
    }

    fn nullable_link(&mut self, link: &Nullable<SymbolRef>) -> Option<Value> {
        match link {
            Nullable::Absent => None,
            Nullable::Null => Some(Value::Null),
            Nullable::Value(l) => Some(self.link(*l)),
        }
    }

    /// A symbol of module `module`.
    pub fn symbol(&mut self, module: usize, id: SymbolId) -> Value {
        if let Some(n) = self.symbols.get(&(module, id)) {
            return json!({ "$sym": n });
        }
        let n = self.symbols.len();
        self.symbols.insert((module, id), n);
        let Some(sym) = self
            .modules
            .get(module)
            .and_then(|b| b.symbol_table.get(id.0 as usize))
        else {
            return json!({ "$sym": n });
        };
        self.symbol_fields(module, n, sym)
    }

    fn symbol_fields(&mut self, module: usize, n: usize, sym: &Symbol) -> Value {
        let mut out = Map::new();
        out.insert("$sym".into(), json!(n));
        out.insert("name".into(), json!(sym.name));
        out.insert(
            "kind".into(),
            serde_json::to_value(sym.kind).unwrap_or(Value::Null),
        );
        out.insert("node".into(), node_ref(sym.node));
        out.insert("scope".into(), self.scope(module, sym.scope));
        if let Some(props) = &sym.props {
            let list: Vec<Value> = props
                .iter()
                .map(|p| {
                    json!({
                        "name": p.name,
                        "typeAnnotation": optional_node(p.type_annotation),
                        "optional": p.optional,
                        "defaultValue": optional_node(p.default_value),
                    })
                })
                .collect();
            out.insert("props".into(), Value::Array(list));
        }
        if let Some(v) = sym.allows_children {
            out.insert("allowsChildren".into(), json!(v));
        }
        if let Some(v) = sym.exported {
            out.insert("exported".into(), json!(v));
        }
        if let Some(members) = sym.members {
            let map = self.symbol_map(module, members);
            out.insert("members".into(), map);
        }
        if let Some(v) = self.nullable_link(&sym.component) {
            out.insert("component".into(), v);
        }
        if let Some(v) = self.nullable_link(&sym.target) {
            out.insert("target".into(), v);
        }
        if let Some(v) = &sym.file {
            out.insert("file".into(), json!(v));
        }
        if let Some(id) = sym.declaration {
            out.insert("declaration".into(), node_ref(id));
        }
        match &sym.source {
            Nullable::Absent => {}
            Nullable::Null => {
                out.insert("source".into(), Value::Null);
            }
            Nullable::Value(v) => {
                out.insert("source".into(), json!(v));
            }
        }
        if let Some(v) = &sym.imported {
            out.insert("imported".into(), json!(v));
        }
        if let Some(v) = &sym.state {
            out.insert("state".into(), json!(v));
        }
        if let Some(id) = sym.body {
            out.insert("body".into(), node_ref(id));
        }
        if let Some(v) = sym.resolved {
            out.insert("resolved".into(), json!(v));
        }
        Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::binder::types::{ModuleId, Scope, SymbolKind};
    use indexmap::IndexMap;

    fn symbol(name: &str, kind: SymbolKind, node: u32) -> Symbol {
        Symbol {
            name: name.into(),
            kind,
            node: NodeId(node),
            scope: ScopeId(0),
            props: None,
            allows_children: None,
            exported: None,
            component: Nullable::Absent,
            target: Nullable::Absent,
            file: None,
            declaration: None,
            source: Nullable::Absent,
            imported: None,
            members: None,
            state: None,
            body: None,
            resolved: None,
        }
    }

    /// The same two-symbol cycle as `a two-symbol cycle encodes as defined` in
    /// `scripts/oracle/front-tap/tap.test.mjs`, with the same expected JSON.
    #[test]
    fn a_two_symbol_cycle_encodes_as_the_js_test_defines() {
        let link = |symbol: u32| {
            Nullable::Value(SymbolRef {
                module: ModuleId(0),
                symbol: SymbolId(symbol),
            })
        };
        let mut a = symbol("a", SymbolKind::Variable, 2);
        a.declaration = Some(NodeId(1));
        a.target = link(1);
        let mut b = symbol("b", SymbolKind::Import, 3);
        b.target = link(0);
        b.component = Nullable::Null;
        let mut symbols = IndexMap::new();
        symbols.insert("a".to_string(), SymbolId(0));
        symbols.insert("b".to_string(), SymbolId(1));
        let mut scope_of = IndexMap::new();
        scope_of.insert(NodeId(1), ScopeId(0));
        let bound = Bound {
            scopes: vec![Scope {
                parent: None,
                symbols: symbols.clone(),
            }],
            symbol_table: vec![a, b],
            module_scope: ScopeId(0),
            symbols,
            imports: vec![SymbolId(1)],
            scope_of,
            file: "x.8bs".into(),
        };
        let modules = [bound];
        let got = Encoder::new(&modules).bound(0, json!([]));
        let sym_b = json!({"$sym": 1, "name": "b", "kind": "Import", "node": {"$node": 3},
            "scope": {"$scope": 0}, "target": {"$sym": 0}, "component": null});
        let sym_a = json!({"$sym": 0, "name": "a", "kind": "Variable", "node": {"$node": 2},
            "scope": {"$scope": 0}, "declaration": {"$node": 1}, "target": sym_b});
        let expected = json!({
            "scopes": [{"$scope": 0, "parent": null, "symbols": [["a", sym_a], ["b", {"$sym": 1}]]}],
            "symbols": [["a", {"$sym": 0}], ["b", {"$sym": 1}]],
            "imports": [{"$sym": 1}],
            "diagnostics": [],
            "scopeOf": [[{"$node": 1}, {"$scope": 0}]],
            "file": "x.8bs",
        });
        assert_eq!(got, expected);
    }

    #[test]
    fn numbers_print_as_js_does() {
        assert_eq!(number(8.0).to_string(), "8");
        assert_eq!(number(-0.0).to_string(), "0");
        assert_eq!(number(-3.0).to_string(), "-3");
        assert_eq!(number(2.5).to_string(), "2.5");
        assert_eq!(number(1e21), json!(1e21));
        assert_eq!(number(f64::NAN), Value::Null);
        assert_eq!(number(f64::INFINITY), Value::Null);
    }
}
