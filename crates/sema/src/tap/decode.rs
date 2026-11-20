//! The other direction of `graph.rs`: reads the canonical form of scopes, symbols and `bind()`
//! results back into `Bound` arenas, so a tapped call can be replayed.
//!
//! A scope or symbol is written in full where it is first met and as `{"$scope": n}` or
//! `{"$sym": n}` after that, so the full forms are collected first (wherever they sit) and the
//! bare ones looked up. A module is a tree of scopes: its root scope names it. The modules of
//! the `bind()` results given come first, in that order; a root scope seen only through a symbol
//! or a scope becomes a module of its own with nothing but those scopes and symbols.

use std::collections::HashMap;

use indexmap::IndexMap;
use jsnum::Nullable;
use serde_json::Value;
use syntax::NodeId;

use crate::binder::types::{
    Bound, ModuleId, Prop, Scope, ScopeId, Symbol, SymbolId, SymbolKind, SymbolRef,
};

/// The full forms found in a value, by id.
#[derive(Default)]
struct Graph<'a> {
    scopes: HashMap<u64, &'a Value>,
    symbols: HashMap<u64, &'a Value>,
}

fn collect<'a>(value: &'a Value, graph: &mut Graph<'a>) {
    match value {
        Value::Array(items) => items.iter().for_each(|v| collect(v, graph)),
        Value::Object(fields) => {
            if fields.len() > 1 {
                if let Some(n) = fields.get("$scope").and_then(Value::as_u64) {
                    graph.scopes.entry(n).or_insert(value);
                }
                if let Some(n) = fields.get("$sym").and_then(Value::as_u64) {
                    graph.symbols.entry(n).or_insert(value);
                }
            }
            fields.values().for_each(|v| collect(v, graph));
        }
        _ => {}
    }
}

fn node_id(value: &Value) -> Result<NodeId, String> {
    value
        .get("$node")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .map(NodeId)
        .ok_or_else(|| format!("not a node reference: {value}"))
}

fn optional_node(value: Option<&Value>) -> Result<Option<NodeId>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v) => node_id(v).map(Some),
    }
}

/// The scope id of the first scope of a `bind()` result: the module scope, which names the module.
#[must_use]
pub fn bound_root(bound: &Value) -> Option<u64> {
    bound.get("scopes")?.get(0)?.get("$scope")?.as_u64()
}

/// The modules read from one record.
pub struct World {
    pub modules: Vec<Bound>,
    scope_ids: HashMap<u64, (usize, ScopeId)>,
    symbol_ids: HashMap<u64, (usize, SymbolId)>,
    roots: Vec<u64>,
}

impl World {
    /// Reads every scope and symbol found in `values`. `bounds` are the `bind()` results among
    /// them, one per module of interest; modules are numbered in their order.
    pub fn new(values: &[&Value], bounds: &[&Value]) -> Result<World, String> {
        let mut graph = Graph::default();
        values.iter().for_each(|v| collect(v, &mut graph));
        let root_of = |mut n: u64| -> Result<u64, String> {
            for _ in 0..=graph.scopes.len() {
                let def = graph
                    .scopes
                    .get(&n)
                    .ok_or(format!("scope {n} is not defined"))?;
                match def.get("parent") {
                    None | Some(Value::Null) => return Ok(n),
                    Some(parent) => {
                        n = parent
                            .get("$scope")
                            .and_then(Value::as_u64)
                            .ok_or("a scope parent is not a scope")?;
                    }
                }
            }
            Err("a scope is its own ancestor".to_string())
        };

        let mut scope_keys: Vec<u64> = graph.scopes.keys().copied().collect();
        scope_keys.sort();
        let mut roots: Vec<u64> = Vec::new();
        for root in bounds.iter().filter_map(|b| bound_root(b)) {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
        let mut owner: HashMap<u64, u64> = HashMap::new();
        for n in &scope_keys {
            let root = root_of(*n)?;
            owner.insert(*n, root);
            if !roots.contains(&root) {
                roots.push(root);
            }
        }

        // Ids first, so that a link can name a symbol of a module built later.
        let mut scope_ids = HashMap::new();
        let mut scope_lists: Vec<Vec<u64>> = Vec::new();
        for (m, root) in roots.iter().enumerate() {
            let mut list = vec![*root];
            list.extend(
                scope_keys
                    .iter()
                    .filter(|n| owner[n] == *root && *n != root),
            );
            for (i, n) in list.iter().enumerate() {
                scope_ids.insert(*n, (m, ScopeId(i as u32)));
            }
            scope_lists.push(list);
        }
        let mut symbol_keys: Vec<u64> = graph.symbols.keys().copied().collect();
        symbol_keys.sort();
        let mut symbol_ids = HashMap::new();
        let mut symbol_lists: Vec<Vec<u64>> = vec![Vec::new(); roots.len()];
        for n in symbol_keys {
            let scope = graph.symbols[&n]
                .get("scope")
                .and_then(|s| s.get("$scope"))
                .and_then(Value::as_u64)
                .ok_or("a symbol has no scope")?;
            let (m, _) = *scope_ids
                .get(&scope)
                .ok_or(format!("scope {scope} is not defined"))?;
            symbol_ids.insert(n, (m, SymbolId(symbol_lists[m].len() as u32)));
            symbol_lists[m].push(n);
        }

        let mut world = World {
            modules: Vec::new(),
            scope_ids,
            symbol_ids,
            roots,
        };
        for (m, root) in world.roots.clone().into_iter().enumerate() {
            let bound = bounds.iter().find(|b| bound_root(b) == Some(root)).copied();
            let module = world.module(&graph, bound, &scope_lists[m], &symbol_lists[m])?;
            world.modules.push(module);
        }
        Ok(world)
    }

    fn module(
        &self,
        graph: &Graph,
        bound: Option<&Value>,
        scope_list: &[u64],
        symbol_list: &[u64],
    ) -> Result<Bound, String> {
        let mut scopes = Vec::new();
        for n in scope_list {
            let def = graph.scopes[n];
            let parent = match def.get("parent") {
                None | Some(Value::Null) => None,
                Some(p) => Some(self.scope_of(p)?.1),
            };
            let symbols = self.symbol_map(def.get("symbols"))?;
            scopes.push(Scope { parent, symbols });
        }
        let mut symbol_table = Vec::new();
        let mut members = Vec::new();
        for n in symbol_list {
            let (sym, map) = self.symbol(graph.symbols[n])?;
            symbol_table.push(sym);
            members.push(map);
        }
        let mut module = Bound {
            scopes,
            symbol_table,
            module_scope: ScopeId(0),
            symbols: IndexMap::new(),
            imports: Vec::new(),
            scope_of: IndexMap::new(),
            file: String::new(),
        };
        if let Some(bound) = bound {
            module.symbols = self.symbol_map(bound.get("symbols"))?;
            for item in bound
                .get("imports")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                module.imports.push(self.symbol_of(item)?.1);
            }
            for pair in bound
                .get("scopeOf")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let (Some(key), Some(scope)) = (pair.get(0), pair.get(1)) else {
                    return Err("scopeOf entry is not a pair".to_string());
                };
                module
                    .scope_of
                    .insert(node_id(key)?, self.scope_of(scope)?.1);
            }
            module.file = bound
                .get("file")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
        // `members` is written as the scope's map. The scope is the one the declaration owns;
        // when the record has no `scopeOf`, a scope holding that map stands in for it.
        for (i, map) in members.into_iter().enumerate() {
            let Some(map) = map else {
                continue;
            };
            let declared = module.symbol_table[i]
                .declaration
                .and_then(|d| module.scope_of.get(&d).copied());
            let scope = declared.unwrap_or_else(|| {
                module.scopes.push(Scope {
                    parent: Some(module.symbol_table[i].scope),
                    symbols: map,
                });
                ScopeId(u32::try_from(module.scopes.len() - 1).unwrap_or(u32::MAX))
            });
            module.symbol_table[i].members = Some(scope);
        }
        Ok(module)
    }

    /// `[[name, ref], ...]` as a map of ids.
    fn symbol_map(&self, value: Option<&Value>) -> Result<IndexMap<String, SymbolId>, String> {
        let mut map = IndexMap::new();
        for pair in value.and_then(Value::as_array).into_iter().flatten() {
            let name = pair
                .get(0)
                .and_then(Value::as_str)
                .ok_or("a symbol map key is not a name")?;
            let sym = pair.get(1).ok_or("a symbol map entry has no symbol")?;
            map.insert(name.to_string(), self.symbol_of(sym)?.1);
        }
        Ok(map)
    }

    /// The module and id a `{"$scope": n, ...}` reference names.
    pub fn scope_of(&self, value: &Value) -> Result<(usize, ScopeId), String> {
        let n = value
            .get("$scope")
            .and_then(Value::as_u64)
            .ok_or(format!("not a scope: {value}"))?;
        self.scope_ids
            .get(&n)
            .copied()
            .ok_or(format!("scope {n} is not defined"))
    }

    /// The module and id a `{"$sym": n, ...}` reference names.
    pub fn symbol_of(&self, value: &Value) -> Result<(usize, SymbolId), String> {
        let n = value
            .get("$sym")
            .and_then(Value::as_u64)
            .ok_or(format!("not a symbol: {value}"))?;
        self.symbol_ids
            .get(&n)
            .copied()
            .ok_or(format!("symbol {n} is not defined"))
    }

    /// The same as a cross-module link.
    pub fn link_of(&self, value: &Value) -> Result<SymbolRef, String> {
        let (module, symbol) = self.symbol_of(value)?;
        Ok(SymbolRef {
            module: ModuleId(module as u32),
            symbol,
        })
    }

    fn link(&self, value: Option<&Value>) -> Result<Nullable<SymbolRef>, String> {
        match value {
            None => Ok(Nullable::Absent),
            Some(Value::Null) => Ok(Nullable::Null),
            Some(v) => self.link_of(v).map(Nullable::Value),
        }
    }

    #[allow(clippy::type_complexity)]
    fn symbol(&self, def: &Value) -> Result<(Symbol, Option<IndexMap<String, SymbolId>>), String> {
        let text = |key: &str| def.get(key).and_then(Value::as_str).map(str::to_string);
        let flag = |key: &str| def.get(key).and_then(Value::as_bool);
        let kind: SymbolKind =
            serde_json::from_value(def.get("kind").cloned().unwrap_or(Value::Null))
                .map_err(|e| format!("symbol kind: {e}"))?;
        let props = match def.get("props").and_then(Value::as_array) {
            None => None,
            Some(list) => Some(
                list.iter()
                    .map(|p| {
                        Ok(Prop {
                            name: p
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            type_annotation: optional_node(p.get("typeAnnotation"))?,
                            optional: p.get("optional").and_then(Value::as_bool).unwrap_or(false),
                            default_value: optional_node(p.get("defaultValue"))?,
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?,
            ),
        };
        let source = match def.get("source") {
            None => Nullable::Absent,
            Some(Value::String(s)) => Nullable::Value(s.clone()),
            Some(_) => Nullable::Null,
        };
        let members = match def.get("members") {
            None => None,
            Some(map) => Some(self.symbol_map(Some(map))?),
        };
        let symbol = Symbol {
            name: text("name").ok_or("a symbol has no name")?,
            kind,
            node: node_id(def.get("node").ok_or("a symbol has no node")?)?,
            scope: self
                .scope_of(def.get("scope").ok_or("a symbol has no scope")?)?
                .1,
            props,
            allows_children: flag("allowsChildren"),
            exported: flag("exported"),
            component: self.link(def.get("component"))?,
            target: self.link(def.get("target"))?,
            file: text("file"),
            declaration: optional_node(def.get("declaration"))?,
            source,
            imported: text("imported"),
            // Filled in once the module's `scopeOf` is known.
            members: None,
            state: def.get("state").and_then(Value::as_array).map(|l| {
                l.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            }),
            body: optional_node(def.get("body"))?,
            resolved: flag("resolved"),
        };
        Ok((symbol, members))
    }
}
