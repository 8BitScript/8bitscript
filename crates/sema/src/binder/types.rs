//! Port of packages/compiler/src/binder/index.mjs:1-60 (SymbolKind, Symbol, Scope) and the
//! `bind()` result shape (:84-90), on the arenas of rulebook R1.3-R1.5.

use indexmap::IndexMap;
use jsnum::Nullable;
use serde::{Deserialize, Serialize};
use syntax::NodeId;

/// Index of a scope in `Bound::scopes` (R1.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ScopeId(pub u32);

/// Index of a symbol in `Bound::symbol_table` (per module).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SymbolId(pub u32);

/// Index of a module in load order (R1.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ModuleId(pub u32);

/// A cross-module symbol link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SymbolRef {
    pub module: ModuleId,
    pub symbol: SymbolId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SymbolKind {
    Variable,
    Constant,
    Function,
    Namespace,
    Parameter,
    Import,
    Component,
    State,
}

mod node_id {
    use super::NodeId;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(id: &NodeId, s: S) -> Result<S::Ok, S::Error> {
        id.0.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<NodeId, D::Error> {
        Ok(NodeId(u32::deserialize(d)?))
    }
}

mod node_id_opt {
    use super::NodeId;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    #[allow(clippy::ref_option)]
    pub fn serialize<S: Serializer>(id: &Option<NodeId>, s: S) -> Result<S::Ok, S::Error> {
        id.map(|n| n.0).serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<NodeId>, D::Error> {
        Ok(Option::<u32>::deserialize(d)?.map(NodeId))
    }
}

mod scope_of {
    use super::{NodeId, ScopeId};
    use indexmap::IndexMap;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(
        m: &IndexMap<NodeId, ScopeId>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        m.iter()
            .map(|(n, sc)| (n.0, *sc))
            .collect::<Vec<_>>()
            .serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<IndexMap<NodeId, ScopeId>, D::Error> {
        Ok(Vec::<(u32, ScopeId)>::deserialize(d)?
            .into_iter()
            .map(|(n, s)| (NodeId(n), s))
            .collect())
    }
}

/// A component parameter record built by `bind()` (`binder/index.mjs:150-155`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prop {
    /// `p.name?.name`: absent when the parameter has no name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "node_id_opt")]
    pub type_annotation: Option<NodeId>,
    pub optional: bool,
    /// `p.defaultValue ?? null`: always written, `null` when there is none (R3.3).
    #[serde(default, with = "node_id_opt")]
    pub default_value: Option<NodeId>,
}

/// A bound name. Optional fields follow R3.2; the two cross-module links are R3.4.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    #[serde(with = "node_id")]
    pub node: NodeId,
    pub scope: ScopeId,
    /// Component only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub props: Option<Vec<Prop>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allows_children: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported: Option<bool>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub component: Nullable<SymbolRef>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub target: Nullable<SymbolRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "node_id_opt")]
    pub declaration: Option<NodeId>,
    /// Import only: `stmt.source?.value ?? null`, so an Import always carries it (R3.4).
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub source: Nullable<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported: Option<String>,
    /// Namespace only: the namespace's own scope (`sym.members = nsScope.symbols`, :143).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<ScopeId>,
    /// Component only: names of the top-level `state` declarations in the body (:164-166).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Vec<String>>,
    /// Component only: the body block (:167).
    #[serde(default, skip_serializing_if = "Option::is_none", with = "node_id_opt")]
    pub body: Option<NodeId>,
    /// Import only: set to `true` by `bindImports` (:245).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved: Option<bool>,
}

/// `{ parent, symbols: Map }`. Symbols are by id into `Bound::symbol_table`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scope {
    pub parent: Option<ScopeId>,
    pub symbols: IndexMap<String, SymbolId>,
}

/// The result of `bind()`. Diagnostics are returned through a `&mut Vec` (R5.1), not stored.
/// `symbols` is the flat map of declarations from every scope, last write wins (JS `symbols`);
/// `symbol_table` is the arena the ids index. JS `scopes` is `[moduleScope]` only (:197), so the
/// tap encodes only `module_scope`; `scopes` here holds every scope, module scope first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bound {
    pub scopes: Vec<Scope>,
    pub symbol_table: Vec<Symbol>,
    pub module_scope: ScopeId,
    pub symbols: IndexMap<String, SymbolId>,
    pub imports: Vec<SymbolId>,
    #[serde(with = "scope_of")]
    pub scope_of: IndexMap<NodeId, ScopeId>,
    pub file: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(name: &str, kind: SymbolKind, node: u32, scope: u32) -> Symbol {
        Symbol {
            name: name.into(),
            kind,
            node: NodeId(node),
            scope: ScopeId(scope),
            props: None,
            allows_children: None,
            exported: None,
            component: Nullable::Absent,
            target: Nullable::Absent,
            file: Some("a.8bs".into()),
            declaration: None,
            source: Nullable::Absent,
            imported: None,
            members: None,
            state: None,
            body: None,
            resolved: None,
        }
    }

    #[test]
    fn bound_round_trips() {
        let mut imp = sym("Menu", SymbolKind::Import, 3, 0);
        imp.source = Nullable::Value("./menu".into());
        imp.resolved = Some(true);
        imp.imported = Some("Menu".into());
        imp.component = Nullable::Value(SymbolRef {
            module: ModuleId(1),
            symbol: SymbolId(4),
        });
        imp.target = Nullable::Null;
        imp.declaration = Some(NodeId(2));
        let mut comp = sym("App", SymbolKind::Component, 5, 0);
        comp.props = Some(vec![
            Prop {
                name: Some("a".into()),
                type_annotation: Some(NodeId(6)),
                optional: false,
                default_value: None,
            },
            Prop {
                name: None,
                type_annotation: None,
                optional: true,
                default_value: Some(NodeId(7)),
            },
        ]);
        comp.state = Some(vec!["count".into()]);
        comp.body = Some(NodeId(8));
        let mut ns = sym("N", SymbolKind::Namespace, 10, 0);
        ns.members = Some(ScopeId(1));
        let mut nullsrc = sym("Q", SymbolKind::Import, 11, 0);
        nullsrc.source = Nullable::Null;
        comp.allows_children = Some(true);
        comp.exported = Some(false);
        let param = sym("x", SymbolKind::Parameter, 9, 1);
        let bound = Bound {
            scopes: vec![
                Scope {
                    parent: None,
                    symbols: IndexMap::from([
                        ("Menu".into(), SymbolId(0)),
                        ("App".into(), SymbolId(1)),
                    ]),
                },
                Scope {
                    parent: Some(ScopeId(0)),
                    symbols: IndexMap::from([("x".into(), SymbolId(2))]),
                },
            ],
            symbol_table: vec![imp, comp, param, ns, nullsrc],
            module_scope: ScopeId(0),
            symbols: IndexMap::from([("Menu".into(), SymbolId(0)), ("App".into(), SymbolId(1))]),
            imports: vec![SymbolId(0)],
            scope_of: IndexMap::from([(NodeId(5), ScopeId(1))]),
            file: "a.8bs".into(),
        };
        let json = serde_json::to_string(&bound).unwrap();
        let back: Bound = serde_json::from_str(&json).unwrap();
        assert_eq!(back, bound);
        assert_eq!(serde_json::to_string(&back).unwrap(), json);
        assert!(json.contains("\"allowsChildren\":true"));
        assert!(json.contains("\"target\":null"));
        assert!(json.contains("\"source\":null"));
        assert!(json.contains("\"defaultValue\":null"));
        assert!(json.contains("\"members\":1"));
        assert!(json.contains("\"state\":[\"count\"]"));
    }
}
