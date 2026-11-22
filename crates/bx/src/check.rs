//! Port of packages/compiler/src/bx/check.mjs:1-410
//!
//! Semantic checks for `.8bx` elements against component signatures from the binder.
//!
//! An element names a component declared in this module or imported from another. The
//! imported case is answered by the binder's cross-module step (`bindImportedComponents`);
//! when that step has not run, an imported name used as an element is valid but unknown and
//! nothing is reported for it.

use std::collections::HashSet;
use std::ptr;

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use jsnum::{Nullable, js_trim};
use sema::binder::component_of;
use sema::binder::types::{Bound, ModuleId, Prop, SymbolKind, SymbolRef};
use syntax::{Node, NodeKind, SourceKind, walk};

/// The options object of `checkBx` (`{ sourceKind = '.8bs', strict = true } = {}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckOptions {
    pub source_kind: SourceKind,
    pub strict: bool,
}

impl Default for CheckOptions {
    fn default() -> Self {
        Self {
            source_kind: SourceKind::Bs,
            strict: true,
        }
    }
}

fn error(
    code: &str,
    message: impl Into<String>,
    file: &str,
    start: u32,
    length: u32,
) -> Diagnostic {
    diagnostic(code, message, file, start, length, Severity::Error)
}

fn at(diagnostics: &mut Vec<Diagnostic>, code: &str, file: &str, n: &Node, message: String) {
    diagnostics.push(error(code, message, file, n.start, n.length));
}

/// `x?.name` on an optional node: the identifier's name, `None` for any other node.
fn name_of(n: Option<&Node>) -> Option<&str> {
    match n.map(|n| &n.kind) {
        Some(NodeKind::Identifier { name, .. }) => Some(name),
        _ => None,
    }
}

/// `${x?.name}`: the name, or JS's `undefined`.
fn name_text(n: Option<&Node>) -> &str {
    name_of(n).unwrap_or("undefined")
}

/// `ast?.body ?? []`.
fn program_body(ast: &Node) -> &[Node] {
    match &ast.kind {
        NodeKind::Program { body } => body,
        _ => &[],
    }
}

/// `block?.body ?? []`.
fn block_body(block: Option<&Node>) -> &[Node] {
    match block.map(|b| &b.kind) {
        Some(NodeKind::BlockStatement { body }) => body,
        _ => &[],
    }
}

fn is_element(n: Option<&Node>) -> bool {
    matches!(
        n.map(|n| &n.kind),
        Some(NodeKind::BxElement { .. } | NodeKind::BxFragment { .. })
    )
}

/// The element's text children, already normalized by the parser (§35), as one string.
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

struct Context<'a> {
    file: &'a str,
    bound: &'a Bound,
    /// Where `bound` sits in `modules`: the module half of every `SymbolRef` it names.
    module: ModuleId,
    modules: &'a [Bound],
    stack: &'a [String],
}

/// `checkBx(ast, file, symbols, { sourceKind, strict }, stack)`. `symbols` is `bound.symbols`;
/// an imported component's symbol is looked up in `modules` (`SymbolRef.module`).
///
/// `bound` must be an element of `modules` (the same value, not a copy): the binder names
/// symbols by module index, and a `bound` outside `modules` is a caller bug, so this panics.
#[must_use]
pub fn check_bx(
    ast: &Node,
    file: &str,
    bound: &Bound,
    modules: &[Bound],
    options: &CheckOptions,
    stack: &[String],
) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    diagnostics.extend(check_slots(ast, file));
    diagnostics.extend(check_state(ast, file));
    diagnostics.extend(check_methods(ast, file));
    if options.source_kind == SourceKind::Bx {
        diagnostics.extend(check_file_role(ast, file, options.strict));
    }

    let module = modules
        .iter()
        .position(|m| ptr::eq(m, bound))
        .expect("check_bx: `bound` must be an element of `modules`");
    let ctx = Context {
        file,
        bound,
        module: ModuleId(module as u32),
        modules,
        stack,
    };
    // Every element once: a child is checked by its parent's recursion, a top-level one and
    // one inside an expression by this walk.
    walk(ast, &mut |n, parent| {
        let nested = is_element(parent);
        if is_element(Some(n)) && !nested {
            check_element(&ctx, n, &mut diagnostics);
        }
    });
    diagnostics.extend(check_composition(ast, file));

    diagnostics
}

fn check_element(ctx: &Context, el: &Node, diagnostics: &mut Vec<Diagnostic>) {
    let file = ctx.file;
    let (name, attributes, children) = match &el.kind {
        NodeKind::BxFragment { children } => {
            for child in children {
                if is_element(Some(child)) {
                    check_element(ctx, child, diagnostics);
                }
            }
            return;
        }
        NodeKind::BxElement {
            name,
            attributes,
            children,
            ..
        } => (name, attributes, children),
        _ => return,
    };
    // The one intrinsic: where a component's children go. Its placement is checkSlots'
    // business; it is never a component.
    if name == "slot" {
        return;
    }
    let id = ctx.bound.symbols.get(name).copied();
    let named = id.and_then(|id| ctx.bound.symbol_table.get(id.0 as usize));
    let named_ref = id.map(|symbol| SymbolRef {
        module: ctx.module,
        symbol,
    });
    let Some(sym) = component_of(ctx.modules, named_ref).and_then(|r| {
        ctx.modules
            .get(r.module.0 as usize)?
            .symbol_table
            .get(r.symbol.0 as usize)
    }) else {
        // An import whose module was never looked at cannot be judged; an import that was
        // looked at and is not an exported component can.
        if let Some(named) = named
            && named.kind == SymbolKind::Import
            && named.resolved != Some(true)
        {
            return;
        }
        let message = match named {
            Some(named) if named.kind == SymbolKind::Import => {
                let source = match &named.source {
                    Nullable::Value(s) => s.as_str(),
                    Nullable::Null => "null",
                    Nullable::Absent => "undefined",
                };
                format!(
                    "'{name}' is imported from '{source}', which does not export a component by that name"
                )
            }
            _ => format!("unknown component '{name}'"),
        };
        diagnostics.push(error(
            codes::BX_UNKNOWN_COMPONENT,
            message,
            file,
            el.start,
            el.length,
        ));
        return;
    };
    if ctx.stack.iter().any(|s| s == name) {
        diagnostics.push(error(
            codes::BX_COMPONENT_RECURSION,
            format!("component '{name}' appears in its own tree"),
            file,
            el.start,
            el.length,
        ));
        return;
    }
    let text_child = bx_text_value(children);
    let has_element_children = children.iter().any(|c| match &c.kind {
        NodeKind::BxElement { .. } | NodeKind::BxFragment { .. } => true,
        NodeKind::BxExpressionChild { expression } => expression.is_some(),
        _ => false,
    });
    if has_element_children && sym.allows_children != Some(true) {
        diagnostics.push(error(
            codes::BX_CHILDREN_REJECTED,
            format!("component '{name}' does not accept element children"),
            file,
            el.start,
            el.length,
        ));
    }
    let props: &[Prop] = sym.props.as_deref().unwrap_or(&[]);
    let mut seen: HashSet<&str> = HashSet::new();
    for attr in attributes {
        let NodeKind::BxAttribute {
            name: attr_name, ..
        } = &attr.kind
        else {
            // BxSpreadAttribute
            continue;
        };
        if seen.contains(attr_name.as_str()) {
            diagnostics.push(error(
                codes::BX_DUPLICATE_PROP,
                format!("duplicate prop '{attr_name}' on <{name}>"),
                file,
                attr.start,
                attr.length,
            ));
        }
        seen.insert(attr_name);
        if !props.iter().any(|p| &p.name == attr_name) {
            diagnostics.push(error(
                codes::BX_UNKNOWN_PROP,
                format!("component '{name}' has no prop '{attr_name}'"),
                file,
                attr.start,
                attr.length,
            ));
        }
    }
    let children_prop = props.iter().any(|p| p.name == "children");
    if !text_child.is_empty() && children_prop {
        seen.insert("children");
    } else if !text_child.is_empty() && !children_prop {
        diagnostics.push(error(
            codes::BX_CHILDREN_REJECTED,
            format!("component '{name}' does not accept text children"),
            file,
            el.start,
            el.length,
        ));
    }
    for prop in props {
        if prop.name == "children" {
            if text_child.is_empty()
                && !has_element_children
                && !prop.optional
                && prop.default_value.is_none()
            {
                diagnostics.push(error(
                    codes::BX_MISSING_PROP,
                    format!("<{name}> is missing prop '{}'", prop.name),
                    file,
                    el.start,
                    el.length,
                ));
            }
            continue;
        }
        let has = seen.contains(prop.name.as_str())
            || attributes.iter().any(
                |a| matches!(&a.kind, NodeKind::BxAttribute { name: n, .. } if *n == prop.name),
            );
        if !has && !prop.optional && prop.default_value.is_none() {
            diagnostics.push(error(
                codes::BX_MISSING_PROP,
                format!("<{name}> is missing prop '{}'", prop.name),
                file,
                el.start,
                el.length,
            ));
        }
    }
    for child in children {
        if is_element(Some(child)) {
            check_element(ctx, child, diagnostics);
        }
    }
}

/// The node's children as `(key, child)` in the order of `syntax::children` (R1.9), for the one walk that needs the key
/// (`checkComposition`). A test keeps the two the same.
fn entries(n: &Node) -> Vec<(&'static str, &Node)> {
    fn one<'a>(
        out: &mut Vec<(&'static str, &'a Node)>,
        key: &'static str,
        v: &'a Option<Box<Node>>,
    ) {
        if let Some(c) = v.as_deref() {
            out.push((key, c));
        }
    }
    fn many<'a>(out: &mut Vec<(&'static str, &'a Node)>, key: &'static str, v: &'a [Node]) {
        out.extend(v.iter().map(|c| (key, c)));
    }
    let mut out = Vec::new();
    match &n.kind {
        NodeKind::Program { body } | NodeKind::BlockStatement { body } => {
            many(&mut out, "body", body)
        }
        NodeKind::ImportDeclaration {
            specifiers, source, ..
        } => {
            many(&mut out, "specifiers", specifiers);
            one(&mut out, "source", source);
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
            one(&mut out, "name", name);
            one(&mut out, "typeAnnotation", type_annotation);
            one(&mut out, "initializer", initializer);
        }
        NodeKind::FunctionDeclaration {
            name,
            params,
            return_type,
            body,
            ..
        } => {
            one(&mut out, "name", name);
            many(&mut out, "params", params);
            one(&mut out, "returnType", return_type);
            one(&mut out, "body", body);
        }
        NodeKind::ComponentDeclaration {
            name, params, body, ..
        } => {
            one(&mut out, "name", name);
            many(&mut out, "params", params);
            one(&mut out, "body", body);
        }
        NodeKind::NamespaceDeclaration { name, members, .. } => {
            one(&mut out, "name", name);
            out.extend(members.iter().flatten().map(|c| ("members", c)));
        }
        NodeKind::Parameter {
            name,
            type_annotation,
            default_value,
            ..
        } => {
            out.push(("name", &**name));
            one(&mut out, "typeAnnotation", type_annotation);
            one(&mut out, "defaultValue", default_value);
        }
        NodeKind::BxElement {
            attributes,
            children,
            ..
        } => {
            many(&mut out, "attributes", attributes);
            many(&mut out, "children", children);
        }
        NodeKind::BxFragment { children } => many(&mut out, "children", children),
        NodeKind::BxAttribute { value, .. } => one(&mut out, "value", value),
        NodeKind::BxSpreadAttribute { expression } | NodeKind::BxExpressionChild { expression } => {
            one(&mut out, "expression", expression);
        }
        NodeKind::IfStatement {
            test,
            consequent,
            alternate,
        } => {
            one(&mut out, "test", test);
            one(&mut out, "consequent", consequent);
            one(&mut out, "alternate", alternate);
        }
        NodeKind::ConditionalExpression {
            test,
            consequent,
            alternate,
        } => {
            out.push(("test", &**test));
            one(&mut out, "consequent", consequent);
            one(&mut out, "alternate", alternate);
        }
        NodeKind::WhileStatement { test, body } => {
            one(&mut out, "test", test);
            one(&mut out, "body", body);
        }
        NodeKind::ForStatement {
            init,
            test,
            update,
            body,
        } => {
            one(&mut out, "init", init);
            one(&mut out, "test", test);
            one(&mut out, "update", update);
            one(&mut out, "body", body);
        }
        NodeKind::ReturnStatement { argument } => one(&mut out, "argument", argument),
        NodeKind::ExpressionStatement { expression } => out.push(("expression", &**expression)),
        NodeKind::TemplateLiteral { parts } => many(&mut out, "parts", parts),
        NodeKind::TemplateField { expression, width } => {
            out.push(("expression", &**expression));
            one(&mut out, "width", width);
        }
        NodeKind::ArrayLiteral { elements } => many(&mut out, "elements", elements),
        NodeKind::RecordLiteral { properties } => many(&mut out, "properties", properties),
        NodeKind::RecordProperty { value, .. } => out.push(("value", &**value)),
        NodeKind::AssignmentExpression { left, right, .. } => {
            out.push(("left", &**left));
            one(&mut out, "right", right);
        }
        NodeKind::BinaryExpression { left, right, .. } => {
            out.push(("left", &**left));
            out.push(("right", &**right));
        }
        NodeKind::UnaryExpression { argument, .. }
        | NodeKind::UpdateExpression { argument, .. } => {
            out.push(("argument", &**argument));
        }
        NodeKind::CallExpression { callee, args, .. } => {
            out.push(("callee", &**callee));
            many(&mut out, "args", args);
        }
        NodeKind::MemberExpression { object, property } => {
            out.push(("object", &**object));
            out.push(("property", &**property));
        }
        NodeKind::IndexExpression { object, index } => {
            out.push(("object", &**object));
            one(&mut out, "index", index);
        }
        NodeKind::TypeReference { type_arguments, .. } => {
            many(&mut out, "typeArguments", type_arguments)
        }
        NodeKind::Decorator { args, .. } => many(&mut out, "args", args),
        NodeKind::TestDecl { body, .. } => out.push(("body", body)),
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
    if let Some(decorators) = &n.decorators {
        many(&mut out, "decorators", decorators);
    }
    out
}

/// Where an element may stand (spec §94): as a statement, as a child, or as an arm of `? :` /
/// the right of `&&` in one of those places. An element anywhere else is 8BS2024; a `{…}` child
/// that is not a composition is 8BS2023.
fn check_composition(ast: &Node, file: &str) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    visit_composition(&mut diagnostics, file, Some(ast), true);
    diagnostics
}

fn is_composition(n: Option<&Node>) -> bool {
    let Some(n) = n else { return false };
    match &n.kind {
        NodeKind::BxElement { .. } | NodeKind::BxFragment { .. } => true,
        NodeKind::ConditionalExpression {
            consequent,
            alternate,
            ..
        } => is_composition(consequent.as_deref()) && is_composition(alternate.as_deref()),
        NodeKind::BinaryExpression {
            operator, right, ..
        } if operator == "&&" => is_composition(Some(right)),
        _ => false,
    }
}

/// `composing` — the node is in a place a composition may stand — flows down only through the
/// arms of a composition-shaped expression.
fn visit_composition(
    diagnostics: &mut Vec<Diagnostic>,
    file: &str,
    n: Option<&Node>,
    composing: bool,
) {
    let Some(n) = n else { return };
    match &n.kind {
        NodeKind::BxElement {
            attributes,
            children,
            ..
        } => {
            visit_element(diagnostics, file, n, composing, attributes, children);
            return;
        }
        NodeKind::BxFragment { children } => {
            visit_element(diagnostics, file, n, composing, &[], children);
            return;
        }
        NodeKind::ConditionalExpression {
            test,
            consequent,
            alternate,
        } if composing && is_composition(Some(n)) => {
            visit_composition(diagnostics, file, Some(test), false);
            visit_composition(diagnostics, file, consequent.as_deref(), true);
            visit_composition(diagnostics, file, alternate.as_deref(), true);
            return;
        }
        NodeKind::BinaryExpression {
            operator,
            left,
            right,
        } if operator == "&&" && composing && is_composition(Some(n)) => {
            visit_composition(diagnostics, file, Some(left), false);
            visit_composition(diagnostics, file, Some(right), true);
            return;
        }
        // `return (<…/>)` composes where it stands (§96).
        NodeKind::ReturnStatement { argument } => {
            let flag = composing && is_composition(argument.as_deref());
            visit_composition(diagnostics, file, argument.as_deref(), flag);
            return;
        }
        _ => {}
    }
    let statement_body = matches!(
        n.kind,
        NodeKind::Program { .. }
            | NodeKind::BlockStatement { .. }
            | NodeKind::ComponentDeclaration { .. }
            | NodeKind::FunctionDeclaration { .. }
            | NodeKind::IfStatement { .. }
            | NodeKind::WhileStatement { .. }
            | NodeKind::ForStatement { .. }
    );
    for (key, child) in entries(n) {
        // A statement position: the body/consequent/alternate of a block-like node.
        // Everything else under a node is an expression position.
        let as_statement = statement_body && matches!(key, "body" | "consequent" | "alternate");
        visit_composition(diagnostics, file, Some(child), as_statement);
    }
}

fn visit_element(
    diagnostics: &mut Vec<Diagnostic>,
    file: &str,
    n: &Node,
    composing: bool,
    attributes: &[Node],
    children: &[Node],
) {
    if !composing {
        diagnostics.push(error(
            codes::BX_NOT_A_VALUE,
            "a composition is not a value: an element stands as a statement, a child, or an arm of ? : / && there",
            file,
            n.start,
            n.length,
        ));
    }
    for attr in attributes {
        if let NodeKind::BxAttribute { value, .. } = &attr.kind {
            visit_composition(diagnostics, file, value.as_deref(), false);
        }
    }
    for child in children {
        if let NodeKind::BxExpressionChild { expression } = &child.kind {
            let expression = expression.as_deref();
            if expression.is_some() && !is_composition(expression) {
                diagnostics.push(error(
                    codes::BX_EXPRESSION_CHILD,
                    "an expression between tags composes: {cond ? <A /> : <B />} or {cond && <A />}; a value there is not a child yet",
                    file,
                    child.start,
                    child.length,
                ));
                visit_composition(diagnostics, file, expression, false);
            } else {
                visit_composition(diagnostics, file, expression, true);
            }
        } else {
            visit_composition(diagnostics, file, Some(child), true);
        }
    }
}

fn is_slot(n: &Node) -> bool {
    matches!(&n.kind, NodeKind::BxElement { name, .. } if name == "slot")
}

/// `<slot />` is where a component's children elaborate (spec §33): exactly one, at the top
/// level of a component's body, and no local declared before it may be read after it.
/// Anywhere else, or any other way, is 8BS2019.
fn check_slots(ast: &Node, file: &str) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let mut top_level: Vec<&Node> = Vec::new();
    for stmt in program_body(ast) {
        let NodeKind::ComponentDeclaration { name, body, .. } = &stmt.kind else {
            continue;
        };
        let body = block_body(body.as_deref());
        let slots: Vec<&Node> = body.iter().filter(|n| is_slot(n)).collect();
        top_level.extend(slots.iter().copied());
        for extra in slots.iter().skip(1) {
            at(
                &mut diagnostics,
                codes::BX_INVALID_SLOT,
                file,
                extra,
                format!(
                    "component '{}' places <slot /> more than once; children go in one place",
                    name_text(name.as_deref())
                ),
            );
        }
        let Some(first) = slots.first() else { continue };
        let index = body.iter().position(|n| ptr::eq(n, *first)).unwrap_or(0);
        let NodeKind::BxElement {
            attributes,
            children,
            ..
        } = &first.kind
        else {
            continue;
        };
        if !attributes.is_empty() {
            at(
                &mut diagnostics,
                codes::BX_INVALID_SLOT,
                file,
                first,
                "<slot /> takes no attributes yet (named slots are a later milestone)".to_string(),
            );
        }
        if children.iter().any(|c| match &c.kind {
            NodeKind::BxText { value, .. } => !js_trim(value).is_empty(),
            _ => true,
        }) {
            at(
                &mut diagnostics,
                codes::BX_INVALID_SLOT,
                file,
                first,
                "<slot /> has no children of its own; it is where the element's children go"
                    .to_string(),
            );
        }
        // A local declared before the slot and read after it would live in a different
        // function from its reader.
        let mut before: HashSet<&str> = body[..index]
            .iter()
            .filter_map(|n| match &n.kind {
                NodeKind::VariableDeclaration { name, .. } => {
                    name_of(name.as_deref()).filter(|s| !s.is_empty())
                }
                _ => None,
            })
            .collect();
        if !before.is_empty() {
            for later in &body[index + 1..] {
                walk(later, &mut |n, _| {
                    if let NodeKind::Identifier { name, .. } = &n.kind
                        && before.contains(name.as_str())
                    {
                        at(
                            &mut diagnostics,
                            codes::BX_INVALID_SLOT,
                            file,
                            n,
                            format!(
                                "'{name}' is declared before <slot /> and used after it; a local cannot cross the slot"
                            ),
                        );
                        before.remove(name.as_str());
                    }
                });
            }
        }
    }
    // Every other <slot /> — nested in control flow inside a component, or anywhere outside
    // one — is out of place.
    walk(ast, &mut |n, _| {
        if is_slot(n) && !top_level.iter().any(|t| ptr::eq(*t, n)) {
            at(
                &mut diagnostics,
                codes::BX_INVALID_SLOT,
                file,
                n,
                "<slot /> belongs at the top level of a component's body, once".to_string(),
            );
        }
    });
    diagnostics
}

/// `.8bs` is code, `.8bx` is composition (spec §2.6). Tier A, always: `asm6502` has no place in
/// an `.8bx` file (8BS2020). Tier B, unless `bx: { strict: false }`: a top-level function whose
/// body holds no element, or a top-level `let`, belongs in an `.8bs` module (8BS2021, a warning).
fn check_file_role(ast: &Node, file: &str, strict: bool) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    walk(ast, &mut |n, _| {
        if matches!(n.kind, NodeKind::AsmBlock { .. }) {
            diagnostics.push(error(
                codes::BX_ASM_IN_BX,
                "asm6502 has no place in an .8bx file; put it in a .8bs function and import it",
                file,
                n.start,
                n.length,
            ));
        }
    });
    if !strict {
        return diagnostics;
    }
    for stmt in program_body(ast) {
        // A declaration whose name the parser could not read has nothing to name here.
        let (name_node, is_function) = match &stmt.kind {
            NodeKind::FunctionDeclaration { name, .. } => (name.as_deref(), true),
            NodeKind::VariableDeclaration { name, kind, .. } if kind == "let" => {
                (name.as_deref(), false)
            }
            _ => continue,
        };
        let Some(name) = name_of(name_node).filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(name_node) = name_node else { continue };
        if is_function {
            if !has_element(stmt) {
                diagnostics.push(diagnostic(
                    codes::BX_ORDINARY_CODE,
                    format!(
                        "'{name}' composes nothing: this is ordinary 8BitScript; move it to an .8bs module and import it (or set bx.strict: false)"
                    ),
                    file,
                    name_node.start,
                    name_node.length,
                    Severity::Warning,
                ));
            }
        } else {
            diagnostics.push(diagnostic(
                codes::BX_ORDINARY_CODE,
                format!(
                    "'{name}' is a variable at the top of an .8bx file; state belongs in a component, or in an .8bs module this one imports (or set bx.strict: false)"
                ),
                file,
                name_node.start,
                name_node.length,
                Severity::Warning,
            ));
        }
    }
    diagnostics
}

/// Whether any element or fragment sits anywhere under `node`.
fn has_element(node: &Node) -> bool {
    let mut found = false;
    walk(node, &mut |n, _| {
        if is_element(Some(n)) {
            found = true;
        }
    });
    found
}

/// `state name: type = init;` is per-instance storage (spec §36–§37): one declaration per name,
/// at the top level of a component's body, with a type, and not shadowed by a local or
/// parameter of the same name. Anywhere else, `state` means nothing: 8BS2022.
fn check_state(ast: &Node, file: &str) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let is_state = |n: &Node| matches!(n.kind, NodeKind::StateDeclaration { .. });
    let mut top_level: Vec<&Node> = Vec::new();
    for stmt in program_body(ast) {
        let NodeKind::ComponentDeclaration {
            name: component,
            params,
            body,
            ..
        } = &stmt.kind
        else {
            continue;
        };
        let component = name_text(component.as_deref());
        let body_node = body.as_deref();
        let names: HashSet<&str> = params
            .iter()
            .filter_map(|p| match &p.kind {
                NodeKind::Parameter { name, .. } => name_of(Some(&**name)),
                _ => None,
            })
            .collect();
        let mut fields: HashSet<&str> = HashSet::new();
        for s in block_body(body_node) {
            let NodeKind::StateDeclaration {
                name,
                type_annotation,
                ..
            } = &s.kind
            else {
                continue;
            };
            top_level.push(s);
            let Some(name_node) = name.as_deref() else {
                continue;
            };
            let Some(name) = name_of(Some(name_node)).filter(|s| !s.is_empty()) else {
                continue;
            };
            if type_annotation.is_none() {
                at(
                    &mut diagnostics,
                    codes::BX_INVALID_STATE,
                    file,
                    name_node,
                    format!("state '{name}' needs a type: it is storage the compiler lays out"),
                );
            }
            if names.contains(name) {
                at(
                    &mut diagnostics,
                    codes::BX_INVALID_STATE,
                    file,
                    name_node,
                    format!("state '{name}' has the same name as a prop of '{component}'"),
                );
            }
            if fields.contains(name) {
                at(
                    &mut diagnostics,
                    codes::BX_INVALID_STATE,
                    file,
                    name_node,
                    format!("state '{name}' is declared twice in '{component}'"),
                );
            }
            fields.insert(name);
        }
        if fields.is_empty() {
            continue;
        }
        // A local that shadows a field would be rewritten with it.
        if let Some(body_node) = body_node {
            walk(body_node, &mut |n, _| {
                if let NodeKind::VariableDeclaration { name, .. } = &n.kind
                    && let Some(name_node) = name.as_deref()
                    && let Some(local) = name_of(Some(name_node)).filter(|s| fields.contains(*s))
                {
                    at(
                        &mut diagnostics,
                        codes::BX_INVALID_STATE,
                        file,
                        name_node,
                        format!(
                            "'{local}' is state of '{component}'; a local cannot take its name"
                        ),
                    );
                }
            });
        }
    }
    walk(ast, &mut |n, _| {
        if is_state(n) && !top_level.iter().any(|t| ptr::eq(*t, n)) {
            at(
                &mut diagnostics,
                codes::BX_INVALID_STATE,
                file,
                n,
                "state belongs at the top level of a component's body".to_string(),
            );
        }
    });
    diagnostics
}

/// A method (spec §39) is a function declared at the top level of a component's body. It sees
/// the component's state, not its props, so a method that names a prop (and does not declare
/// its own parameter or local of that name) is 8BS2025. A method may not take a state field's
/// or another method's name either; those are one namespace.
fn check_methods(ast: &Node, file: &str) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    for (stmt, body, component) in components_of(ast) {
        let NodeKind::ComponentDeclaration { params, .. } = &stmt.kind else {
            continue;
        };
        let props = names_of(params.iter());
        let fields = names_of(
            body.iter()
                .copied()
                .filter(|s| matches!(s.kind, NodeKind::StateDeclaration { .. })),
        );
        let mut seen: HashSet<&str> = HashSet::new();
        for m in body {
            let NodeKind::FunctionDeclaration {
                name,
                params,
                body: method_body,
                ..
            } = &m.kind
            else {
                continue;
            };
            let Some(name_node) = name.as_deref() else {
                continue;
            };
            let name = name_text(Some(name_node));
            if props.contains(name) || fields.contains(name) {
                at(
                    &mut diagnostics,
                    codes::BX_INVALID_METHOD,
                    file,
                    name_node,
                    format!("method '{name}' takes the name of a prop or state of '{component}'"),
                );
            }
            if seen.contains(name) {
                at(
                    &mut diagnostics,
                    codes::BX_INVALID_METHOD,
                    file,
                    name_node,
                    format!("method '{name}' is declared twice in '{component}'"),
                );
            }
            seen.insert(name);
            // Names the method declares for itself shadow the component's props.
            let mut own = names_of(params.iter());
            if let Some(method_body) = method_body.as_deref() {
                walk(method_body, &mut |n, _| {
                    if let NodeKind::VariableDeclaration { name: Some(d), .. } = &n.kind
                        && let NodeKind::Identifier { name, .. } = &d.kind
                    {
                        own.insert(name);
                    }
                });
                walk(method_body, &mut |n, parent| {
                    let NodeKind::Identifier { name, .. } = &n.kind else {
                        return;
                    };
                    if !props.contains(name.as_str()) || own.contains(name.as_str()) {
                        return;
                    }
                    let is_property = parent.is_some_and(|p| {
                        matches!(&p.kind, NodeKind::MemberExpression { property, .. } if ptr::eq(&**property, n))
                    });
                    let declares = parent.is_some_and(|p| {
                        matches!(&p.kind, NodeKind::VariableDeclaration { name: Some(d), .. } if ptr::eq(&**d, n))
                    });
                    if !is_property && !declares {
                        at(
                            &mut diagnostics,
                            codes::BX_INVALID_METHOD,
                            file,
                            n,
                            format!(
                                "'{name}' is a prop of '{component}'; a method sees state, not props — pass it as an argument"
                            ),
                        );
                    }
                });
            }
        }
    }
    diagnostics
}

/// Every component declaration in a program, with its body's statements and its name.
fn components_of(ast: &Node) -> Vec<(&Node, Vec<&Node>, &str)> {
    program_body(ast)
        .iter()
        .filter_map(|stmt| match &stmt.kind {
            NodeKind::ComponentDeclaration { name, body, .. } => Some((
                stmt,
                block_body(body.as_deref()).iter().collect(),
                name_of(name.as_deref()).unwrap_or(""),
            )),
            _ => None,
        })
        .collect()
}

/// The names of a list of named nodes (parameters, declarations), skipping the unnamed.
fn names_of<'a>(nodes: impl Iterator<Item = &'a Node>) -> HashSet<&'a str> {
    nodes
        .filter_map(|n| match &n.kind {
            NodeKind::Parameter { name, .. } => name_of(Some(&**name)),
            NodeKind::StateDeclaration { name, .. }
            | NodeKind::VariableDeclaration { name, .. } => name_of(name.as_deref()),
            _ => None,
        })
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tap::check_bx::decode_args;
    use serde_json::Value;

    /// The keyed table and `syntax::children` list the same nodes in the same order, for every
    /// node of every AST in the fixture.
    #[test]
    fn entries_follow_syntax_children() {
        let rows: Vec<Value> =
            serde_json::from_str(include_str!("../tests/fixtures/bx-check.json")).unwrap();
        let mut nodes = 0;
        for row in &rows {
            let args = row["args"].as_array().unwrap();
            let decoded = decode_args(args).unwrap();
            syntax::walk(&decoded.ast, &mut |node, _| {
                let keyed: Vec<*const Node> = entries(node)
                    .iter()
                    .map(|(_, c)| *c as *const Node)
                    .collect();
                let listed: Vec<*const Node> = syntax::children(node)
                    .into_iter()
                    .map(|c| c as *const Node)
                    .collect();
                assert_eq!(keyed, listed, "children of the node at {}", node.start);
                nodes += 1;
            });
        }
        assert!(nodes > 1000, "{nodes} nodes");
    }
}
