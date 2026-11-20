//! Port of packages/compiler/src/checker/scopes.mjs:1-153
//!
//! The block-scope store scan shared by the E20 checker rule (`immutable`) and `8bs migrate`'s
//! mutability scan. Both must agree on what a store reaches, so there is one walk.
//!
//! Names resolve by block scope, not per module or function: a block, an `if` or `while` branch,
//! a `for` header and its body, and a function (its parameters and body) each open a scope, and
//! module-level names (and a `mod`'s members) are visible everywhere in the file in any order.
//!
//! Scopes live in an arena (R1.4): a `ScopeId` indexes [`Scopes`], and a `mod`'s member scope is
//! referred to by id from the namespace entry. A bare `BxElement` or `BxFragment` has no name the
//! module scope could hold, so `hoist` never reaches the one JS case where `s.name.name` is
//! `undefined`: the parser puts those only inside component bodies, never in a module body or a
//! namespace member list.

use indexmap::IndexMap;
use syntax::{Node, NodeKind};

/// Index of a scope in [`Scopes`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopeId(pub u32);

/// What a name is bound to in a scope.
#[derive(Debug, Clone)]
pub enum Entry<'a> {
    /// A `let`/`const`/`state` declaration (`{ kind: decl.kind, decl }`).
    Variable { kind: &'a str, decl: &'a Node },
    /// A `mod`, with the scope of its members.
    Namespace { members: ScopeId },
    /// Any other declared name (function, import, component, ...).
    Other,
    /// A function parameter.
    Param,
}

/// One scope: its parent and its names in insertion order.
#[derive(Debug, Clone)]
pub struct Scope<'a> {
    pub parent: Option<ScopeId>,
    pub names: IndexMap<String, Entry<'a>>,
}

/// The arena of every scope a walk creates.
#[derive(Debug, Default)]
pub struct Scopes<'a> {
    scopes: Vec<Scope<'a>>,
}

/// The `let` a store writes to, and the name node to point at.
#[derive(Debug, Clone, Copy)]
pub struct ScopeTarget<'a> {
    pub decl: &'a Node,
    pub name: &'a Node,
}

impl<'a> Scopes<'a> {
    fn new_scope(&mut self, parent: Option<ScopeId>) -> ScopeId {
        self.scopes.push(Scope {
            parent,
            names: IndexMap::new(),
        });
        ScopeId(u32::try_from(self.scopes.len() - 1).unwrap_or(u32::MAX))
    }

    /// The scope with this id.
    #[must_use]
    pub fn get(&self, id: ScopeId) -> &Scope<'a> {
        &self.scopes[id.0 as usize]
    }

    fn set(&mut self, id: ScopeId, name: &str, entry: Entry<'a>) {
        self.scopes[id.0 as usize]
            .names
            .insert(name.to_string(), entry);
    }

    /// `scopeLookup`: the nearest binding of `name`, walking out through the parents.
    #[must_use]
    pub fn lookup(&self, scope: ScopeId, name: &str) -> Option<&Entry<'a>> {
        let mut current = Some(scope);
        while let Some(id) = current {
            let s = self.get(id);
            if let Some(hit) = s.names.get(name) {
                return Some(hit);
            }
            current = s.parent;
        }
        None
    }

    fn declare_variable(&mut self, scope: ScopeId, decl: &'a Node) {
        let (NodeKind::VariableDeclaration { kind, name, .. }
        | NodeKind::StateDeclaration { kind, name, .. }) = &decl.kind
        else {
            return;
        };
        if let Some(name) = name.as_deref().and_then(identifier_name) {
            self.set(scope, name, Entry::Variable { kind, decl });
        }
    }

    /// Module-level names are visible everywhere in the file, in any order.
    fn hoist(&mut self, scope: ScopeId, body: &[Option<&'a Node>]) {
        for s in body.iter().copied().flatten() {
            match &s.kind {
                NodeKind::VariableDeclaration { .. } => self.declare_variable(scope, s),
                NodeKind::NamespaceDeclaration {
                    name: Some(name),
                    members,
                    ..
                } => {
                    let members_scope = self.new_scope(Some(scope));
                    let members: Vec<Option<&'a Node>> =
                        members.iter().map(Option::as_ref).collect();
                    self.hoist(members_scope, &members);
                    if let Some(name) = identifier_name(name) {
                        self.set(
                            scope,
                            name,
                            Entry::Namespace {
                                members: members_scope,
                            },
                        );
                    }
                }
                NodeKind::ImportDeclaration { specifiers, .. } => {
                    for spec in specifiers {
                        if let Some(name) = identifier_name(spec) {
                            self.set(scope, name, Entry::Other);
                        }
                    }
                }
                other => {
                    if let Some(name) = declared_name(other) {
                        self.set(scope, name, Entry::Other);
                    }
                }
            }
        }
    }

    /// `scopeTargetOf`: the declared `let` a store target writes to and the name node to point
    /// at, or `None`. `a[i] = ...` writes to `a`; `ns::x = ...` to the `let` named `x` in
    /// namespace `ns`.
    #[must_use]
    pub fn target_of(&self, scope: ScopeId, target: &'a Node) -> Option<ScopeTarget<'a>> {
        let mut n = target;
        while let NodeKind::IndexExpression { object, .. } = &n.kind {
            n = object;
        }
        match &n.kind {
            NodeKind::MemberExpression { object, property } => {
                let NodeKind::Identifier { name: ns_name, .. } = &object.kind else {
                    return None;
                };
                let Some(Entry::Namespace { members }) = self.lookup(scope, ns_name) else {
                    return None;
                };
                let member = self.get(*members).names.get(identifier_name(property)?);
                match member {
                    Some(Entry::Variable { kind: "let", decl }) => Some(ScopeTarget {
                        decl,
                        name: property,
                    }),
                    _ => None,
                }
            }
            NodeKind::Identifier { name, .. } => match self.lookup(scope, name) {
                Some(Entry::Variable { kind: "let", decl }) => Some(ScopeTarget { decl, name: n }),
                _ => None,
            },
            _ => None,
        }
    }
}

/// The `name` of an `Identifier` node.
fn identifier_name(node: &Node) -> Option<&str> {
    match &node.kind {
        NodeKind::Identifier { name, .. } => Some(name),
        _ => None,
    }
}

/// The name node's text of a declaration that has one (JS `s?.name`, then `.name.name`).
fn declared_name(kind: &NodeKind) -> Option<&str> {
    match kind {
        NodeKind::FunctionDeclaration { name, .. }
        | NodeKind::ComponentDeclaration { name, .. }
        | NodeKind::StateDeclaration { name, .. }
        | NodeKind::NamespaceDeclaration { name, .. } => name.as_deref().and_then(identifier_name),
        _ => None,
    }
}

/// `scopeStoreTarget`: the expression a node stores to, or `None` when it is not a store.
#[must_use]
pub fn store_target(n: &Node) -> Option<&Node> {
    match &n.kind {
        NodeKind::AssignmentExpression { left, .. } => Some(left),
        NodeKind::UpdateExpression { argument, .. } => Some(argument),
        _ => None,
    }
}

/// `onExpression(scope, root)` of `walkScopes`.
pub type OnExpression<'a, 'f> = dyn FnMut(&Scopes<'a>, ScopeId, &'a Node) + 'f;

/// `options.skipUpdate` of `walkScopes`: drops a `for` update from the scan when it returns true.
pub type SkipUpdate<'a, 'f> = dyn Fn(&'a Node) -> bool + 'f;

struct Walker<'a, 'f> {
    scopes: Scopes<'a>,
    on_expression: &'f mut OnExpression<'a, 'f>,
    skip_update: Option<&'f SkipUpdate<'a, 'f>>,
}

impl<'a> Walker<'a, '_> {
    fn visit_expression(&mut self, scope: ScopeId, root: Option<&'a Node>) {
        if let Some(root) = root {
            (self.on_expression)(&self.scopes, scope, root);
        }
    }

    fn visit_statements(&mut self, scope: ScopeId, body: Vec<Option<&'a Node>>) {
        for s in body {
            self.visit_statement(scope, s);
        }
    }

    fn visit_function(&mut self, scope: ScopeId, params: &'a [Node], body: Option<&'a Node>) {
        let fn_scope = self.scopes.new_scope(Some(scope));
        for p in params {
            if let NodeKind::Parameter { name, .. } = &p.kind
                && let Some(name) = identifier_name(name)
            {
                self.scopes.set(fn_scope, name, Entry::Param);
            }
        }
        for p in params {
            if let NodeKind::Parameter { default_value, .. } = &p.kind {
                self.visit_expression(fn_scope, default_value.as_deref());
            }
        }
        self.visit_statement(fn_scope, body);
    }

    fn visit_for(&mut self, scope: ScopeId, s: &'a Node) {
        let NodeKind::ForStatement {
            init,
            test,
            update,
            body,
        } = &s.kind
        else {
            return;
        };
        let for_scope = self.scopes.new_scope(Some(scope));
        match init.as_deref() {
            Some(
                init @ Node {
                    kind: NodeKind::VariableDeclaration { .. },
                    ..
                },
            ) => self.visit_statement(for_scope, Some(init)),
            other => self.visit_expression(for_scope, other),
        }
        self.visit_expression(for_scope, test.as_deref());
        if !self.skip_update.is_some_and(|skip| skip(s)) {
            self.visit_expression(for_scope, update.as_deref());
        }
        let body_scope = self.scopes.new_scope(Some(for_scope));
        self.visit_statement(body_scope, body.as_deref());
    }

    fn visit_statement(&mut self, scope: ScopeId, s: Option<&'a Node>) {
        let Some(s) = s else {
            return;
        };
        match &s.kind {
            NodeKind::VariableDeclaration { initializer, .. }
            | NodeKind::StateDeclaration { initializer, .. } => {
                self.visit_expression(scope, initializer.as_deref());
                self.scopes.declare_variable(scope, s);
            }
            NodeKind::FunctionDeclaration { params, body, .. }
            | NodeKind::ComponentDeclaration { params, body, .. } => {
                self.visit_function(scope, params, body.as_deref());
            }
            NodeKind::NamespaceDeclaration { name, members, .. } => {
                let found = name
                    .as_deref()
                    .and_then(identifier_name)
                    .and_then(|name| self.scopes.lookup(scope, name));
                let members_scope = match found {
                    Some(Entry::Namespace { members }) => *members,
                    _ => scope,
                };
                for m in members {
                    self.visit_statement(members_scope, m.as_ref());
                }
            }
            NodeKind::BlockStatement { body } => {
                let inner = self.scopes.new_scope(Some(scope));
                self.visit_statements(inner, body.iter().map(Some).collect());
            }
            NodeKind::IfStatement {
                test,
                consequent,
                alternate,
            } => {
                self.visit_expression(scope, test.as_deref());
                let then_scope = self.scopes.new_scope(Some(scope));
                self.visit_statement(then_scope, consequent.as_deref());
                let else_scope = self.scopes.new_scope(Some(scope));
                self.visit_statement(else_scope, alternate.as_deref());
            }
            NodeKind::WhileStatement { test, body } => {
                self.visit_expression(scope, test.as_deref());
                let inner = self.scopes.new_scope(Some(scope));
                self.visit_statement(inner, body.as_deref());
            }
            NodeKind::ForStatement { .. } => self.visit_for(scope, s),
            NodeKind::ReturnStatement { argument } => {
                self.visit_expression(scope, argument.as_deref());
            }
            NodeKind::ExpressionStatement { expression } => {
                self.visit_expression(scope, Some(expression));
            }
            NodeKind::BxElement { .. } | NodeKind::BxFragment { .. } => {
                self.visit_expression(scope, Some(s));
            }
            _ => {}
        }
    }
}

/// `walkScopes`: walk every statement of `ast` with its block scope and call
/// `on_expression(scopes, scope, root)` for each expression root. `skip_update` drops a `for`
/// update from the scan when it returns true.
pub fn walk_scopes<'a, 'f>(
    ast: &'a Node,
    on_expression: &'f mut OnExpression<'a, 'f>,
    skip_update: Option<&'f SkipUpdate<'a, 'f>>,
) {
    let mut walker = Walker {
        scopes: Scopes::default(),
        on_expression,
        skip_update,
    };
    let module_scope = walker.scopes.new_scope(None);
    let body: &[Node] = match &ast.kind {
        NodeKind::Program { body } => body,
        _ => &[],
    };
    let items: Vec<Option<&Node>> = body.iter().map(Some).collect();
    walker.scopes.hoist(module_scope, &items);
    walker.visit_statements(module_scope, items);
}
