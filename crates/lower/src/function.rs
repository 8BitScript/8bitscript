//! Port of packages/compiler/src/ir/index.mjs:799-899 and 1564-1588 (`lower::function`,
//! `lower`, `entryOf`)
//!
//! A function declaration as an IR function, `lower()` over a whole module, and the entry
//! function of a lowered module.

use diagnostics::Diagnostic;
use indexmap::{IndexMap, IndexSet};
use jsnum::Nullable;
use mos_ir::{Function, Param, StateField};
use sema::templates::{parameter_types, resolve_array_type, resolve_scalar_type};
use syntax::{Node, NodeKind};

use crate::module::{ArrayDesc, Lowering, ModuleIr, int, name_of};

impl Lowering {
    /// `function(node, { mangledName })`: lower one function declaration and add it to
    /// `functions`. A refusal reports and adds nothing.
    #[allow(clippy::too_many_lines)]
    pub fn function(&mut self, node: &Node, mangled_name: Option<&str>) {
        let NodeKind::FunctionDeclaration {
            name,
            params: param_nodes,
            return_type,
            body,
            exported,
            component,
            owner,
            method,
            state,
        } = &node.kind
        else {
            return;
        };
        let mut params: Vec<Param> = Vec::new();
        for p in param_nodes {
            let NodeKind::Parameter {
                name: p_name,
                type_annotation,
                default_value,
                ..
            } = &p.kind
            else {
                continue;
            };
            let p_name = name_of(p_name).unwrap_or_default().to_string();
            let type_name = type_annotation.as_deref().and_then(name_of);
            // `t: array<utinyint, 4>`: the array itself, passed by reference. The length is part
            // of the type, so `t.length` is a constant inside the callee.
            if type_name == Some("array") {
                let resolved =
                    match resolve_array_type(type_annotation.as_deref(), &self.own_consts) {
                        Ok(r) => r,
                        Err(error) => {
                            if let Some(annotation) = type_annotation.as_deref() {
                                self.report(annotation, error);
                            }
                            return;
                        }
                    };
                if default_value.is_some() {
                    self.report(
                        p,
                        "an array parameter has no default: an array is passed, never filled in",
                    );
                    return;
                }
                if params.iter().any(|q| q.default.is_some()) {
                    self.report(
                        p,
                        format!(
                            "'{p_name}' needs a default: every parameter after one with a default has one"
                        ),
                    );
                    return;
                }
                params.push(Param {
                    name: p_name,
                    ty: "array".to_string(),
                    default: None,
                    element_type: Some(resolved.type_.to_string()),
                    length: Some(int(resolved.length)),
                });
                continue;
            }
            let ty = type_name
                .filter(|t| !t.is_empty())
                .and_then(|t| resolve_scalar_type(t, false, true));
            let Some(ty) = ty.filter(|t| *t != "void") else {
                self.report(
                    p,
                    format!(
                        "a parameter of type {} is not compilable yet",
                        type_name.unwrap_or("(none)")
                    ),
                );
                return;
            };
            let mut param = Param {
                name: p_name.clone(),
                ty: ty.to_string(),
                default: None,
                element_type: None,
                length: None,
            };
            // A default is a compile-time value, filled in at each call that leaves the argument
            // off. Once one parameter has a default, the rest must too.
            if default_value.is_some() {
                let Some(value) = self.parameter_default(p, ty) else {
                    return;
                };
                param.default = Some(value);
            } else if params.iter().any(|q| q.default.is_some()) {
                self.report(
                    p,
                    format!(
                        "'{p_name}' needs a default: every parameter after one with a default has one"
                    ),
                );
                return;
            }
            params.push(param);
        }

        let return_type_name = return_type.as_deref().and_then(name_of).unwrap_or("void");
        let Some(return_type) = resolve_scalar_type(return_type_name, true, false) else {
            self.report(
                node,
                format!("a return type of {return_type_name} is not compilable yet"),
            );
            return;
        };

        // Threaded through statement lowering so a `return` deep inside an `if`/`while` is
        // checked against the function it belongs to.
        let outer_return_type = self.current_return_type.replace(return_type.to_string());
        let outer_params = std::mem::replace(&mut self.current_params, parameter_types(node));
        // Array parameters are kept apart from the scalar ones: what the body needs from them
        // is the element type and the length.
        let array_params: IndexMap<String, ArrayDesc> = params
            .iter()
            .filter(|q| q.ty == "array")
            .map(|q| {
                (
                    q.name.clone(),
                    ArrayDesc {
                        ty: q.element_type.clone().unwrap_or_default(),
                        length: q.length.map_or(0.0, |l| l as f64),
                        constant: false,
                    },
                )
            })
            .collect();
        let outer_array_params = std::mem::replace(&mut self.current_array_params, array_params);
        // A parameter is declared in the body's block: `let x` over a parameter x is a
        // redeclaration, as it is in C.
        let block_names: IndexSet<String> = self
            .current_params
            .keys()
            .chain(self.current_array_params.keys())
            .cloned()
            .collect();
        let outer_block = self.block_names.replace(block_names);
        let body = self.function_body(body.as_deref());
        self.block_names = outer_block;
        self.current_return_type = outer_return_type;
        self.current_params = outer_params;
        self.current_array_params = outer_array_params;

        let mangled = mangled_name.filter(|m| !m.is_empty());
        // The name's span, so the linker's entry-export rule can point at it.
        let (start, length) = name
            .as_deref()
            .map_or((node.start, node.length), |n| (n.start, n.length));
        self.functions.push(Function {
            name: mangled
                .map(str::to_string)
                .or_else(|| name.as_deref().and_then(name_of).map(str::to_string))
                .unwrap_or_else(|| "anonymous".to_string()),
            // A namespace member is only ever reached through the namespace; its mangled name
            // is never itself an exportable top-level binding.
            exported: if mangled.is_some() { false } else { *exported },
            // An 8BX component, elaborated to this function.
            component: Some(*component == Some(true)),
            // The template globals a stateful component's body reads and writes, per field.
            state: state.as_ref().map(|fields| {
                fields
                    .iter()
                    .map(|f| StateField {
                        field: f.field.clone(),
                        global: f.global.clone(),
                    })
                    .collect()
            }),
            // Which component a function is part of, so an instance's methods are instanced
            // with it.
            owner: owner.clone().map_or(Nullable::Null, Nullable::Value),
            method: Some(*method == Some(true)),
            media_bind: None,
            params,
            return_type: return_type.to_string(),
            body,
            start: i64::from(start),
            length: i64::from(length),
            file: None,
        });
    }
}

/// What `lower()` returns: the module's IR and what was reported.
#[derive(Debug, Clone, PartialEq)]
pub struct Lowered {
    pub ir: ModuleIr,
    pub diagnostics: Vec<Diagnostic>,
    /// Set when a namespace member `VariableDeclaration` had no name (JS reports or throws).
    pub skipped_unnamed_member: bool,
}

/// Lower a parsed program to IR (`lower(ast, file, source)`).
#[must_use]
pub fn lower(ast: &Node, file: &str, source: Option<&str>) -> Lowered {
    let mut lowering = Lowering::new(file);
    lowering.source = source.map(str::to_string);
    let ir = lowering.program(ast);
    Lowered {
        ir,
        diagnostics: lowering.diagnostics,
        skipped_unnamed_member: lowering.skipped_unnamed_member,
    }
}

/// The program's entry function, by output name, or `None` when the IR has none.
///
/// Linked IR records it as `ir.entry`. IR straight from [`lower`] has no linker to have decided,
/// so the same rule is applied here: the sole exported function, if there is exactly one.
#[must_use]
pub fn entry_of(entry: Option<&str>, functions: &[Function]) -> Option<String> {
    if let Some(entry) = entry.filter(|e| !e.is_empty()) {
        return Some(entry.to_string());
    }
    let mut exported = functions.iter().filter(|f| f.exported);
    match (exported.next(), exported.next()) {
        (Some(only), None) => Some(only.name.clone()),
        _ => None,
    }
}
