//! Port of packages/compiler/src/linker/index.mjs:370-382, :606-608 and :613-682: the
//! declarations a module makes, the binding of its imports to them, namespace member lookup and
//! output names.

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use front::graph::LoadedGraph;
use indexmap::{IndexMap, IndexSet};
use mos_ir::Expr;

use crate::rewrite::rewrite_expression;
use crate::scope::{Scope, global_named, is_imported_name};
use crate::{Binding, ConstValue, ModuleSide, Namespace, Unported, file_of, ir_of, span, span_of};
use lower::module::ConstMember;

/// `declarationsOf`: every top-level name a module declares, mapped to whether it is exported.
#[must_use]
pub fn declarations_of(graph: &LoadedGraph, module: usize) -> IndexMap<String, bool> {
    let ir = ir_of(graph, module);
    let mut decls = IndexMap::new();
    for g in &ir.globals {
        decls.insert(g.name.clone(), g.exported);
    }
    for f in &ir.functions {
        decls.insert(f.name.clone(), f.exported);
    }
    for c in &ir.consts {
        decls.insert(c.name.clone(), c.exported);
    }
    decls
}

/// `globalsOf`: this module's own globals, by original name, as indices into `ir.globals`.
#[must_use]
pub fn globals_of(graph: &LoadedGraph, module: usize) -> IndexMap<String, usize> {
    ir_of(graph, module)
        .globals
        .iter()
        .enumerate()
        .map(|(i, g)| (g.name.clone(), i))
        .collect()
}

fn member_value(member: &ConstMember) -> ConstValue {
    match member {
        ConstMember::Value(v) => ConstValue::Number(*v as f64),
        ConstMember::String { string } => ConstValue::String { string: *string },
        ConstMember::Pending { pending, ty } => ConstValue::Pending {
            pending: pending.clone(),
            ty: ty.clone(),
        },
    }
}

/// `namespacesOf`: this module's own namespace declarations, keyed by namespace name.
#[must_use]
pub fn namespaces_of(graph: &LoadedGraph, module: usize) -> IndexMap<String, Namespace> {
    ir_of(graph, module)
        .namespaces
        .iter()
        .map(|ns| {
            (
                ns.name.clone(),
                Namespace {
                    name: ns.name.clone(),
                    exported: ns.exported,
                    functions: ns.functions.clone(),
                    consts: ns
                        .consts
                        .iter()
                        .map(|(k, v)| (k.clone(), member_value(v)))
                        .collect(),
                    const_types: ns.const_types.clone(),
                    start: ns.start,
                    length: ns.length,
                },
            )
        })
        .collect()
}

/// `bindImports`: every imported name must be exported by the module its specifier resolved to,
/// and must not collide with a declaration or another import in the importing module. A namespace
/// import binds separately from a value or function import.
pub fn bind_imports(
    graph: &LoadedGraph,
    sides: &mut [ModuleSide],
    diagnostics: &mut Vec<Diagnostic>,
) {
    for (m, side) in sides.iter_mut().enumerate() {
        side.decls = declarations_of(graph, m);
        side.globals_by_name = globals_of(graph, m);
        side.namespaces = namespaces_of(graph, m);
        side.own_consts = crate::consts::consts_of(graph, m);
        side.own_const_types = crate::consts::const_types_of(graph, m);
        side.bindings = Some(IndexMap::new());
        side.namespace_bindings = Some(IndexMap::new());
    }
    for m in 0..sides.len() {
        let file = file_of(graph, m);
        for (i, imp) in ir_of(graph, m).imports.iter().enumerate() {
            // Resolution already failed and was reported.
            let Some(target) = graph.import_modules.get(m).and_then(|v| v.get(i)).copied().flatten()
            else {
                continue;
            };
            for spec in &imp.specifiers {
                let at = |code: &str, message: String| {
                    diagnostic(
                        code,
                        message,
                        file,
                        span(Some(spec.start)),
                        span(Some(spec.length)),
                        Severity::Error,
                    )
                };
                let side = &sides[m];
                if side.decls.contains_key(&spec.local)
                    || side.bindings.as_ref().is_some_and(|b| b.contains_key(&spec.local))
                    || side
                        .namespace_bindings
                        .as_ref()
                        .is_some_and(|b| b.contains_key(&spec.local))
                {
                    diagnostics.push(at(
                        codes::DUPLICATE_BINDING,
                        format!("'{}' is already bound in this module", spec.local),
                    ));
                    continue;
                }
                let imported_exported = sides[target]
                    .namespaces
                    .get(&spec.imported)
                    .is_some_and(|ns| ns.exported);
                let binding = Binding {
                    module: target,
                    name: spec.imported.clone(),
                };
                if imported_exported {
                    sides[m]
                        .namespace_bindings
                        .get_or_insert_with(IndexMap::new)
                        .insert(spec.local.clone(), binding);
                    continue;
                }
                if sides[target].decls.get(&spec.imported) != Some(&true) {
                    diagnostics.push(at(
                        codes::NO_SUCH_EXPORT,
                        format!("'{}' is not pub in '{}'", spec.imported, imp.source),
                    ));
                    continue;
                }
                sides[m]
                    .bindings
                    .get_or_insert_with(IndexMap::new)
                    .insert(spec.local.clone(), binding);
            }
        }
    }
}

/// Which of a namespace's two member tables `resolveNamespaceMember` reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Table {
    Functions,
    Consts,
}

/// A member of a namespace table: a mangled function name or a const value.
#[derive(Debug, Clone, PartialEq)]
pub enum MemberValue {
    Function(String),
    Const(ConstValue),
}

/// What `resolveNamespaceMember` returns. When `namespace_found` is false the rest is unset.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NamespaceMember {
    pub namespace_found: bool,
    pub member_found: bool,
    pub value: Option<MemberValue>,
    pub ty: Option<String>,
    pub target_module: Option<usize>,
}

fn lookup(ns: &Namespace, member: &str, table: Table, target: usize) -> NamespaceMember {
    let value = match table {
        Table::Functions => ns.functions.get(member).cloned().map(MemberValue::Function),
        Table::Consts => ns.consts.get(member).cloned().map(MemberValue::Const),
    };
    NamespaceMember {
        namespace_found: true,
        member_found: value.is_some(),
        value,
        ty: ns.const_types.get(member).cloned(),
        target_module: Some(target),
    }
}

/// `resolveNamespaceMember`: `namespace.member` against a module's own namespace declarations or,
/// failing that, its namespace imports.
#[must_use]
pub fn resolve_namespace_member(
    sides: &[ModuleSide],
    module: usize,
    namespace_name: &str,
    member_name: &str,
    table: Table,
) -> NamespaceMember {
    if let Some(own) = sides[module].namespaces.get(namespace_name) {
        return lookup(own, member_name, table, module);
    }
    let Some(binding) = sides[module]
        .namespace_bindings
        .as_ref()
        .and_then(|b| b.get(namespace_name))
    else {
        return NamespaceMember::default();
    };
    match sides[binding.module].namespaces.get(&binding.name) {
        Some(target) => lookup(target, member_name, table, binding.module),
        None => NamespaceMember::default(),
    }
}

/// `assignOutputNames`: give every declaration its output name. First come keeps the source name,
/// the entry module comes first; later modules take `name_2`, `name_3`, ... on collision.
pub fn assign_output_names(sides: &mut [ModuleSide]) {
    let mut taken: IndexSet<String> = IndexSet::new();
    for side in sides.iter_mut() {
        let mut rename = IndexMap::new();
        for name in side.decls.keys() {
            // A const has no output at all: it is inlined wherever it is read.
            if side.own_consts.contains_key(name) {
                continue;
            }
            let mut out = name.clone();
            let mut n = 2;
            while taken.contains(&out) {
                out = format!("{name}_{n}");
                n += 1;
            }
            taken.insert(out.clone());
            rename.insert(name.clone(), out);
        }
        side.rename = Some(rename);
    }
}

/// `rewriteArrayAccess`: resolve the array an `index` or `storeIndex` node names: rename its
/// `ref`, fill in the element type lowering could not see, and check what only this layer can.
/// Only an imported array is examined here.
///
/// # Errors
/// [`Unported`], from `rewrite_expression`.
#[allow(clippy::too_many_arguments)]
pub fn rewrite_array_access(
    array: &mut Expr,
    index: &mut Expr,
    element_type: &mut Option<String>,
    scope: &Scope,
    module: usize,
    sides: &mut [ModuleSide],
    graph: &LoadedGraph,
    diagnostics: &mut Vec<Diagnostic>,
    store: bool,
) -> Result<(), Unported> {
    let name = match array {
        Expr::Ref(r) => r.name.clone(),
        _ => String::new(),
    };
    let imported = is_imported_name(sides, module, scope, &name);
    rewrite_expression(array, scope, module, sides, graph, diagnostics)?;
    rewrite_expression(index, scope, module, sides, graph, diagnostics)?;
    if !imported || !matches!(array, Expr::Ref(_)) {
        return Ok(());
    }
    let (start, length) = span_of(array);
    let file = file_of(graph, module);
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
    let Some(g) = global_named(graph, sides, module, &name).filter(|g| g.array.unwrap_or(0) != 0)
    else {
        at(
            codes::NOT_COMPILABLE,
            format!(
                "'{name}' is not an array: {} needs an array<T, N>",
                if store { "assigning to an element" } else { "indexing" }
            ),
        );
        return Ok(());
    };
    let len = g.array.unwrap_or(0);
    *element_type = Some(g.ty.clone());
    if store && g.constant == Some(true) {
        at(
            codes::ASSIGN_TO_CONST,
            format!("'{name}' is a const array — data in the program, not RAM — and cannot be assigned to"),
        );
    }
    if let Expr::Const(c) = index {
        if c.value < 0 || c.value >= len {
            at(
                codes::INDEX_OUT_OF_RANGE,
                format!(
                    "index {} is outside an array<{}, {len}>: elements are 0..{}",
                    c.value,
                    g.ty,
                    len - 1
                ),
            );
        }
    }
    Ok(())
}
