//! Port of packages/compiler/src/linker/index.mjs:260-322 (the facts a program tests) and
//! :383-562 (the const passes and the call and string checks).

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use fold::facts::{FACTS, fact_const_name};
use front::graph::LoadedGraph;
use indexmap::{IndexMap, IndexSet};
use jsnum::Nullable;
use mos_ir::{Call, Const, Expr, IrString, Param, StringLiteral};
use sema::types::resolve_integer_type;
use syntax::{Node, NodeKind};

use crate::imports::{MemberValue, Table, resolve_namespace_member};
use crate::rewrite::rewrite_expression;
use crate::scope::Scope;
use crate::{ConstValue, ModuleSide, Unported, file_of, ir_of, span, span_of};

const SYSTEM_PACKAGE: &str = "@8bitscript/system";

/// What a literal's `raw` holds, for the five literal kinds that carry one.
fn raw_of(node: &Node) -> Option<&str> {
    match &node.kind {
        NodeKind::IntegerLiteral { raw, .. }
        | NodeKind::DecimalLiteral { raw, .. }
        | NodeKind::BxText { raw, .. } => Some(raw),
        NodeKind::BooleanLiteral { raw, .. } | NodeKind::StringLiteral { raw, .. } => {
            raw.as_deref()
        }
        _ => None,
    }
}

/// `testedFacts`: the facts the program's own files test, by key, in `FACTS` order. A
/// `#fact(key)` a project module spells, and every `Video.COLUMNS`-style member of a namespace
/// imported from `@8bitscript/system`.
#[must_use]
pub fn tested_facts(graph: &LoadedGraph) -> Vec<String> {
    let by_const: IndexMap<String, &str> = FACTS
        .keys()
        .map(|key| {
            let name = fact_const_name(key);
            (format!("{}.{}", name.namespace, name.name), *key)
        })
        .collect();
    let mut keys: IndexSet<String> = IndexSet::new();
    for module in &graph.modules {
        let Some(ast) = module.ast.as_ref().filter(|_| module.own) else {
            continue;
        };
        // Local name to the `@8bitscript/system` namespace it names.
        let mut namespaces: IndexMap<String, String> = IndexMap::new();
        syntax::walk(ast, &mut |n, _| {
            if let NodeKind::ImportDeclaration {
                specifiers,
                source: Some(source),
                ..
            } = &n.kind
                && matches!(&source.kind, NodeKind::StringLiteral { value, .. } if value == SYSTEM_PACKAGE)
            {
                for spec in specifiers {
                    if let NodeKind::Identifier { name, imported, .. } = &spec.kind {
                        namespaces.insert(
                            name.clone(),
                            imported.clone().unwrap_or_else(|| name.clone()),
                        );
                    }
                }
            }
        });
        syntax::walk(ast, &mut |n, _| {
            if let Some(raw) = raw_of(n)
                && let Some(rest) = raw.strip_prefix("#fact(")
            {
                let end = rest
                    .chars()
                    .next_back()
                    .map_or(0, |c| rest.len() - c.len_utf8());
                keys.insert(rest[..end].to_string());
            }
            if let NodeKind::MemberExpression { object, property } = &n.kind
                && let (
                    NodeKind::Identifier { name, .. },
                    NodeKind::Identifier { name: member, .. },
                ) = (&object.kind, &property.kind)
                && let Some(ns) = namespaces.get(name)
                && let Some(key) = by_const.get(&format!("{ns}.{member}"))
            {
                keys.insert((*key).to_string());
            }
        });
    }
    FACTS
        .keys()
        .filter(|k| keys.contains(**k))
        .map(|k| (*k).to_string())
        .collect()
}

/// `constsOf`: this module's own top-level consts, name to value.
#[must_use]
pub fn consts_of(graph: &LoadedGraph, module: usize) -> IndexMap<String, ConstValue> {
    ir_of(graph, module)
        .consts
        .iter()
        .map(|c| {
            let value = if let Some(pending) = &c.pending {
                ConstValue::Pending {
                    pending: pending.clone(),
                    ty: c.ty.clone(),
                }
            } else if c.ty == "string" {
                ConstValue::String {
                    string: c.string.unwrap_or(0),
                }
            } else {
                match c.value {
                    Nullable::Value(v) => ConstValue::Number(v as f64),
                    Nullable::Absent | Nullable::Null => ConstValue::Number(0.0),
                }
            };
            (c.name.clone(), value)
        })
        .collect()
}

/// `constTypesOf`: this module's own top-level consts, name to declared type.
#[must_use]
pub fn const_types_of(graph: &LoadedGraph, module: usize) -> IndexMap<String, String> {
    ir_of(graph, module)
        .consts
        .iter()
        .map(|c| (c.name.clone(), c.ty.clone()))
        .collect()
}

/// The two maps `visibleConsts` returns.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Visible {
    pub values: IndexMap<String, ConstValue>,
    pub types: IndexMap<String, String>,
}

/// `visibleConsts`: the consts a module's references may inline: its own, plus every import that
/// names another module's const.
#[must_use]
pub fn visible_consts(sides: &[ModuleSide], module: usize, settled_only: bool) -> Visible {
    let usable = |v: &ConstValue| !(settled_only && v.is_pending());
    let side = &sides[module];
    let mut values: IndexMap<String, ConstValue> = side
        .own_consts
        .iter()
        .filter(|(_, v)| usable(v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let mut types = side.own_const_types.clone();
    if let Some(bindings) = &side.bindings {
        for (local, binding) in bindings {
            let other = &sides[binding.module];
            let Some(v) = other.own_consts.get(&binding.name) else {
                continue;
            };
            if !usable(v) {
                continue;
            }
            values.insert(local.clone(), v.clone());
            if let Some(t) = other.own_const_types.get(&binding.name) {
                types.insert(local.clone(), t.clone());
            }
        }
    }
    Visible { values, types }
}

/// One const the linker may still owe a value.
struct Slot {
    name: String,
    pending: Expr,
    ty: String,
    /// The namespace whose table holds the slot, or `None` for the module's own consts.
    namespace: Option<String>,
    key: String,
}

fn pending_of(side: &ModuleSide) -> Vec<Slot> {
    let mut slots = Vec::new();
    for (name, v) in &side.own_consts {
        if let ConstValue::Pending { pending, ty } = v {
            slots.push(Slot {
                name: name.clone(),
                pending: (**pending).clone(),
                ty: ty.clone(),
                namespace: None,
                key: name.clone(),
            });
        }
    }
    for ns in side.namespaces.values() {
        for (member, v) in &ns.consts {
            if let ConstValue::Pending { pending, ty } = v {
                slots.push(Slot {
                    name: format!("{}.{member}", ns.name),
                    pending: (**pending).clone(),
                    ty: ty.clone(),
                    namespace: Some(ns.name.clone()),
                    key: member.clone(),
                });
            }
        }
    }
    slots
}

fn settle(side: &mut ModuleSide, slot: &Slot, value: f64) {
    match &slot.namespace {
        Some(ns) => {
            if let Some(ns) = side.namespaces.get_mut(ns) {
                ns.consts
                    .insert(slot.key.clone(), ConstValue::Number(value));
            }
        }
        None => {
            side.own_consts
                .insert(slot.key.clone(), ConstValue::Number(value));
        }
    }
}

/// `resolvePendingConsts`: a const whose initializer only the linker can see gets its value here,
/// before any module inlines it. Repeats until nothing changes; what is still pending then is a
/// cycle, and is reported.
///
/// # Errors
/// [`Unported`], from `rewrite_expression`, once a pending initializer needs the rewrite pass.
pub fn resolve_pending_consts(
    graph: &LoadedGraph,
    sides: &mut [ModuleSide],
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(), Unported> {
    let scopes: Vec<Scope> = sides
        .iter()
        .map(|s| Scope::new(s.rename.clone().unwrap_or_default()))
        .collect();
    let mut progress = true;
    while progress {
        progress = false;
        for m in 0..sides.len() {
            let file = file_of(graph, m);
            for slot in pending_of(&sides[m]) {
                let mut expr = slot.pending.clone();
                if let Expr::Ref(r) = &expr {
                    // Own const first (a chain inside one module), then an import.
                    let binding = if sides[m].own_consts.contains_key(&r.name) {
                        Some((m, r.name.clone()))
                    } else {
                        sides[m]
                            .bindings
                            .as_ref()
                            .and_then(|b| b.get(&r.name))
                            .map(|b| (b.module, b.name.clone()))
                    };
                    let other = binding
                        .as_ref()
                        .and_then(|(bm, bn)| sides[*bm].own_consts.get(bn));
                    if other.is_some_and(ConstValue::is_pending) {
                        continue; // not yet; another pass
                    }
                    if other.is_none() {
                        let (code, message) = if binding.is_some() {
                            (
                                codes::NOT_COMPILABLE,
                                format!(
                                    "'{}' is not a const, so it cannot initialize a const",
                                    r.name
                                ),
                            )
                        } else {
                            (
                                codes::UNRESOLVED_NAME,
                                format!("cannot find name '{}'", r.name),
                            )
                        };
                        diagnostics.push(diagnostic(
                            code,
                            message,
                            file,
                            span(r.start),
                            span(r.length),
                            Severity::Error,
                        ));
                        settle(&mut sides[m], &slot, 0.0);
                        progress = true;
                        continue;
                    }
                } else if let Expr::NamespaceConst(nc) = &expr {
                    // A member still pending waits for another pass; a namespace or member that
                    // does not exist is left to the rewrite below, which reports it.
                    let result = resolve_namespace_member(
                        sides,
                        m,
                        &nc.namespace,
                        &nc.member,
                        Table::Consts,
                    );
                    if result.namespace_found
                        && result.member_found
                        && matches!(&result.value, Some(MemberValue::Const(v)) if v.is_pending())
                    {
                        continue;
                    }
                }
                // What a reference inlines from: the module's own resolved consts plus its
                // imports' values.
                let visible = visible_consts(sides, m, true);
                sides[m].const_values = visible.values;
                sides[m].const_types = visible.types;
                let value = resolve_initialiser(
                    &mut expr,
                    &slot.ty,
                    &scopes[m],
                    m,
                    sides,
                    graph,
                    diagnostics,
                )?;
                settle(&mut sides[m], &slot, value);
                progress = true;
            }
        }
    }
    for (m, side) in sides.iter_mut().enumerate() {
        let file = file_of(graph, m);
        for slot in pending_of(side) {
            let (start, length) = span_of(&slot.pending);
            diagnostics.push(diagnostic(
                codes::NOT_COMPILABLE,
                format!(
                    "'{}' is a const whose value depends on itself, through the consts it names",
                    slot.name
                ),
                file,
                span(start),
                span(length),
                Severity::Error,
            ));
            settle(side, &slot, 0.0);
        }
    }
    Ok(())
}

/// `resolveInitialiser`: a pending initializer as the number it stands for, range-checked against
/// the global's type. Anything else is reported and stands in as 0.
///
/// # Errors
/// [`Unported`], from `rewrite_expression`.
pub fn resolve_initialiser(
    expr: &mut Expr,
    g_type: &str,
    scope: &Scope,
    module: usize,
    sides: &mut [ModuleSide],
    graph: &LoadedGraph,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<f64, Unported> {
    let file = file_of(graph, module);
    // Before the rewrite the expression still has its own span.
    let (start, length) = span_of(expr);
    let at = |diagnostics: &mut Vec<Diagnostic>, code: &str, message: String| {
        diagnostics.push(diagnostic(
            code,
            message,
            file,
            span(start),
            span(length),
            Severity::Error,
        ));
    };
    if let Expr::Ref(r) = &*expr {
        match sides[module].const_values.get(&r.name) {
            Some(v) if v.is_object() => {
                at(
                    diagnostics,
                    codes::NOT_COMPILABLE,
                    format!(
                        "'{}' is a string const; it cannot initialize a {g_type}",
                        r.name
                    ),
                );
                return Ok(0.0);
            }
            None => {
                let (code, message) = if scope.has(&r.name) {
                    (
                        codes::NOT_COMPILABLE,
                        format!(
                            "'{}' is not a const, so it cannot initialize a global: an initializer is a literal or a const",
                            r.name
                        ),
                    )
                } else {
                    (
                        codes::UNRESOLVED_NAME,
                        format!("cannot find name '{}'", r.name),
                    )
                };
                at(diagnostics, code, message);
                return Ok(0.0);
            }
            Some(_) => {}
        }
    }
    let before = diagnostics.len();
    rewrite_expression(expr, scope, module, sides, graph, diagnostics)?;
    if diagnostics.len() > before {
        return Ok(0.0);
    }
    Ok(check_initialiser(expr, g_type, file, diagnostics))
}

/// The half of `resolveInitialiser` after the rewrite. JS reads `expr.start` when it reports, and
/// the rewrite drops the span of a const it inlines, so a report here is at 0 + 0 for a const and
/// at the expression's own span otherwise.
pub fn check_initialiser(
    expr: &Expr,
    g_type: &str,
    file: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> f64 {
    let (start, length) = span_of(expr);
    let mut at = |code: &str, message: String| {
        diagnostics.push(diagnostic(
            code,
            message,
            file,
            span(start),
            span(length),
            Severity::Error,
        ));
    };
    let Expr::Const(c) = expr else {
        at(
            codes::NOT_COMPILABLE,
            "an initializer is a literal or a const".to_string(),
        );
        return 0.0;
    };
    let range = if g_type == "bool" {
        Some((0, 1))
    } else {
        resolve_integer_type(g_type).map(|t| (t.min, t.max))
    };
    // JS throws on the bounds of a type that is not an integer type (R7.8, recorded).
    let Some((min, max)) = range else {
        return 0.0;
    };
    if c.value < min || c.value > max {
        at(
            codes::VALUE_OUT_OF_RANGE,
            format!("{} does not fit in {g_type} ({min}..{max})", c.value),
        );
        return 0.0;
    }
    c.value as f64
}

/// `constExpression`: a const's inlined value as an IR expression: a string slot, or a number
/// with the const's declared type. `None` for a pending value, which `resolve_pending_consts`
/// settles before any module inlines.
#[must_use]
pub fn const_expression(value: &ConstValue, ty: Option<&str>) -> Option<Expr> {
    match value {
        ConstValue::String { string } => Some(Expr::String(StringLiteral {
            index: *string,
            ty: Nullable::Absent,
            start: None,
            length: None,
        })),
        ConstValue::Number(v) => Some(Expr::Const(Const {
            value: *v as i64,
            ty: ty.map(str::to_string),
        })),
        ConstValue::Pending { .. } => None,
    }
}

/// `checkStringFits`: a string source checked against a `string<N>` target's capacity, for a
/// literal.
pub fn check_string_fits(
    source: &Expr,
    capacity: i64,
    strings: &[IrString],
    file: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let Expr::String(lit) = source else {
        return;
    };
    let Some(s) = usize::try_from(lit.index).ok().and_then(|i| strings.get(i)) else {
        return;
    };
    let n = i64::try_from(s.bytes.len()).unwrap_or(i64::MAX);
    if n > capacity {
        diagnostics.push(diagnostic(
            codes::STRING_TOO_LONG,
            format!(
                "\"{}\" is {n} characters and does not fit in string<{capacity}>",
                s.text
            ),
            file,
            span(lit.start),
            span(lit.length),
            Severity::Error,
        ));
    }
}

/// What `program.functionsByOutput` holds for one callee.
#[derive(Debug, Clone)]
pub struct Callee {
    pub params: Vec<Param>,
    pub return_type: String,
}

/// `completeCall`: the argument count checked against the parameters, and every argument left off
/// filled in from the parameter's default. `original` is the source name the JS call node may
/// carry as `original`; the IR `Call` has no such field.
pub fn complete_call(
    call: &mut Call,
    original: Option<&str>,
    callees: Option<&IndexMap<String, Callee>>,
    file: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let Some(func) = callees.and_then(|c| c.get(&call.name)) else {
        return;
    };
    let min = func.params.iter().filter(|p| p.default.is_none()).count();
    let max = func.params.len();
    if call.args.len() > max || call.args.len() < min {
        let takes = if min == max {
            format!("{max}")
        } else {
            format!("{min} to {max}")
        };
        diagnostics.push(diagnostic(
            codes::WRONG_ARGUMENT_COUNT,
            format!(
                "'{}' takes {takes} argument{}, not {}",
                original.unwrap_or(&call.name),
                if max == 1 { "" } else { "s" },
                call.args.len()
            ),
            file,
            span(call.start),
            span(call.length),
            Severity::Error,
        ));
        return;
    }
    for p in &func.params[call.args.len()..] {
        if let Some(d) = &p.default {
            call.args.push(d.clone());
        }
    }
    // An imported callee's return type is only knowable here.
    if matches!(call.ty, Nullable::Absent | Nullable::Null)
        && !func.return_type.is_empty()
        && func.return_type != "void"
    {
        call.ty = Nullable::Value(func.return_type.clone());
    }
}
