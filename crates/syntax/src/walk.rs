//! The walker and node numbering. `children` and `children_mut` are the one
//! child-order table (R1.8): the order of the parser's `node(...)` props,
//! then `decorators` (assigned after construction, `parser/index.mjs:464`).
//! Both are generated from the same table below, so the order cannot drift.

use crate::node::{Node, NodeId, NodeKind};

/// A child slot of a node, borrowed shared (`&Node`) or exclusive
/// (`&mut Node`), appended to `out` in order. A `None` is skipped, like the
/// JS `walk` skips `null`.
trait Slot<'a, T> {
    fn add(self, out: &mut Vec<T>);
}

impl<'a> Slot<'a, &'a Node> for &'a Box<Node> {
    fn add(self, out: &mut Vec<&'a Node>) {
        out.push(self);
    }
}
impl<'a> Slot<'a, &'a mut Node> for &'a mut Box<Node> {
    fn add(self, out: &mut Vec<&'a mut Node>) {
        out.push(self);
    }
}
impl<'a> Slot<'a, &'a Node> for &'a Option<Box<Node>> {
    fn add(self, out: &mut Vec<&'a Node>) {
        out.extend(self.as_deref());
    }
}
impl<'a> Slot<'a, &'a mut Node> for &'a mut Option<Box<Node>> {
    fn add(self, out: &mut Vec<&'a mut Node>) {
        out.extend(self.as_deref_mut());
    }
}
impl<'a> Slot<'a, &'a Node> for &'a Vec<Node> {
    fn add(self, out: &mut Vec<&'a Node>) {
        out.extend(self.iter());
    }
}
impl<'a> Slot<'a, &'a mut Node> for &'a mut Vec<Node> {
    fn add(self, out: &mut Vec<&'a mut Node>) {
        out.extend(self.iter_mut());
    }
}
impl<'a> Slot<'a, &'a Node> for &'a Vec<Option<Node>> {
    fn add(self, out: &mut Vec<&'a Node>) {
        out.extend(self.iter().flatten());
    }
}
impl<'a> Slot<'a, &'a mut Node> for &'a mut Vec<Option<Node>> {
    fn add(self, out: &mut Vec<&'a mut Node>) {
        out.extend(self.iter_mut().flatten());
    }
}
impl<'a> Slot<'a, &'a Node> for &'a Option<Vec<Node>> {
    fn add(self, out: &mut Vec<&'a Node>) {
        out.extend(self.iter().flatten());
    }
}
impl<'a> Slot<'a, &'a mut Node> for &'a mut Option<Vec<Node>> {
    fn add(self, out: &mut Vec<&'a mut Node>) {
        out.extend(self.iter_mut().flatten());
    }
}

/// Defines `$name(node) -> Vec<$out>` from the one child-order table.
macro_rules! child_fn {
    ($name:ident, $node_ty:ty, $out:ty) => {
        fn $name(node: $node_ty) -> Vec<$out> {
            let mut out: Vec<$out> = Vec::new();
            let Node {
                kind, decorators, ..
            } = node;
            match kind {
                // One arm per node kind, props in the parser's order. Kinds
                // with no child nodes share the last arm.
                NodeKind::Program { body } => Slot::add(body, &mut out),
                NodeKind::ImportDeclaration {
                    specifiers, source, ..
                } => {
                    Slot::add(specifiers, &mut out);
                    Slot::add(source, &mut out);
                }
                NodeKind::VariableDeclaration {
                    name,
                    type_annotation,
                    initializer,
                    ..
                }
                | NodeKind::StateDeclaration {
                    name,
                    type_annotation,
                    initializer,
                    ..
                } => {
                    Slot::add(name, &mut out);
                    Slot::add(type_annotation, &mut out);
                    Slot::add(initializer, &mut out);
                }
                NodeKind::FunctionDeclaration {
                    name,
                    params,
                    return_type,
                    body,
                    ..
                } => {
                    Slot::add(name, &mut out);
                    Slot::add(params, &mut out);
                    Slot::add(return_type, &mut out);
                    Slot::add(body, &mut out);
                }
                NodeKind::ComponentDeclaration {
                    name, params, body, ..
                } => {
                    Slot::add(name, &mut out);
                    Slot::add(params, &mut out);
                    Slot::add(body, &mut out);
                }
                NodeKind::NamespaceDeclaration { name, members, .. } => {
                    Slot::add(name, &mut out);
                    Slot::add(members, &mut out);
                }
                NodeKind::Parameter {
                    name,
                    type_annotation,
                    default_value,
                    ..
                } => {
                    Slot::add(name, &mut out);
                    Slot::add(type_annotation, &mut out);
                    Slot::add(default_value, &mut out);
                }
                NodeKind::BxElement {
                    attributes,
                    children,
                    ..
                } => {
                    Slot::add(attributes, &mut out);
                    Slot::add(children, &mut out);
                }
                NodeKind::BxFragment { children } => Slot::add(children, &mut out),
                NodeKind::BxAttribute { value, .. } => Slot::add(value, &mut out),
                NodeKind::BxSpreadAttribute { expression }
                | NodeKind::BxExpressionChild { expression } => Slot::add(expression, &mut out),
                NodeKind::BlockStatement { body } => Slot::add(body, &mut out),
                NodeKind::IfStatement {
                    test,
                    consequent,
                    alternate,
                } => {
                    Slot::add(test, &mut out);
                    Slot::add(consequent, &mut out);
                    Slot::add(alternate, &mut out);
                }
                NodeKind::ConditionalExpression {
                    test,
                    consequent,
                    alternate,
                } => {
                    Slot::add(test, &mut out);
                    Slot::add(consequent, &mut out);
                    Slot::add(alternate, &mut out);
                }
                NodeKind::WhileStatement { test, body } => {
                    Slot::add(test, &mut out);
                    Slot::add(body, &mut out);
                }
                NodeKind::ForStatement {
                    init,
                    test,
                    update,
                    body,
                } => {
                    Slot::add(init, &mut out);
                    Slot::add(test, &mut out);
                    Slot::add(update, &mut out);
                    Slot::add(body, &mut out);
                }
                NodeKind::ReturnStatement { argument } => Slot::add(argument, &mut out),
                NodeKind::ExpressionStatement { expression } => Slot::add(expression, &mut out),
                NodeKind::TemplateLiteral { parts } => Slot::add(parts, &mut out),
                NodeKind::TemplateField { expression, width } => {
                    Slot::add(expression, &mut out);
                    Slot::add(width, &mut out);
                }
                NodeKind::ArrayLiteral { elements } => Slot::add(elements, &mut out),
                NodeKind::RecordLiteral { properties } => Slot::add(properties, &mut out),
                NodeKind::RecordProperty { value, .. } => Slot::add(value, &mut out),
                NodeKind::AssignmentExpression { left, right, .. } => {
                    Slot::add(left, &mut out);
                    Slot::add(right, &mut out);
                }
                NodeKind::BinaryExpression { left, right, .. } => {
                    Slot::add(left, &mut out);
                    Slot::add(right, &mut out);
                }
                NodeKind::UnaryExpression { argument, .. }
                | NodeKind::UpdateExpression { argument, .. } => Slot::add(argument, &mut out),
                NodeKind::CallExpression { callee, args, .. } => {
                    Slot::add(callee, &mut out);
                    Slot::add(args, &mut out);
                }
                NodeKind::MemberExpression { object, property } => {
                    Slot::add(object, &mut out);
                    Slot::add(property, &mut out);
                }
                NodeKind::IndexExpression { object, index } => {
                    Slot::add(object, &mut out);
                    Slot::add(index, &mut out);
                }
                NodeKind::TypeReference { type_arguments, .. } => {
                    Slot::add(type_arguments, &mut out);
                }
                NodeKind::Decorator { args, .. } => Slot::add(args, &mut out),
                NodeKind::TestDecl { body, .. } => Slot::add(body, &mut out),
                NodeKind::BreakStatement {}
                | NodeKind::ContinueStatement {}
                | NodeKind::BxText { .. }
                | NodeKind::AsmBlock { .. }
                | NodeKind::Identifier { .. }
                | NodeKind::IntegerLiteral { .. }
                | NodeKind::DecimalLiteral { .. }
                | NodeKind::BooleanLiteral { .. }
                | NodeKind::StringLiteral { .. }
                | NodeKind::TemplateText { .. } => {}
            }
            // `decorators` is assigned after construction, so it comes last.
            Slot::add(decorators, &mut out);
            out
        }
    };
}

child_fn!(children_shared, &Node, &Node);
child_fn!(children_exclusive, &mut Node, &mut Node);

/// The children of `node` in the order the JS `walk` visits them.
#[must_use]
pub fn children(node: &Node) -> Vec<&Node> {
    children_shared(node)
}

/// The same children, exclusively borrowed.
#[must_use]
pub fn children_mut(node: &mut Node) -> Vec<&mut Node> {
    children_exclusive(node)
}

/// `walk(root, visit, parent)` (`ast/index.mjs:96-106`): parents before
/// children; the visitor gets the parent as an argument, never a link (R1.6).
pub fn walk<'a>(root: &'a Node, visit: &mut impl FnMut(&'a Node, Option<&'a Node>)) {
    walk_from(root, None, visit);
}

fn walk_from<'a>(
    node: &'a Node,
    parent: Option<&'a Node>,
    visit: &mut impl FnMut(&'a Node, Option<&'a Node>),
) {
    visit(node, parent);
    for child in children(node) {
        walk_from(child, Some(node), visit);
    }
}

/// Assigns `NodeId`s in pre-order (R1.5), starting at 0 for `root`. Returns
/// the next free id, for nodes made later.
pub fn number_nodes(root: &mut Node) -> u32 {
    let mut next = 0u32;
    number_from(root, &mut next);
    next
}

fn number_from(node: &mut Node, next: &mut u32) {
    node.id = NodeId(*next);
    *next = next.saturating_add(1);
    for child in children_mut(node) {
        number_from(child, next);
    }
}
