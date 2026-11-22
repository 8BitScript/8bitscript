//! Port of packages/compiler/src/binder/index.mjs:61-270 (the data types, lines 1-60, are in `types`).
//!
//! `bind` walks a `Program` and records every declared name in a scope. Scopes and symbols live
//! in the arenas of `Bound` (R1.4), a symbol points at its AST node by `NodeId` (R1.5), and an
//! import points at a symbol of another module by `SymbolRef` (R1.3).

pub mod types;

use diagnostics::Diagnostic;
use indexmap::IndexMap;
use jsnum::Nullable;
use syntax::{Node, NodeId, NodeKind};

use types::{Bound, ModuleId, Prop, Scope, ScopeId, Symbol, SymbolId, SymbolKind, SymbolRef};

/// The name of an `Identifier` child, when it has one (JS `node?.name`, truthy), and the id of
/// that node.
fn ident(node: Option<&Node>) -> Option<(&str, NodeId)> {
    match node {
        Some(Node {
            id,
            kind: NodeKind::Identifier { name, .. },
            ..
        }) if !name.is_empty() => Some((name, *id)),
        _ => None,
    }
}

/// `body` of a block statement (JS `block?.body`); empty for anything else.
fn block_items(node: Option<&Node>) -> Vec<Option<&Node>> {
    match node.map(|n| &n.kind) {
        Some(NodeKind::BlockStatement { body }) => body.iter().map(Some).collect(),
        _ => Vec::new(),
    }
}

/// A symbol as the JS object literal in `bind` builds it: the fields every symbol has, the
/// rest left unset.
fn new_symbol(name: &str, kind: SymbolKind, node: NodeId, scope: ScopeId) -> Symbol {
    Symbol {
        name: name.to_string(),
        kind,
        node,
        scope,
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

/// The state `bind` closes over in JS: the arenas, the flat symbol map, the import list and
/// `scopeOf`.
struct Binder {
    scopes: Vec<Scope>,
    symbol_table: Vec<Symbol>,
    symbols: IndexMap<String, SymbolId>,
    imports: Vec<SymbolId>,
    scope_of: IndexMap<NodeId, ScopeId>,
}

impl Binder {
    fn create_scope(&mut self, parent: Option<ScopeId>) -> ScopeId {
        self.scopes.push(Scope {
            parent,
            symbols: IndexMap::new(),
        });
        ScopeId(u32::try_from(self.scopes.len() - 1).unwrap_or(u32::MAX))
    }

    /// Adds `symbol` to the table and, unless the name is taken in `scope`, to the scope. The
    /// symbol exists either way (JS keeps the object, `symbols.set` may still store it).
    fn declare(&mut self, scope: ScopeId, name: &str, mut symbol: Symbol, file: &str) -> SymbolId {
        symbol.file = Some(file.to_string());
        self.symbol_table.push(symbol);
        let id = SymbolId(u32::try_from(self.symbol_table.len() - 1).unwrap_or(u32::MAX));
        let scope = &mut self.scopes[scope.0 as usize];
        if !scope.symbols.contains_key(name) {
            scope.symbols.insert(name.to_string(), id);
        }
        id
    }

    fn bind_parameters(&mut self, scope: ScopeId, params: &[Node], file: &str) {
        for param in params {
            let NodeKind::Parameter { name, .. } = &param.kind else {
                continue;
            };
            let Some((param_name, node)) = ident(Some(name)) else {
                continue;
            };
            let mut sym = new_symbol(param_name, SymbolKind::Parameter, node, scope);
            sym.declaration = Some(param.id);
            self.declare(scope, param_name, sym, file);
        }
    }

    fn bind_block(&mut self, scope: ScopeId, body: Vec<Option<&Node>>, file: &str) -> ScopeId {
        let block_scope = self.create_scope(Some(scope));
        for stmt in body {
            self.bind_statement(block_scope, stmt, file);
        }
        block_scope
    }

    fn block_of(
        &mut self,
        scope: ScopeId,
        node: Option<&Node>,
        body: Vec<Option<&Node>>,
        file: &str,
    ) -> ScopeId {
        let block_scope = self.bind_block(scope, body, file);
        if let Some(node) = node {
            self.scope_of.insert(node.id, block_scope);
        }
        block_scope
    }

    /// Declares a symbol and records it in the flat map (`symbols.set`).
    fn declare_named(&mut self, scope: ScopeId, name: &str, sym: Symbol, file: &str) -> SymbolId {
        let id = self.declare(scope, name, sym, file);
        self.symbols.insert(name.to_string(), id);
        id
    }

    fn bind_statement(&mut self, scope: ScopeId, stmt: Option<&Node>, file: &str) {
        let Some(stmt) = stmt else {
            return;
        };
        match &stmt.kind {
            NodeKind::ImportDeclaration {
                specifiers, source, ..
            } => {
                // A specifier is the imported Identifier; `x as y` is that node
                // with `name` the local name and `imported` the other module's.
                for spec in specifiers {
                    let NodeKind::Identifier { imported, .. } = &spec.kind else {
                        continue;
                    };
                    let Some((local, _)) = ident(Some(spec)) else {
                        continue;
                    };
                    let mut sym = new_symbol(local, SymbolKind::Import, spec.id, scope);
                    sym.source = match source.as_deref().map(|s| &s.kind) {
                        Some(NodeKind::StringLiteral { value, .. }) => {
                            Nullable::Value(value.clone())
                        }
                        _ => Nullable::Null,
                    };
                    sym.imported = Some(imported.clone().unwrap_or_else(|| local.to_string()));
                    sym.component = Nullable::Null;
                    sym.target = Nullable::Null;
                    let id = self.declare_named(scope, local, sym, file);
                    self.imports.push(id);
                }
            }
            NodeKind::VariableDeclaration {
                kind,
                name,
                exported,
                ..
            } => {
                let Some((name, node)) = ident(name.as_deref()) else {
                    return;
                };
                let kind = if kind == "const" {
                    SymbolKind::Constant
                } else {
                    SymbolKind::Variable
                };
                let mut sym = new_symbol(name, kind, node, scope);
                sym.exported = Some(*exported);
                sym.declaration = Some(stmt.id);
                self.declare_named(scope, name, sym, file);
            }
            NodeKind::FunctionDeclaration {
                name,
                params,
                body,
                exported,
                ..
            } => {
                let Some((fn_name, node)) = ident(name.as_deref()) else {
                    return;
                };
                let mut sym = new_symbol(fn_name, SymbolKind::Function, node, scope);
                sym.exported = Some(*exported);
                sym.declaration = Some(stmt.id);
                self.declare_named(scope, fn_name, sym, file);
                let fn_scope = self.create_scope(Some(scope));
                self.scope_of.insert(stmt.id, fn_scope);
                self.bind_parameters(fn_scope, params, file);
                let body = body.as_deref();
                self.block_of(fn_scope, body, block_items(body), file);
            }
            // A test declares nothing in its module (`__test_<k>` is made by lowering): only
            // its own scope, so the names inside it resolve like a function's.
            NodeKind::TestDecl { body, .. } => {
                let test_scope = self.create_scope(Some(scope));
                self.scope_of.insert(stmt.id, test_scope);
                let body = Some(&**body);
                self.block_of(test_scope, body, block_items(body), file);
            }
            NodeKind::NamespaceDeclaration {
                name,
                members,
                exported,
            } => {
                let Some((ns_name, node)) = ident(name.as_deref()) else {
                    return;
                };
                let mut sym = new_symbol(ns_name, SymbolKind::Namespace, node, scope);
                sym.exported = Some(*exported);
                sym.declaration = Some(stmt.id);
                let id = self.declare_named(scope, ns_name, sym, file);
                // Members (the parser's `members`, not a block): the namespace's own scope.
                let ns_scope = self.block_of(
                    scope,
                    Some(stmt),
                    members.iter().map(Option::as_ref).collect(),
                    file,
                );
                self.symbol_table[id.0 as usize].members = Some(ns_scope);
            }
            NodeKind::ComponentDeclaration {
                name,
                params,
                body,
                exported,
                allows_children,
            } => {
                let Some((comp_name, node)) = ident(name.as_deref()) else {
                    return;
                };
                let props = params
                    .iter()
                    .map(|p| match &p.kind {
                        NodeKind::Parameter {
                            name,
                            type_annotation,
                            default_value,
                            optional,
                        } => Prop {
                            name: ident(Some(name))
                                .map(|(n, _)| n)
                                .unwrap_or_default()
                                .to_string(),
                            type_annotation: type_annotation.as_deref().map(|n| n.id),
                            optional: optional.unwrap_or(false),
                            default_value: default_value.as_deref().map(|n| n.id),
                        },
                        _ => Prop {
                            name: String::new(),
                            type_annotation: None,
                            optional: false,
                            default_value: None,
                        },
                    })
                    .collect();
                let mut sym = new_symbol(comp_name, SymbolKind::Component, node, scope);
                sym.props = Some(props);
                sym.allows_children = Some(*allows_children);
                sym.exported = Some(*exported);
                // The fields a `state` declaration names, top level of the body.
                sym.state = Some(
                    block_items(body.as_deref())
                        .into_iter()
                        .filter_map(|s| match s.map(|n| &n.kind) {
                            Some(NodeKind::StateDeclaration { name, .. }) => {
                                ident(name.as_deref()).map(|(n, _)| n)
                            }
                            _ => None,
                        })
                        .map(str::to_string)
                        .collect(),
                );
                sym.body = body.as_deref().map(|b| b.id);
                sym.declaration = Some(stmt.id);
                self.declare_named(scope, comp_name, sym, file);
                let comp_scope = self.create_scope(Some(scope));
                self.scope_of.insert(stmt.id, comp_scope);
                self.bind_parameters(comp_scope, params, file);
                let body = body.as_deref();
                self.block_of(comp_scope, body, block_items(body), file);
            }
            NodeKind::StateDeclaration { name, .. } => {
                let Some((state_name, node)) = ident(name.as_deref()) else {
                    return;
                };
                let mut sym = new_symbol(state_name, SymbolKind::State, node, scope);
                sym.declaration = Some(stmt.id);
                self.declare(scope, state_name, sym, file);
            }
            NodeKind::BlockStatement { body } => {
                self.block_of(scope, Some(stmt), body.iter().map(Some).collect(), file);
            }
            NodeKind::IfStatement {
                consequent,
                alternate,
                ..
            } => {
                self.bind_statement(scope, consequent.as_deref(), file);
                self.bind_statement(scope, alternate.as_deref(), file);
            }
            NodeKind::WhileStatement { body, .. } => {
                self.bind_statement(scope, body.as_deref(), file);
            }
            NodeKind::ForStatement { init, body, .. } => {
                self.bind_statement(scope, init.as_deref(), file);
                self.bind_statement(scope, body.as_deref(), file);
            }
            _ => {}
        }
    }
}

/// Binds the names of `ast` (a `Program`; anything else binds nothing). `file` is `'<unknown>'`
/// in JS when omitted. `bind` never reports: the JS `diagnostics` stays `[]`, so `diagnostics`
/// is not written to.
///
/// `scope_of` takes a function, component or namespace declaration to the scope its parameters
/// and members live in, and a block statement to its own: enough to find the scope any offset
/// is in. `ast` must have its nodes numbered (`syntax::number_nodes`).
#[must_use]
pub fn bind(ast: &Node, file: &str, _diagnostics: &mut Vec<Diagnostic>) -> Bound {
    let mut binder = Binder {
        scopes: Vec::new(),
        symbol_table: Vec::new(),
        symbols: IndexMap::new(),
        imports: Vec::new(),
        scope_of: IndexMap::new(),
    };
    let module_scope = binder.create_scope(None);

    if let NodeKind::Program { body } = &ast.kind {
        for stmt in body {
            binder.bind_statement(module_scope, Some(stmt), file);
        }
    }

    Bound {
        scopes: binder.scopes,
        symbol_table: binder.symbol_table,
        module_scope,
        symbols: binder.symbols,
        imports: binder.imports,
        scope_of: binder.scope_of,
        file: file.to_string(),
    }
}

/// The Component a symbol stands for: itself, or, for an Import bound across modules, the one it
/// names. `None` for anything else, and for an Import whose module has not been bound.
#[must_use]
pub fn component_of(modules: &[Bound], sym: Option<SymbolRef>) -> Option<SymbolRef> {
    let sym = sym?;
    let symbol = modules
        .get(sym.module.0 as usize)?
        .symbol_table
        .get(sym.symbol.0 as usize)?;
    if symbol.kind == SymbolKind::Component {
        return Some(sym);
    }
    if symbol.kind == SymbolKind::Import {
        return symbol.component.as_option().copied();
    }
    None
}

/// Point every Import symbol of module `module` that names an exported symbol of another module
/// at that symbol: `target` for any kind, `component` when it is a Component. `lookup(source)` is
/// the other module (an index into `modules`, the `bind()` result in JS), or `None` when the
/// import did not resolve (that is reported elsewhere, by the resolver).
///
/// A non-exported name is not visible: the import stays an Import with no target, and
/// `<Name />` is then "not a component", which is what the definer's `export` decides.
pub fn bind_imports(
    modules: &mut [Bound],
    module: ModuleId,
    lookup: &mut dyn FnMut(&str) -> Option<ModuleId>,
) {
    let imports = modules[module.0 as usize].imports.clone();
    for id in imports {
        let sym = &modules[module.0 as usize].symbol_table[id.0 as usize];
        let source = match &sym.source {
            Nullable::Value(source) if !source.is_empty() => source.clone(),
            _ => continue,
        };
        let imported = sym.imported.clone();
        let Some(other) = lookup(&source) else {
            continue;
        };
        let found = imported.and_then(|name| modules[other.0 as usize].symbols.get(&name).copied());
        // `target?.exported ? target : null`
        let target = found.filter(|t| {
            modules[other.0 as usize].symbol_table[t.0 as usize].exported == Some(true)
        });
        let target_ref = target.map(|symbol| SymbolRef {
            module: other,
            symbol,
        });
        let is_component = target.is_some_and(|t| {
            modules[other.0 as usize].symbol_table[t.0 as usize].kind == SymbolKind::Component
        });
        let sym = &mut modules[module.0 as usize].symbol_table[id.0 as usize];
        sym.target = target_ref.map_or(Nullable::Null, Nullable::Value);
        sym.component = match target_ref {
            Some(t) if is_component => Nullable::Value(t),
            _ => Nullable::Null,
        };
        sym.resolved = Some(true);
    }
}

/// The older name of `bind_imports`, kept for its callers.
pub fn bind_imported_components(
    modules: &mut [Bound],
    module: ModuleId,
    lookup: &mut dyn FnMut(&str) -> Option<ModuleId>,
) {
    bind_imports(modules, module, lookup);
}

/// Resolve a name starting in `scope`.
#[must_use]
pub fn resolve_symbol(bound: &Bound, scope: ScopeId, name: &str) -> Option<SymbolId> {
    let mut s = Some(scope);
    while let Some(id) = s {
        let scope = &bound.scopes[id.0 as usize];
        if let Some(hit) = scope.symbols.get(name) {
            return Some(*hit);
        }
        s = scope.parent;
    }
    None
}
