//! Port of packages/compiler/src/bx/elaborate.mjs:1-432
//!
//! Lowers `.8bx` declarations and elements to ordinary core AST. A `component Name(props) { body }`
//! becomes a function of the same name, marked `component`; an element `<Name a={x} />` becomes the
//! call `Name(x);` where the element stood. A component with a `<slot />` is split into
//! `Name__open` and `Name__close`; state becomes module-level globals and methods are hoisted
//! (see the header of the JS for the reasoning).
//!
//! The JS rewrites the tree in place and shares some nodes between several parents (the statements
//! around a slot appear in all three functions of a slotted component). Here every output node is
//! its own copy (R1.1, R1.7); the JSON is the same, only the sharing is gone.
//!
//! `NodeId`s follow R1.10. A clone of a node the JS shares keeps its ids. Every node made here (a
//! JS `node(...)`, a `cloneNode` copy with everything inside it, a `{ ...n }` copy) gets a fresh
//! id from a counter that starts one above the largest id of the tree at entry; a copy is
//! renumbered in `syntax::children_mut` pre-order. Nothing renumbers the tree afterwards.
//!
//! The binder's symbols hold `NodeId`s into the tree they were bound from (`symbol.node`, a
//! prop's `default_value` and `type_annotation`). The module's own tree is looked up in a snapshot
//! taken before the rewrite; the tree of another module (an imported component's props) comes from
//! `trees`. A node that cannot be found sets the "missing" flag and the call returns
//! [`MissingNode`]; the tree is then unspecified.

use std::cell::Cell;
use std::collections::HashMap;

use indexmap::IndexMap;
use jsnum::Nullable;
use sema::binder::component_of;
use sema::binder::types::{Bound, ModuleId, Symbol, SymbolKind, SymbolRef};
use syntax::{Node, NodeId, NodeKind, StateField, children_mut, utf16_len, walk};

const OPEN: &str = "__open";
const CLOSE: &str = "__close";

/// A symbol named a node of a tree the caller did not provide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MissingNode;

/// What `imported()` needs to know about one `import` of the module, as it was before the rewrite.
struct ImportInfo {
    /// `s.source?.value`.
    source: Option<String>,
    /// The specifiers' names; grows as halves are added.
    names: Vec<String>,
    /// `(name, start, length)` of each specifier.
    specs: Vec<(String, u32, u32)>,
    /// Where the declaration ended up in the output body.
    out: usize,
}

struct Ctx<'a> {
    modules: &'a [Bound],
    module: ModuleId,
    /// Pre-order node lists, by module (the module's own is its snapshot).
    trees: Vec<Option<Vec<&'a Node>>>,
    /// The next fresh `NodeId` (R1.10).
    ids: &'a Cell<u32>,
    file: &'a str,
    hoisted: u32,
    instances: u32,
    imports: Vec<ImportInfo>,
    /// `(index into imports, specifier)` pushed by `imported()`.
    added: Vec<(usize, Node)>,
    missing: bool,
}

fn end_of(n: &Node) -> u32 {
    n.start.saturating_add(n.length)
}

/// A node the JS builds with `node(...)`: a fresh id (R1.10).
fn mk(ids: &Cell<u32>, start: u32, end: u32, kind: NodeKind) -> Node {
    let mut n = Node::new(start, end, kind);
    n.id = NodeId(ids.get());
    ids.set(ids.get().saturating_add(1));
    n
}

/// Fresh ids for `n` and everything under it: a JS `cloneNode` copy (R1.10).
fn renumber(ids: &Cell<u32>, n: &mut Node) {
    n.id = NodeId(ids.get());
    ids.set(ids.get().saturating_add(1));
    for child in children_mut(n) {
        renumber(ids, child);
    }
}

fn copied(ids: &Cell<u32>, n: &Node) -> Node {
    let mut copy = n.clone();
    renumber(ids, &mut copy);
    copy
}

fn ident(ids: &Cell<u32>, start: u32, end: u32, name: String) -> Node {
    mk(
        ids,
        start,
        end,
        NodeKind::Identifier {
            name,
            compile_time: None,
            imported: None,
        },
    )
}

fn is_slot(n: &Node) -> bool {
    matches!(&n.kind, NodeKind::BxElement { name, .. } if name == "slot")
}

/// `x.name` for a child that should be an `Identifier`; `None` when absent or empty (falsy).
fn name_of(n: &Option<Box<Node>>) -> Option<&str> {
    match n.as_deref().map(|n| &n.kind) {
        Some(NodeKind::Identifier { name, .. }) if !name.is_empty() => Some(name),
        _ => None,
    }
}

/// `block?.body ?? []`.
fn body_of(block: Option<&Node>) -> &[Node] {
    match block.map(|b| &b.kind) {
        Some(NodeKind::BlockStatement { body }) => body,
        _ => &[],
    }
}

fn block(ids: &Cell<u32>, stmts: Vec<Node>, at: &Node) -> Node {
    mk(
        ids,
        at.start,
        end_of(at),
        NodeKind::BlockStatement { body: stmts },
    )
}

/// The element's text children, already normalized by the parser, as one string.
fn bx_text_value(children: &[Node]) -> String {
    children
        .iter()
        .filter_map(|c| match &c.kind {
            NodeKind::BxText { value, .. } => Some(value.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// An argument that may run code: anything but a name or a literal.
fn may_have_effect(expr: &Node) -> bool {
    let mut effect = false;
    walk(expr, &mut |n, _| {
        if matches!(
            n.kind,
            NodeKind::CallExpression { .. }
                | NodeKind::AssignmentExpression { .. }
                | NodeKind::UpdateExpression { .. }
                | NodeKind::TemplateLiteral { .. }
        ) {
            effect = true;
        }
    });
    effect
}

/// `name(args);` where the element stood, with the element's span and, when the component keeps
/// state, its instance tag.
fn call_statement(
    ids: &Cell<u32>,
    el: &Node,
    name: &str,
    args: Vec<Node>,
    instance: Option<String>,
) -> Node {
    let end = end_of(el);
    let el_name_len = match &el.kind {
        NodeKind::BxElement { name, .. } => utf16_len(name),
        _ => 0,
    };
    let callee = ident(
        ids,
        el.start,
        el.start.saturating_add(el_name_len).saturating_add(1),
        name.to_string(),
    );
    let call = mk(
        ids,
        el.start,
        end,
        NodeKind::CallExpression {
            callee: Box::new(callee),
            args,
            instance,
        },
    );
    mk(
        ids,
        el.start,
        end,
        NodeKind::ExpressionStatement {
            expression: Box::new(call),
        },
    )
}

/// The identifier and call renames of `rewrite` over one tree, parents before children.
fn rename(
    n: &mut Node,
    is_property: bool,
    by_field: &HashMap<String, String>,
    by_method: &HashMap<String, String>,
) {
    if !is_property
        && let NodeKind::Identifier { name, .. } = &mut n.kind
        && let Some(global) = by_field.get(name.as_str())
    {
        name.clone_from(global);
    }
    if let NodeKind::CallExpression { callee, .. } = &mut n.kind
        && let NodeKind::Identifier { name, .. } = &mut callee.kind
        && let Some(hoisted) = by_method.get(name.as_str())
    {
        name.clone_from(hoisted);
    }
    if let NodeKind::MemberExpression { object, property } = &mut n.kind {
        rename(object, false, by_field, by_method);
        rename(property, true, by_field, by_method);
        for d in n.decorators.iter_mut().flatten() {
            rename(d, false, by_field, by_method);
        }
        return;
    }
    for child in children_mut(n) {
        rename(child, false, by_field, by_method);
    }
}

fn index_of(root: &Node) -> Vec<&Node> {
    let mut nodes = Vec::new();
    walk(root, &mut |n, _| nodes.push(n));
    nodes
}

impl<'a> Ctx<'a> {
    fn symbol(&self, r: SymbolRef) -> Option<&'a Symbol> {
        let modules: &'a [Bound] = self.modules;
        modules
            .get(r.module.0 as usize)?
            .symbol_table
            .get(r.symbol.0 as usize)
    }

    fn node_at(&mut self, module: ModuleId, id: NodeId) -> Option<&'a Node> {
        let found = self
            .trees
            .get(module.0 as usize)
            .and_then(Option::as_ref)
            .and_then(|nodes| nodes.get(id.0 as usize))
            .copied();
        if found.is_none() {
            self.missing = true;
        }
        found
    }

    /// The component a name in this module stands for.
    fn component(&self, name: &str) -> Option<SymbolRef> {
        let id = self
            .modules
            .get(self.module.0 as usize)?
            .symbols
            .get(name)?;
        component_of(
            self.modules,
            Some(SymbolRef {
                module: self.module,
                symbol: *id,
            }),
        )
    }

    /// The arguments of the call an element becomes, one per parameter of the component.
    fn arguments_for(&mut self, el: &Node, comp: SymbolRef) -> Vec<Node> {
        let NodeKind::BxElement {
            attributes,
            children,
            ..
        } = &el.kind
        else {
            return Vec::new();
        };
        let ids = self.ids;
        let mut by_name: IndexMap<&str, Node> = IndexMap::new();
        for attr in attributes {
            if let NodeKind::BxAttribute { name, value } = &attr.kind {
                let value = value.as_deref().cloned().unwrap_or_else(|| {
                    mk(
                        ids,
                        attr.start,
                        end_of(attr),
                        NodeKind::BooleanLiteral { value: true },
                    )
                });
                by_name.insert(name.as_str(), value);
            }
        }
        let text = bx_text_value(children);
        let mut args = Vec::new();
        let Some(sym) = self.symbol(comp) else {
            return args;
        };
        for prop in sym.props.as_deref().unwrap_or(&[]) {
            if let Some(value) = by_name.get(prop.name.as_str()) {
                args.push(value.clone());
            } else if prop.name == "children" && !text.is_empty() {
                args.push(mk(
                    ids,
                    el.start,
                    el.start,
                    NodeKind::StringLiteral {
                        value: text.clone(),
                        unterminated: None,
                    },
                ));
            } else if let Some(id) = prop.default_value {
                match self.node_at(comp.module, id) {
                    Some(default) => args.push(copied(ids, default)),
                    None => break,
                }
            } else {
                // Missing and required: the checker reported it. Stop here so the call is still
                // well-formed for whatever comes next.
                break;
            }
        }
        args
    }

    /// The instance tag for one element of a stateful component, or `None` for a stateless one.
    fn instance_tag(&mut self, comp: SymbolRef) -> Option<String> {
        if !self
            .symbol(comp)
            .is_some_and(|s| s.state.as_ref().is_some_and(|f| !f.is_empty()))
        {
            return None;
        }
        self.instances += 1;
        Some(format!("{}#{}", self.file, self.instances))
    }

    /// The name a half of a slotted component is called by here; an imported component's half is
    /// added to the import that brought the component in.
    fn imported(&mut self, local: &str, suffix: &str) -> String {
        let half = format!("{local}{suffix}");
        let modules: &'a [Bound] = self.modules;
        let Some(named) = modules
            .get(self.module.0 as usize)
            .and_then(|m| m.symbols.get(local))
            .and_then(|id| {
                modules
                    .get(self.module.0 as usize)?
                    .symbol_table
                    .get(id.0 as usize)
            })
        else {
            return half;
        };
        if named.kind != SymbolKind::Import {
            return half;
        }
        let found = self.imports.iter().position(|d| match &named.source {
            Nullable::Value(s) => d.source.as_deref() == Some(s.as_str()),
            Nullable::Absent => d.source.is_none(),
            Nullable::Null => false,
        });
        if let Some(i) = found
            && !self.imports[i].names.contains(&half)
        {
            let spec = self.imports[i]
                .specs
                .iter()
                .find(|(name, _, _)| name == local)
                .map(|(_, start, length)| (*start, *length))
                .or_else(|| {
                    self.node_at(self.module, named.node)
                        .map(|n| (n.start, n.length))
                });
            if let Some((start, length)) = spec {
                let imported = format!("{}{suffix}", named.imported.as_deref().unwrap_or(local));
                self.imports[i].names.push(half.clone());
                self.added.push((
                    i,
                    mk(
                        self.ids,
                        start,
                        start.saturating_add(length),
                        NodeKind::Identifier {
                            name: half.clone(),
                            compile_time: None,
                            imported: Some(imported),
                        },
                    ),
                ));
            }
        }
        half
    }

    /// An element whose children go into a slot: the two halves around them.
    fn slotted_element(&mut self, el: &Node, comp: SymbolRef) -> Vec<Node> {
        let ids = self.ids;
        let args = self.arguments_for(el, comp);
        let mut stmts = Vec::new();
        let mut passed = Vec::new();
        for (i, arg) in args.into_iter().enumerate() {
            let prop = self
                .symbol(comp)
                .and_then(|s| s.props.as_deref())
                .and_then(|p| p.get(i));
            let annotation = prop.and_then(|p| p.type_annotation);
            let prop_name = prop.map(|p| p.name.clone());
            let (false, Some(annotation_id), Some(prop_name)) =
                (!may_have_effect(&arg), annotation, prop_name)
            else {
                passed.push(arg);
                continue;
            };
            self.hoisted += 1;
            let name = format!("__bx_{}_{prop_name}", self.hoisted);
            let make_id = |start: u32| {
                ident(
                    ids,
                    start,
                    start.saturating_add(utf16_len(&name)),
                    name.clone(),
                )
            };
            let type_annotation = self
                .node_at(comp.module, annotation_id)
                .map(|a| Box::new(copied(ids, a)));
            let (start, end) = (arg.start, end_of(&arg));
            stmts.push(mk(
                ids,
                start,
                end,
                NodeKind::VariableDeclaration {
                    kind: "let".into(),
                    name: Some(Box::new(make_id(start))),
                    type_annotation,
                    initializer: Some(Box::new(arg)),
                    exported: false,
                    immutable: None,
                },
            ));
            passed.push(make_id(start));
        }
        let local = match &el.kind {
            NodeKind::BxElement { name, .. } => name.clone(),
            _ => String::new(),
        };
        let open = self.imported(&local, OPEN);
        let close = self.imported(&local, CLOSE);
        let instance = self.instance_tag(comp);
        stmts.push(call_statement(
            ids,
            el,
            &open,
            passed.clone(),
            instance.clone(),
        ));
        if let NodeKind::BxElement { children, .. } = &el.kind {
            for child in children {
                if !matches!(child.kind, NodeKind::BxText { .. }) {
                    stmts.extend(self.element_tree(child));
                }
            }
        }
        let passed: Vec<Node> = passed.iter().map(|a| copied(ids, a)).collect();
        stmts.push(call_statement(ids, el, &close, passed, instance));
        stmts
    }

    fn element(&mut self, el: &Node) -> Vec<Node> {
        let NodeKind::BxElement { name, children, .. } = &el.kind else {
            return Vec::new();
        };
        let Some(comp) = self.component(name) else {
            return Vec::new();
        };
        // Children that compose: elements, fragments, and `{...}` fields that hold a composition.
        let element_children = children.iter().any(|c| match &c.kind {
            NodeKind::BxElement { .. } | NodeKind::BxFragment { .. } => true,
            NodeKind::BxExpressionChild { expression } => expression.is_some(),
            _ => false,
        });
        let allows = self
            .symbol(comp)
            .and_then(|s| s.allows_children)
            .unwrap_or(false);
        if element_children && allows {
            return self.slotted_element(el, comp);
        }
        // No slot to put children in: the checker said so; they are dropped here.
        let args = self.arguments_for(el, comp);
        let instance = self.instance_tag(comp);
        vec![call_statement(self.ids, el, name, args, instance)]
    }

    /// A composition-valued expression as statements, or `None` when the expression is not one.
    fn composition_of(&mut self, expr: Option<&Node>) -> Option<Vec<Node>> {
        let expr = expr?;
        match &expr.kind {
            NodeKind::BxElement { .. } | NodeKind::BxFragment { .. } => {
                Some(self.element_tree(expr))
            }
            NodeKind::ConditionalExpression {
                test,
                consequent,
                alternate,
            } => {
                let yes = self.composition_of(consequent.as_deref());
                let no = self.composition_of(alternate.as_deref());
                let (Some(yes), Some(no), Some(consequent), Some(alternate)) =
                    (yes, no, consequent.as_deref(), alternate.as_deref())
                else {
                    return None;
                };
                let ids = self.ids;
                Some(vec![mk(
                    ids,
                    expr.start,
                    end_of(expr),
                    NodeKind::IfStatement {
                        test: Some(test.clone()),
                        consequent: Some(Box::new(block(ids, yes, consequent))),
                        alternate: Some(Box::new(block(ids, no, alternate))),
                    },
                )])
            }
            NodeKind::BinaryExpression {
                operator,
                left,
                right,
            } if operator == "&&" => {
                let yes = self.composition_of(Some(right))?;
                let ids = self.ids;
                Some(vec![mk(
                    ids,
                    expr.start,
                    end_of(expr),
                    NodeKind::IfStatement {
                        test: Some(left.clone()),
                        consequent: Some(Box::new(block(ids, yes, right))),
                        alternate: None,
                    },
                )])
            }
            _ => None,
        }
    }

    fn element_tree(&mut self, n: &Node) -> Vec<Node> {
        match &n.kind {
            NodeKind::BxFragment { children } => {
                children.iter().flat_map(|c| self.element_tree(c)).collect()
            }
            NodeKind::BxElement { .. } => self.element(n),
            // An empty field (a comment) is nothing; a composition is its statements; anything
            // else the checker has already reported.
            NodeKind::BxExpressionChild { expression } => self
                .composition_of(expression.as_deref())
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    /// `transformStatement(stmt)[0]`, with a missing statement staying missing.
    fn transform_first(&mut self, stmt: Option<&Node>) -> Option<Box<Node>> {
        let stmt = stmt?;
        self.transform_statement(stmt)
            .into_iter()
            .next()
            .map(Box::new)
    }

    fn transform_all(&mut self, stmts: &[Node]) -> Vec<Node> {
        stmts
            .iter()
            .flat_map(|s| self.transform_statement(s))
            .collect()
    }

    fn transform_statement(&mut self, stmt: &Node) -> Vec<Node> {
        let (start, end) = (stmt.start, end_of(stmt));
        let ids = self.ids;
        let rebuilt = |kind: NodeKind| {
            let mut n = mk(ids, start, end, kind);
            n.decorators.clone_from(&stmt.decorators);
            vec![n]
        };
        match &stmt.kind {
            NodeKind::BxElement { .. } | NodeKind::BxFragment { .. } => self.element_tree(stmt),
            NodeKind::ReturnStatement {
                argument: Some(argument),
            } => {
                // `return (<.../>)` in a component body: the composition, here.
                match self.composition_of(Some(argument)) {
                    Some(composed) => composed,
                    None => vec![stmt.clone()],
                }
            }
            NodeKind::BlockStatement { body } => {
                let body = self.transform_all(body);
                rebuilt(NodeKind::BlockStatement { body })
            }
            NodeKind::IfStatement {
                test,
                consequent,
                alternate,
            } => {
                let consequent = self.transform_first(consequent.as_deref());
                let alternate = self.transform_first(alternate.as_deref());
                rebuilt(NodeKind::IfStatement {
                    test: test.clone(),
                    consequent,
                    alternate,
                })
            }
            NodeKind::WhileStatement { test, body } => {
                let body = self.transform_first(body.as_deref());
                rebuilt(NodeKind::WhileStatement {
                    test: test.clone(),
                    body,
                })
            }
            NodeKind::ForStatement {
                init,
                test,
                update,
                body,
            } => {
                let body = self.transform_first(body.as_deref());
                rebuilt(NodeKind::ForStatement {
                    init: init.clone(),
                    test: test.clone(),
                    update: update.clone(),
                    body,
                })
            }
            _ => vec![stmt.clone()],
        }
    }

    /// One function of a component: the whole body (`suffix` empty), or one half of it.
    fn component_fn(
        &mut self,
        stmt: &Node,
        suffix: &str,
        body: &[Node],
        owner: &str,
        state: &[StateField],
    ) -> Node {
        let NodeKind::ComponentDeclaration {
            name,
            params,
            body: component_body,
            exported,
            ..
        } = &stmt.kind
        else {
            // Only `component_function` calls this, on a `ComponentDeclaration`.
            return stmt.clone();
        };
        let ids = self.ids;
        let span = component_body.as_deref().unwrap_or(stmt);
        let fn_name = match name.as_deref() {
            Some(n) if !suffix.is_empty() => Some(Box::new(ident(
                ids,
                n.start,
                end_of(n),
                format!("{owner}{suffix}"),
            ))),
            _ => name.clone(),
        };
        let statements = self.transform_all(body);
        let params = if suffix.is_empty() {
            params.clone()
        } else {
            params.iter().map(|p| copied(ids, p)).collect()
        };
        mk(
            ids,
            stmt.start,
            end_of(stmt),
            NodeKind::FunctionDeclaration {
                name: fn_name,
                params,
                return_type: None,
                body: Some(Box::new(block(ids, statements, span))),
                exported: *exported,
                component: Some(true),
                owner: Some(owner.to_string()),
                method: None,
                state: (!state.is_empty()).then(|| state.to_vec()),
            },
        )
    }

    /// A component declaration as the function(s) it is.
    fn component_function(&mut self, stmt: &Node) -> Vec<Node> {
        let NodeKind::ComponentDeclaration {
            name, body: cbody, ..
        } = &stmt.kind
        else {
            return vec![stmt.clone()];
        };
        // `component` with no name yet (mid-keystroke) is nothing to elaborate.
        let Some(owner) = name_of(name) else {
            return Vec::new();
        };
        let ids = self.ids;
        let declared = body_of(cbody.as_deref());
        // State: one template global per field, at module level, and the body reading and
        // writing it by that name.
        let fields: Vec<(&Node, &str)> = declared
            .iter()
            .filter(|s| matches!(s.kind, NodeKind::StateDeclaration { .. }))
            .filter_map(|s| match &s.kind {
                NodeKind::StateDeclaration { name, .. } => name_of(name).map(|n| (s, n)),
                _ => None,
            })
            .collect();
        let state: Vec<StateField> = fields
            .iter()
            .map(|(_, field)| StateField {
                field: (*field).to_string(),
                global: format!("__bx_{owner}__{field}"),
            })
            .collect();
        let globals: Vec<Node> = fields
            .iter()
            .zip(&state)
            .filter_map(|((f, _), s)| {
                let NodeKind::StateDeclaration {
                    name,
                    type_annotation,
                    initializer,
                    ..
                } = &f.kind
                else {
                    return None;
                };
                let n = name.as_deref()?;
                Some(mk(
                    ids,
                    f.start,
                    end_of(f),
                    NodeKind::VariableDeclaration {
                        kind: "let".into(),
                        name: Some(Box::new(ident(ids, n.start, end_of(n), s.global.clone()))),
                        type_annotation: type_annotation.clone(),
                        initializer: initializer.clone(),
                        exported: false,
                        immutable: None,
                    },
                ))
            })
            .collect();
        let by_field: HashMap<String, String> = state
            .iter()
            .map(|s| (s.field.clone(), s.global.clone()))
            .collect();
        // Methods: the body's own functions, hoisted under the component's name.
        let methods: Vec<(&Node, &str)> = declared
            .iter()
            .filter_map(|s| match &s.kind {
                NodeKind::FunctionDeclaration { name, .. } => name_of(name).map(|n| (s, n)),
                _ => None,
            })
            .collect();
        let by_method: HashMap<String, String> = methods
            .iter()
            .map(|(_, m)| ((*m).to_string(), format!("{owner}__{m}")))
            .collect();
        let rewrite = |s: &Node| -> Node {
            let mut copy = s.clone();
            if !by_field.is_empty() || !by_method.is_empty() {
                renumber(ids, &mut copy);
                rename(&mut copy, false, &by_field, &by_method);
            }
            copy
        };
        let statements: Vec<Node> = declared
            .iter()
            .filter(|s| {
                !matches!(
                    s.kind,
                    NodeKind::StateDeclaration { .. } | NodeKind::FunctionDeclaration { .. }
                )
            })
            .map(rewrite)
            .collect();
        let mut hoisted = Vec::new();
        for (m, method_name) in &methods {
            let method = rewrite(m);
            let NodeKind::FunctionDeclaration {
                params,
                return_type,
                body,
                ..
            } = method.kind
            else {
                continue;
            };
            let at = body.as_deref().unwrap_or(m);
            let statements = self.transform_all(body_of(body.as_deref()));
            let new_body = block(ids, statements, at);
            let NodeKind::FunctionDeclaration { name: Some(n), .. } = &m.kind else {
                continue;
            };
            let mut node = mk(
                ids,
                m.start,
                end_of(m),
                NodeKind::FunctionDeclaration {
                    name: Some(Box::new(ident(
                        ids,
                        n.start,
                        end_of(n),
                        by_method[*method_name].clone(),
                    ))),
                    params,
                    return_type,
                    body: Some(Box::new(new_body)),
                    exported: false,
                    component: Some(true),
                    owner: Some(owner.to_string()),
                    method: Some(true),
                    state: (!state.is_empty()).then(|| state.clone()),
                },
            );
            node.decorators = method.decorators;
            hoisted.push(node);
        }
        let mut out = globals;
        out.extend(hoisted);
        let Some(slot) = statements.iter().position(is_slot) else {
            out.push(self.component_fn(stmt, "", &statements, owner, &state));
            return out;
        };
        let before = &statements[..slot];
        let after: Vec<Node> = statements[slot + 1..]
            .iter()
            .filter(|s| !is_slot(s))
            .cloned()
            .collect();
        let whole: Vec<Node> = before.iter().chain(&after).cloned().collect();
        out.push(self.component_fn(stmt, "", &whole, owner, &state));
        out.push(self.component_fn(stmt, OPEN, before, owner, &state));
        out.push(self.component_fn(stmt, CLOSE, &after, owner, &state));
        out
    }

    fn transform_decl(&mut self, mut stmt: Node) -> Vec<Node> {
        match &mut stmt.kind {
            NodeKind::FunctionDeclaration {
                body: Some(body), ..
            } => {
                let statements = self.transform_all(body_of(Some(body)));
                let new_body = block(self.ids, statements, body);
                **body = new_body;
                // The JS spreads the declaration into a new object.
                stmt.id = NodeId(self.ids.get());
                self.ids.set(self.ids.get().saturating_add(1));
                vec![stmt]
            }
            NodeKind::ComponentDeclaration { .. } => self.component_function(&stmt),
            _ => vec![stmt],
        }
    }
}

/// Lowers the program in place: no BX node is left in it.
///
/// `ast` must be numbered (`syntax::number_nodes`), so the `NodeId`s of `modules[module]`'s
/// symbols index it. `trees[m]` is the tree module `m` was bound from, needed for the props of an
/// imported component (its `default_value` and `type_annotation` live there); the entry for
/// `module` itself is ignored. For an imported component `trees[m]` must be the definer's tree in
/// its current state, since the fold rewrites the JS default-value nodes in place.
///
/// # Errors
/// [`MissingNode`] when a symbol points into a tree that `trees` does not hold. The tree is then
/// left in an unspecified state.
pub fn elaborate_bx(
    ast: &mut Node,
    modules: &[Bound],
    module: ModuleId,
    trees: &[Option<&Node>],
    file: &str,
) -> Result<(), MissingNode> {
    if !matches!(ast.kind, NodeKind::Program { .. }) {
        return Ok(());
    }
    let snapshot = ast.clone();
    let mut largest = 0;
    walk(&snapshot, &mut |n, _| largest = largest.max(n.id.0));
    let ids = Cell::new(largest.saturating_add(1));
    let count = modules.len().max(trees.len()).max(module.0 as usize + 1);
    let all: Vec<Option<Vec<&Node>>> = (0..count)
        .map(|m| {
            if m == module.0 as usize {
                Some(index_of(&snapshot))
            } else {
                trees.get(m).copied().flatten().map(index_of)
            }
        })
        .collect();
    let NodeKind::Program { body } = &mut ast.kind else {
        return Ok(());
    };
    let original = std::mem::take(body);
    let mut ctx = Ctx {
        modules,
        module,
        trees: all,
        ids: &ids,
        file,
        hoisted: 0,
        instances: 0,
        imports: Vec::new(),
        added: Vec::new(),
        missing: false,
    };
    let mut import_slot: HashMap<usize, usize> = HashMap::new();
    for (i, stmt) in original.iter().enumerate() {
        if let NodeKind::ImportDeclaration {
            specifiers, source, ..
        } = &stmt.kind
        {
            import_slot.insert(i, ctx.imports.len());
            let mut names = Vec::new();
            let mut specs = Vec::new();
            for sp in specifiers {
                if let NodeKind::Identifier { name, .. } = &sp.kind {
                    names.push(name.clone());
                    specs.push((name.clone(), sp.start, sp.length));
                }
            }
            ctx.imports.push(ImportInfo {
                source: source.as_deref().and_then(|s| match &s.kind {
                    NodeKind::StringLiteral { value, .. } => Some(value.clone()),
                    _ => None,
                }),
                names,
                specs,
                out: 0,
            });
        }
    }
    // Like the JS: every `transformDecl` first, then every `transformStatement`, so the instance
    // and hoist counters run in that order. An import declaration stays one node in both passes.
    let mut decls: Vec<Node> = Vec::new();
    let mut decl_slot: HashMap<usize, usize> = HashMap::new();
    for (i, stmt) in original.into_iter().enumerate() {
        if let Some(slot) = import_slot.get(&i).copied() {
            decl_slot.insert(decls.len(), slot);
        }
        decls.extend(ctx.transform_decl(stmt));
    }
    let mut out: Vec<Node> = Vec::new();
    for (i, decl) in decls.iter().enumerate() {
        if let Some(slot) = decl_slot.get(&i).copied() {
            ctx.imports[slot].out = out.len();
        }
        out.extend(ctx.transform_statement(decl));
    }
    for (slot, spec) in std::mem::take(&mut ctx.added) {
        if let Some(NodeKind::ImportDeclaration { specifiers, .. }) =
            out.get_mut(ctx.imports[slot].out).map(|n| &mut n.kind)
        {
            specifiers.push(spec);
        }
    }
    let missing = ctx.missing;
    *body = out;
    if missing { Err(MissingNode) } else { Ok(()) }
}
