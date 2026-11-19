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

mod node_ids {
    use super::NodeId;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    #[allow(clippy::ref_option)]
    pub fn serialize<S: Serializer>(ids: &Option<Vec<NodeId>>, s: S) -> Result<S::Ok, S::Error> {
        ids.as_ref().map(|v| v.iter().map(|n| n.0).collect::<Vec<_>>()).serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<NodeId>>, D::Error> {
        Ok(Option::<Vec<u32>>::deserialize(d)?.map(|v| v.into_iter().map(NodeId).collect()))
    }
}

mod scope_of {
    use super::{NodeId, ScopeId};
    use indexmap::IndexMap;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(m: &IndexMap<NodeId, ScopeId>, s: S) -> Result<S::Ok, S::Error> {
        m.iter().map(|(n, sc)| (n.0, *sc)).collect::<Vec<_>>().serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<IndexMap<NodeId, ScopeId>, D::Error> {
        Ok(Vec::<(u32, ScopeId)>::deserialize(d)?.into_iter().map(|(n, s)| (NodeId(n), s)).collect())
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none", with = "node_ids")]
    pub props: Option<Vec<NodeId>>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported: Option<String>,
}

/// `{ parent, symbols: Map }`. Symbols are by id into `Bound::symbol_table`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scope {
    pub parent: Option<ScopeId>,
    pub symbols: IndexMap<String, SymbolId>,
}

/// The result of `bind()`. Diagnostics are returned through a `&mut Vec` (R5.1), not stored.
/// `symbols` is the module scope's name table; `symbol_table` is the arena the ids index.
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
            source: None,
            imported: None,
        }
    }

    #[test]
    fn bound_round_trips() {
        let mut imp = sym("Menu", SymbolKind::Import, 3, 0);
        imp.source = Some("./menu".into());
        imp.imported = Some("Menu".into());
        imp.component = Nullable::Value(SymbolRef { module: ModuleId(1), symbol: SymbolId(4) });
        imp.target = Nullable::Null;
        imp.declaration = Some(NodeId(2));
        let mut comp = sym("App", SymbolKind::Component, 5, 0);
        comp.props = Some(vec![NodeId(6), NodeId(7)]);
        comp.allows_children = Some(true);
        comp.exported = Some(false);
        let param = sym("x", SymbolKind::Parameter, 9, 1);
        let bound = Bound {
            scopes: vec![
                Scope { parent: None, symbols: IndexMap::from([("Menu".into(), SymbolId(0)), ("App".into(), SymbolId(1))]) },
                Scope { parent: Some(ScopeId(0)), symbols: IndexMap::from([("x".into(), SymbolId(2))]) },
            ],
            symbol_table: vec![imp, comp, param],
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
    }
}
