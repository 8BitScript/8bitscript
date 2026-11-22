//! Port of packages/compiler/src/ir/index.mjs:1-798
//!
//! Module lowering: the `Lowering` state, `program`, consts, strings, templates, mods
//! (namespaces), imports, globals and arrays. A module lowers to a [`ModuleIr`], not yet linked.
//!
//! Function lowering (`ir/index.mjs:799-1588`) is in `function`, `stmt` and `expr`; they add to
//! the same [`Lowering`].

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use indexmap::{IndexMap, IndexSet};
use jsnum::{Nullable, number_to_string, utf16_len};
use mos_ir::{
    ArrayElement, Binop, Block, ChrPatch, Const, Expr, Function, Global, GlobalInit, Index,
    IrString, NamespaceCall, Ref, Stmt, StringCopy, StringLiteral,
};
use sema::templates::{
    Arity, ArrayInfo, MAX_STRING_LENGTH, Piece, TypeScope, layout_template, misplaced_template,
    resolve_array_type, resolve_scalar_type, scan_declared_types, wider_of,
};
use sema::types::{narrowest_integer_type, resolve_integer_type};
use serde::{Deserialize, Serialize};
use syntax::{Node, NodeKind};

/// The IR of one module, as `lower()` returns it: `{imports, globals, functions, namespaces,
/// strings, consts}`. A function in `functions` is a `mos_ir::Function`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleIr {
    /// Unresolved until the linker consumes them.
    pub imports: Vec<IrImport>,
    pub globals: Vec<Global>,
    pub functions: Vec<Function>,
    pub namespaces: Vec<IrNamespace>,
    pub strings: Vec<IrString>,
    /// Top-level `const` declarations: compile-time constants the linker inlines at every
    /// reference. They never reach a backend.
    pub consts: Vec<IrConst>,
    /// NES CHR-ROM tile patches: set only by media elaboration, never by `lower()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chr_patches: Option<Vec<ChrPatch>>,
}

/// `{imported, local, start, length}`: one name an import brings in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IrSpecifier {
    pub imported: String,
    pub local: String,
    pub start: i64,
    pub length: i64,
}

/// An import lowers to a record, not to code: the linker resolves it against the other modules.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IrImport {
    pub source: String,
    pub specifiers: Vec<IrSpecifier>,
    /// `use a::b::{..}`: set only when the path form was written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_form: Option<bool>,
    pub start: i64,
    pub length: i64,
}

/// One const member of a namespace: a number, a string-table slot, or a pending expression.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConstMember {
    Value(i64),
    String {
        string: i64,
    },
    Pending {
        pending: Box<Expr>,
        #[serde(rename = "type")]
        ty: String,
    },
}

/// A `namespace` (`mod`) member list: its functions by mangled name, its consts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IrNamespace {
    pub name: String,
    pub exported: bool,
    /// Member name to mangled function name (a JS `Map`).
    pub functions: IndexMap<String, String>,
    pub consts: IndexMap<String, ConstMember>,
    /// Each numeric const's declared type, beside its value.
    pub const_types: IndexMap<String, String>,
    pub start: i64,
    pub length: i64,
}

/// A top-level `const`: a number (`value`), a string (`string`), or pending (`pending`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IrConst {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    /// Absent on a string const, `null` when pending.
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub value: Nullable<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<Box<Expr>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub string: Option<i64>,
    pub exported: bool,
    pub start: i64,
    pub length: i64,
}

/// What an array name resolves to: its element type and length.
#[derive(Debug, Clone, PartialEq)]
pub struct ArrayDesc {
    pub ty: String,
    pub length: f64,
    /// A const array: data in the program, not RAM.
    pub constant: bool,
}

/// `arrayReference`'s answer: the `ref` expression and what is known of the array.
#[derive(Debug, Clone, PartialEq)]
pub struct ArrayReference {
    pub reference: Expr,
    pub array: Option<ArrayDesc>,
}

/// A JS number held as an IR integer (R2.1): `as i64` saturates (NaN to 0). Reachable with an
/// out-of-range literal; the IR value saturates and a message prints the JS number (`last_wide`).
#[allow(clippy::cast_possible_truncation)]
pub(crate) fn int(value: f64) -> i64 {
    value as i64
}

/// A value the saturating `int` could not hold.
pub(crate) fn is_wide(value: i64) -> bool {
    value.unsigned_abs() >= 9_200_000_000_000_000_000
}

pub(crate) fn wide_of(value: f64) -> Option<f64> {
    (value.abs() >= 9.2e18).then_some(value)
}

pub(crate) fn span(node: &Node) -> (Option<i64>, Option<i64>) {
    (Some(i64::from(node.start)), Some(i64::from(node.length)))
}

/// The `name` of an identifier or type reference.
pub(crate) fn name_of(node: &Node) -> Option<&str> {
    match &node.kind {
        NodeKind::Identifier { name, .. } | NodeKind::TypeReference { name, .. } => Some(name),
        _ => None,
    }
}

pub(crate) fn type_arguments(node: &Node) -> &[Node] {
    match &node.kind {
        NodeKind::TypeReference { type_arguments, .. } => type_arguments,
        _ => &[],
    }
}

/// `[...value].map((ch) => ch.charCodeAt(0) & 0xFF)`: one byte per character, the low byte of
/// its first UTF-16 unit.
fn string_bytes(value: &str) -> Vec<u8> {
    value
        .chars()
        .map(|ch| {
            let mut unit = [0u16; 2];
            let first = ch.encode_utf16(&mut unit)[0];
            (first & 0xFF) as u8
        })
        .collect()
}

/// The type a lowered expression carries, when it has one.
#[must_use]
pub fn type_of(expr: &Expr) -> Option<&str> {
    match expr {
        Expr::Binop(e) => e.ty.as_deref(),
        Expr::Unop(e) => e.ty.as_deref(),
        Expr::Index(e) => e.ty.as_deref(),
        Expr::Const(e) => e.ty.as_deref(),
        Expr::Ref(e) => e.ty.as_option().map(String::as_str),
        Expr::String(e) => e.ty.as_option().map(String::as_str),
        Expr::Cond(e) => e.ty.as_option().map(String::as_str),
        Expr::Call(e) => e.ty.as_option().map(String::as_str),
        Expr::NamespaceCall(e) => e.ty.as_option().map(String::as_str),
        Expr::NamespaceConst(e) => e.ty.as_option().map(String::as_str),
        Expr::StringByte(e) => Some(&e.ty),
        Expr::StringLength(e) => Some(&e.ty),
        Expr::MemoryRead(e) => Some(&e.ty),
        Expr::PortRead(e) => Some(&e.ty),
        Expr::Record(_) | Expr::PortWrite(_) => None,
    }
}

pub(crate) fn nullable(value: Option<String>) -> Nullable<String> {
    value.map_or(Nullable::Null, Nullable::Value)
}

/// The state of lowering one module (`class Lowering`, `ir/index.mjs:57-104`).
#[derive(Debug, Default)]
pub struct Lowering {
    pub file: String,
    /// The module's text, for quoting an expression in a diagnostic.
    pub source: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub imports: Vec<IrImport>,
    pub globals: Vec<Global>,
    pub functions: Vec<Function>,
    pub namespaces: Vec<IrNamespace>,
    pub strings: Vec<IrString>,
    pub consts: Vec<IrConst>,
    /// This module's own top-level consts, name to value, scanned in `program` before
    /// anything is lowered.
    pub own_consts: IndexMap<String, f64>,
    /// Each own const's type, canonical.
    pub own_const_types: IndexMap<String, String>,
    pub global_types: IndexMap<String, String>,
    pub function_types: IndexMap<String, String>,
    pub function_arity: IndexMap<String, Arity>,
    pub current_params: IndexMap<String, String>,
    pub current_array_params: IndexMap<String, ArrayDesc>,
    /// This module's own arrays.
    pub arrays: IndexMap<String, ArrayInfo>,
    /// Own string consts, name to string-table slot.
    pub own_strings: IndexMap<String, i64>,
    /// `string<N>` variables, name to capacity N.
    pub string_buffers: IndexMap<String, f64>,
    /// Own consts whose value only the linker can see.
    pub pending_consts: IndexSet<String>,
    /// Every top-level const by name, whatever its value turns out to be.
    pub const_names: IndexSet<String>,
    /// The return type of the function being lowered; `None` outside one.
    pub current_return_type: Option<String>,
    /// The names declared in the current block; `None` until a block opens.
    pub block_names: Option<IndexSet<String>>,
    /// The JS number behind the last constant lowered, when it is past the `i64` range and so
    /// saturated in the IR (R2.1). A diagnostic prints it, as JS does, not the saturated value.
    pub last_wide: Option<f64>,
    /// Set when a namespace member `VariableDeclaration` had no name (JS reports or throws).
    pub skipped_unnamed_member: bool,
}

impl Lowering {
    #[must_use]
    pub fn new(file: &str) -> Self {
        Self {
            file: file.to_string(),
            ..Self::default()
        }
    }

    /// The name scope a template field's type is inferred in (`get typeScope`).
    #[must_use]
    pub fn type_scope(&self) -> TypeScope {
        TypeScope {
            param_types: self.current_params.clone(),
            global_types: self.global_types.clone(),
            function_types: self.function_types.clone(),
            array_types: self.arrays.clone(),
        }
    }

    pub(crate) fn report_at(&mut self, start: u32, length: u32, message: impl Into<String>) {
        self.diagnostics.push(diagnostic(
            codes::NOT_COMPILABLE,
            message,
            &self.file,
            start,
            length,
            Severity::Error,
        ));
    }

    /// `fail(node, message)` for a caller that returns nothing.
    pub fn report(&mut self, node: &Node, message: impl Into<String>) {
        self.report_at(node.start, node.length, message);
    }

    /// `fail(node, message)`: a NOT_COMPILABLE diagnostic, and `None`.
    pub fn fail<T>(&mut self, node: &Node, message: impl Into<String>) -> Option<T> {
        self.report(node, message);
        None
    }

    pub(crate) fn push_error(&mut self, code: &str, message: String, start: u32, length: u32) {
        self.diagnostics.push(diagnostic(
            code,
            message,
            &self.file,
            start,
            length,
            Severity::Error,
        ));
    }

    /// Lower a parsed program (`program(ast)`).
    pub fn program(&mut self, ast: &Node) -> ModuleIr {
        let declared = scan_declared_types(Some(ast));
        self.global_types = declared.global_types;
        self.function_types = declared.function_types;
        self.arrays = declared.array_types;
        self.function_arity = declared.function_arity;
        let body: &[Node] = match &ast.kind {
            NodeKind::Program { body } => body,
            _ => &[],
        };
        // In source order, so a const may be written in terms of one above it.
        for node in body {
            let NodeKind::VariableDeclaration {
                kind,
                name: Some(name),
                type_annotation,
                initializer,
                ..
            } = &node.kind
            else {
                continue;
            };
            if kind != "const" {
                continue;
            }
            let name = name_of(name).unwrap_or_default();
            self.const_names.insert(name.to_string());
            if let Some(value) = self.const_initialiser(initializer.as_deref()) {
                self.own_consts.insert(name.to_string(), value);
                let declared = type_annotation
                    .as_deref()
                    .and_then(name_of)
                    .filter(|n| !n.is_empty())
                    .and_then(resolve_integer_type);
                self.own_const_types.insert(
                    name.to_string(),
                    declared.map_or_else(
                        || narrowest_integer_type(value),
                        |t| t.canonical_name.clone(),
                    ),
                );
            }
        }
        for node in body {
            match &node.kind {
                NodeKind::VariableDeclaration { .. } => self.global(node),
                NodeKind::FunctionDeclaration { .. } => self.function(node, None),
                NodeKind::NamespaceDeclaration { .. } => self.namespace_declaration(node),
                NodeKind::ImportDeclaration { .. } => self.import(node),
                _ => self.report(
                    node,
                    format!("a top-level {} is not compilable yet", node.type_name()),
                ),
            }
        }
        ModuleIr {
            imports: std::mem::take(&mut self.imports),
            globals: std::mem::take(&mut self.globals),
            functions: std::mem::take(&mut self.functions),
            namespaces: std::mem::take(&mut self.namespaces),
            strings: std::mem::take(&mut self.strings),
            consts: std::mem::take(&mut self.consts),
            chr_patches: None,
        }
    }

    /// The value of a top-level const's initializer: a literal, a negated literal, or a const
    /// declared above it. `None` for anything else.
    #[must_use]
    pub fn const_initialiser(&self, node: Option<&Node>) -> Option<f64> {
        let node = node?;
        match &node.kind {
            NodeKind::IntegerLiteral { value, .. } => Some(*value),
            NodeKind::BooleanLiteral { value, .. } => Some(if *value { 1.0 } else { 0.0 }),
            NodeKind::UnaryExpression { operator, argument }
                if operator == "-" || operator == "+" =>
            {
                match &argument.kind {
                    NodeKind::IntegerLiteral { value, .. } => {
                        Some(if operator == "-" { -*value } else { *value })
                    }
                    _ => None,
                }
            }
            NodeKind::Identifier { name, .. } => self.own_consts.get(name).copied(),
            _ => None,
        }
    }

    /// A string literal (or a template's text run) as constant data: the IR expression naming
    /// its slot in this module's string table.
    pub fn string_constant(&mut self, node: &Node, value: &str) -> Expr {
        let found = self.strings.iter().position(|s| s.text == value);
        let index = found.unwrap_or_else(|| {
            self.strings.push(IrString {
                text: value.to_string(),
                bytes: string_bytes(value),
            });
            self.strings.len() - 1
        });
        let (start, length) = span(node);
        Expr::String(StringLiteral {
            index: i64::try_from(index).unwrap_or(i64::MAX),
            ty: Nullable::Value("string".to_string()),
            start,
            length,
        })
    }

    /// Is `name` a string here: a `string` parameter, a string const, or a `string<N>` variable?
    #[must_use]
    pub fn is_string_parameter(&self, name: &str) -> bool {
        if let Some(ty) = self.current_params.get(name) {
            return ty == "string";
        }
        self.own_strings.contains_key(name) || self.string_buffers.contains_key(name)
    }

    /// The lowered expression for a string by name (see `is_string_parameter`).
    #[must_use]
    pub fn string_ref(&self, node: &Node) -> Expr {
        let name = name_of(node).unwrap_or_default();
        let (start, length) = span(node);
        if !self.current_params.contains_key(name)
            && let Some(index) = self.own_strings.get(name)
        {
            return Expr::String(StringLiteral {
                index: *index,
                ty: Nullable::Value("string".to_string()),
                start,
                length,
            });
        }
        Expr::Ref(Ref {
            name: name.to_string(),
            ty: Nullable::Value("string".to_string()),
            start,
            length,
        })
    }

    /// `text.print(cell, \`TICK ${ticks % 10:1}\`)`: a template laid out at compile time into
    /// the calls a person would have written by hand.
    pub fn template_call(&mut self, node: &Node) -> Option<Stmt> {
        let NodeKind::CallExpression { callee, args, .. } = &node.kind else {
            return None;
        };
        let template = args.last()?;
        if !sema::templates::is_template_call(Some(node)) {
            let namespace = match &callee.kind {
                NodeKind::MemberExpression { object, .. } => match &object.kind {
                    NodeKind::Identifier { name, .. } => Some(name.as_str()),
                    _ => None,
                },
                _ => None,
            };
            self.diagnostics
                .push(misplaced_template(template, &self.file, namespace));
            return None;
        }
        let NodeKind::MemberExpression { object, .. } = &callee.kind else {
            return None;
        };
        let namespace = name_of(object).unwrap_or_default().to_string();
        let layout = layout_template(
            template,
            &self.type_scope(),
            &self.file,
            self.source.as_deref(),
        );
        let failed = !layout.diagnostics.is_empty();
        self.diagnostics.extend(layout.diagnostics);
        if failed {
            return None;
        }

        let cell = self.expression(args.first())?;
        // Each call gets its own copy of the cell expression: the linker renames references in
        // place, and one node shared between calls would be renamed twice.
        let cell_at = |offset: i64| -> Expr {
            if let Expr::Const(c) = &cell {
                let value = c.value.saturating_add(offset);
                return Expr::Const(Const {
                    value,
                    ty: Some(narrowest_integer_type(value as f64)),
                });
            }
            if offset == 0 {
                return cell.clone();
            }
            let right = Const {
                value: offset,
                ty: Some(narrowest_integer_type(offset as f64)),
            };
            let ty = wider_of(type_of(&cell), right.ty.as_deref());
            Expr::Binop(Binop {
                operator: "+".to_string(),
                left: Box::new(cell.clone()),
                right: Box::new(Expr::Const(right)),
                ty,
            })
        };
        let call = |member: &str, args: Vec<Expr>| -> Stmt {
            Stmt::NamespaceCall(NamespaceCall {
                namespace: namespace.clone(),
                member: member.to_string(),
                args,
                ty: Nullable::Absent,
                start: i64::from(node.start),
                length: i64::from(node.length),
            })
        };

        let mut body = Vec::new();
        for piece in &layout.pieces {
            match piece {
                Piece::Text { offset, node: text } => {
                    let NodeKind::TemplateText { value } = &text.kind else {
                        continue;
                    };
                    let s = self.string_constant(text, value);
                    body.push(call("print", vec![cell_at(i64::from(*offset)), s]));
                }
                Piece::Field {
                    offset,
                    width,
                    node: field,
                } => {
                    let NodeKind::TemplateField { expression, .. } = &field.kind else {
                        continue;
                    };
                    let value = self.expression(Some(expression))?;
                    let width = i64::from(*width);
                    body.push(call(
                        "printNumber",
                        vec![
                            cell_at(i64::from(*offset)),
                            value,
                            Expr::Const(Const {
                                value: width,
                                ty: Some(narrowest_integer_type(width as f64)),
                            }),
                        ],
                    ));
                }
            }
        }
        if body.len() == 1 {
            body.pop()
        } else {
            Some(Stmt::Block(Block {
                body,
                origin: None,
                start: None,
                length: None,
            }))
        }
    }

    /// `namespace screen { function setBorderColor(...) {...} const BLUE = 6; }`.
    ///
    /// A namespace has no runtime representation: a function member lowers to an ordinary IR
    /// function under a mangled name, and a const member is recorded as a plain number.
    pub fn namespace_declaration(&mut self, node: &Node) {
        let NodeKind::NamespaceDeclaration {
            name: Some(name_node),
            members,
            exported,
        } = &node.kind
        else {
            return; // `namespace` with no name yet; the parser said so
        };
        let name = name_of(name_node).unwrap_or_default().to_string();
        let mut functions: IndexMap<String, String> = IndexMap::new();
        let mut consts: IndexMap<String, ConstMember> = IndexMap::new();
        let mut const_types: IndexMap<String, String> = IndexMap::new();

        for member in members.iter().flatten() {
            match &member.kind {
                NodeKind::FunctionDeclaration { name: fname, .. } => {
                    let member_name = fname
                        .as_deref()
                        .and_then(name_of)
                        .unwrap_or("anonymous")
                        .to_string();
                    let mangled = format!("{name}_{member_name}");
                    self.function(member, Some(&mangled));
                    functions.insert(member_name, mangled);
                }
                NodeKind::VariableDeclaration {
                    kind,
                    name: Some(member_name),
                    type_annotation,
                    initializer,
                    ..
                } => {
                    let member_name = name_of(member_name).unwrap_or_default().to_string();
                    if kind != "const" {
                        self.report(
                            member,
                            "a mod member value must be declared with const, not let mut",
                        );
                        continue;
                    }
                    let type_name = type_annotation.as_deref().and_then(name_of);
                    let resolved = type_name
                        .filter(|n| !n.is_empty())
                        .and_then(|n| resolve_scalar_type(n, false, true));
                    let Some(resolved) = resolved.filter(|r| *r != "void") else {
                        self.report(
                            member,
                            format!(
                                "a mod const of type {} is not compilable yet",
                                type_name.unwrap_or("(none)")
                            ),
                        );
                        continue;
                    };
                    if resolved == "string" {
                        let Some(init) = initializer
                            .as_deref()
                            .filter(|i| matches!(i.kind, NodeKind::StringLiteral { .. }))
                        else {
                            self.report(
                                initializer.as_deref().unwrap_or(member),
                                "a mod string const needs a string literal: const NAME: string = \"...\"",
                            );
                            continue;
                        };
                        let NodeKind::StringLiteral { value, .. } = &init.kind else {
                            continue;
                        };
                        if let Expr::String(slot) = self.string_constant(init, value) {
                            consts.insert(member_name, ConstMember::String { string: slot.index });
                        }
                        continue;
                    }
                    // The same initializers a module-level const takes: a literal, or a const.
                    let init = match initializer.as_deref() {
                        Some(i) => self.expression(Some(i)),
                        None => None,
                    };
                    match init {
                        Some(Expr::Const(c)) => {
                            consts.insert(member_name.clone(), ConstMember::Value(c.value));
                            const_types.insert(member_name, resolved.to_string());
                        }
                        Some(Expr::Ref(r)) if self.declares(&r.name) => {
                            self.report(
                                initializer.as_deref().unwrap_or(member),
                                format!(
                                    "'{}' is not a const, so it cannot initialize a mod const: an initializer is a literal or a const",
                                    r.name
                                ),
                            );
                        }
                        Some(pending @ (Expr::Ref(_) | Expr::NamespaceConst(_))) => {
                            consts.insert(
                                member_name.clone(),
                                ConstMember::Pending {
                                    pending: Box::new(pending),
                                    ty: resolved.to_string(),
                                },
                            );
                            const_types.insert(member_name, resolved.to_string());
                        }
                        _ => self
                            .report(member, "a mod const is initialized by a literal or a const"),
                    }
                }
                // A declaration whose name the parser could not read: it said so.
                // R7.8: skipped with no diagnostic; the flag lets a replay tell a JS throw here.
                NodeKind::VariableDeclaration { name: None, .. } => {
                    self.skipped_unnamed_member = true
                }
                _ => self.report(
                    member,
                    format!(
                        "a {} is not compilable inside a mod yet",
                        member.type_name()
                    ),
                ),
            }
        }

        self.namespaces.push(IrNamespace {
            name,
            exported: *exported,
            functions,
            consts,
            const_types,
            start: i64::from(name_node.start),
            length: i64::from(name_node.length),
        });
    }

    /// An import lowers to a record, not to code: the linker resolves it against the other
    /// modules in the graph.
    pub fn import(&mut self, node: &Node) {
        let NodeKind::ImportDeclaration {
            specifiers,
            source,
            use_path,
        } = &node.kind
        else {
            return;
        };
        let Some(source) = source.as_deref() else {
            // The parser already reported the malformed import.
            self.report(
                node,
                "an import without a module specifier is not compilable",
            );
            return;
        };
        let NodeKind::StringLiteral { value, .. } = &source.kind else {
            return;
        };
        let specifiers = specifiers
            .iter()
            .map(|spec| {
                let (local, imported) = match &spec.kind {
                    NodeKind::Identifier { name, imported, .. } => (name.clone(), imported.clone()),
                    _ => (String::new(), None),
                };
                IrSpecifier {
                    imported: imported.unwrap_or_else(|| local.clone()),
                    local,
                    start: i64::from(spec.start),
                    length: i64::from(spec.length),
                }
            })
            .collect();
        self.imports.push(IrImport {
            source: value.clone(),
            specifiers,
            path_form: (*use_path == Some(true)).then_some(true),
            start: i64::from(node.start),
            length: i64::from(node.length),
        });
    }

    /// The `@address(...)` decorators of a declaration: the address, or `None` after a failure
    /// (already reported). `Some(None)` is no decorator at all.
    fn address_decorators(&mut self, node: &Node, message: &str) -> Option<Option<f64>> {
        let mut address = None;
        for decorator in node.decorators.iter().flatten() {
            let NodeKind::Decorator { name, args } = &decorator.kind else {
                continue;
            };
            if name == "address" {
                let value = self.const_initialiser(args.first());
                let Some(value) = value else {
                    return self.fail(decorator, message);
                };
                address = Some(value);
            } else {
                return self.fail(
                    decorator,
                    format!("the @{name} decorator is not compilable yet"),
                );
            }
        }
        Some(address)
    }

    /// A top-level `let`/`const` (`global(node)`).
    pub fn global(&mut self, node: &Node) {
        let NodeKind::VariableDeclaration {
            kind,
            name: Some(name_node),
            type_annotation,
            initializer,
            exported,
            ..
        } = &node.kind
        else {
            return; // the parser reported the missing name
        };
        let name = name_of(name_node).unwrap_or_default().to_string();
        let Some(annotation) = type_annotation.as_deref() else {
            self.report(node, "a global needs an explicit type to be compilable");
            return;
        };
        let annotation_name = name_of(annotation).unwrap_or_default();
        if annotation_name == "array" {
            return self.array_global(node);
        }
        if annotation_name == "string" {
            return self.string_global(node);
        }

        // Whatever spelling the programmer used normalises to the same canonical id.
        let mut is_volatile = false;
        let resolved = if annotation_name == "volatile" {
            let inner = type_arguments(annotation)
                .first()
                .and_then(name_of)
                .and_then(resolve_integer_type);
            if inner.is_none() {
                self.report(node, "volatile<T> needs an integer T to be compilable");
                return;
            }
            is_volatile = true;
            inner
        } else {
            resolve_integer_type(annotation_name)
        };
        if resolved.is_none() && annotation_name != "bool" {
            self.report(
                node,
                format!("a global of type {annotation_name} is not compilable yet"),
            );
            return;
        }
        let ty = resolved.map_or_else(|| "bool".to_string(), |t| t.canonical_name.clone());

        let Some(address) = self.address_decorators(
            node,
            "@address needs one integer literal, or a const declared in this module",
        ) else {
            return;
        };

        let mut init: Option<Expr> = None;
        if let Some(initializer) = initializer.as_deref() {
            init = self.expression(Some(initializer));
            // A bare name that is not an own const is either an imported const, left for the
            // linker, or a name this module declares, which is refused here and now.
            match &init {
                Some(Expr::Ref(r)) => {
                    if self.declares(&r.name) {
                        let message = format!(
                            "'{}' is not a const, so it cannot initialize a global: an initializer is a literal or a const",
                            r.name
                        );
                        self.report(initializer, message);
                        return;
                    }
                }
                Some(Expr::NamespaceConst(_) | Expr::Const(_)) | None => {}
                Some(_) => {
                    self.report(
                        initializer,
                        "a global initializer must be a literal or a const to be compilable yet",
                    );
                    return;
                }
            }
        }
        if address.is_some() && init.is_some() {
            self.report(
                node,
                "an @address global maps hardware and cannot have an initializer",
            );
            return;
        }

        // `const` is a compile-time constant: recorded, never stored.
        if kind == "const" {
            if is_volatile || address.is_some() {
                self.report(
                    node,
                    "a const is a compile-time value; it cannot be volatile or mapped with @address",
                );
                return;
            }
            let Some(init) = init else {
                self.report(
                    node,
                    "a const needs a literal initializer: it has no storage to assign later",
                );
                return;
            };
            // A value only the linker can see: recorded pending, and not in `own_consts`.
            let (value, pending) = match init {
                Expr::Const(c) => (Nullable::Value(c.value), None),
                other => (Nullable::Null, Some(Box::new(other))),
            };
            if pending.is_some() {
                self.pending_consts.insert(name.clone());
            }
            self.consts.push(IrConst {
                name,
                ty,
                value,
                pending,
                string: None,
                exported: *exported,
                start: i64::from(name_node.start),
                length: i64::from(name_node.length),
            });
            return;
        }

        let init = match init {
            Some(Expr::Const(c)) => GlobalInit::Scalar(c.value),
            Some(other) => GlobalInit::Pending(Box::new(other)),
            None => GlobalInit::Scalar(0),
        };
        self.globals.push(Global {
            name,
            ty,
            volatile: is_volatile,
            address: address.map(int),
            init: Some(init),
            exported: *exported,
            // The name's span, so the linker's entry-export rule can point at it.
            start: i64::from(name_node.start),
            length: i64::from(name_node.length),
            array: None,
            constant: None,
            string_capacity: None,
        });
    }

    /// `const LABEL: string = "READY";` and `let name: string<8>;`.
    pub fn string_global(&mut self, node: &Node) {
        let NodeKind::VariableDeclaration {
            kind,
            name: Some(name_node),
            type_annotation: Some(annotation),
            initializer,
            exported,
            ..
        } = &node.kind
        else {
            return;
        };
        let name = name_of(name_node).unwrap_or_default().to_string();
        let is_const = kind == "const";
        if let Some(first) = node.decorators.iter().flatten().next() {
            self.report(
                first,
                "a string is not mapped with @address: it is text in the program or in RAM",
            );
            return;
        }
        let arguments = type_arguments(annotation);
        let (start, length) = (i64::from(name_node.start), i64::from(name_node.length));
        if is_const {
            if !arguments.is_empty() {
                self.report(
                    annotation,
                    "a const string is written `const NAME: string = \"...\"`: its length is the literal's",
                );
                return;
            }
            let Some(init) = initializer
                .as_deref()
                .filter(|i| matches!(i.kind, NodeKind::StringLiteral { .. }))
            else {
                self.report(
                    initializer.as_deref().unwrap_or(node),
                    "a const string needs a string literal: const NAME: string = \"...\"",
                );
                return;
            };
            let NodeKind::StringLiteral { value, .. } = &init.kind else {
                return;
            };
            let Expr::String(slot) = self.string_constant(init, value) else {
                return;
            };
            self.own_strings.insert(name.clone(), slot.index);
            self.consts.push(IrConst {
                name,
                ty: "string".to_string(),
                value: Nullable::Absent,
                pending: None,
                string: Some(slot.index),
                exported: *exported,
                start,
                length,
            });
            return;
        }
        let size = arguments.first();
        let capacity: Option<f64> = match size.map(|s| &s.kind) {
            Some(NodeKind::IntegerLiteral { value, .. }) => Some(*value),
            Some(NodeKind::TypeReference {
                name,
                type_arguments,
                ..
            }) if type_arguments.is_empty() => self.own_consts.get(name).copied(),
            _ => None,
        };
        let Some(capacity) = capacity.filter(|_| arguments.len() == 1) else {
            self.report(
                annotation,
                "a string variable needs a capacity: let name: string<N>, N an integer literal or a const declared in this module",
            );
            return;
        };
        if capacity.fract() != 0.0 || capacity < 1.0 || capacity > f64::from(MAX_STRING_LENGTH) {
            if let Some(size) = size {
                self.report(
                    size,
                    format!(
                        "a string capacity is 1..{MAX_STRING_LENGTH}, not {}",
                        number_to_string(capacity)
                    ),
                );
            }
            return;
        }
        let capacity_len = int(capacity);
        let mut init = vec![0i64; usize::try_from(capacity_len + 1).unwrap_or(0)];
        if let Some(initializer) = initializer.as_deref() {
            let NodeKind::StringLiteral { value, .. } = &initializer.kind else {
                self.report(
                    initializer,
                    "a string variable starts as a string literal, or empty",
                );
                return;
            };
            let bytes = string_bytes(value);
            if bytes.len() > usize::try_from(capacity_len).unwrap_or(0) {
                self.push_error(
                    codes::STRING_TOO_LONG,
                    format!(
                        "\"{value}\" is {} characters and does not fit in string<{}>",
                        bytes.len(),
                        number_to_string(capacity)
                    ),
                    initializer.start,
                    initializer.length,
                );
                return;
            }
            init[0] = i64::try_from(bytes.len()).unwrap_or(0);
            for (i, b) in bytes.iter().enumerate() {
                init[1 + i] = i64::from(*b);
            }
        }
        self.string_buffers.insert(name.clone(), capacity);
        self.globals.push(Global {
            name,
            ty: "utinyint".to_string(),
            volatile: false,
            address: None,
            init: Some(GlobalInit::Array(init)),
            exported: *exported,
            start,
            length,
            array: Some(capacity_len + 1),
            constant: Some(false),
            string_capacity: Some(capacity_len),
        });
    }

    /// `name = "..."` or `name = other` on a `string<N>`: a runtime copy, cut to N.
    pub fn string_assignment(&mut self, node: &Node, capacity: f64) -> Option<Stmt> {
        let NodeKind::AssignmentExpression {
            operator,
            left,
            right,
        } = &node.kind
        else {
            return None;
        };
        if operator != "=" {
            return self.fail(
                node,
                "a string is assigned whole (s = ...); there is no string arithmetic",
            );
        }
        if let Some(right) = right.as_deref()
            && let NodeKind::StringLiteral { value, .. } = &right.kind
            && utf16_len(value) as f64 > capacity
        {
            self.push_error(
                codes::STRING_TOO_LONG,
                format!(
                    "\"{value}\" is {} characters and does not fit in string<{}>",
                    utf16_len(value),
                    number_to_string(capacity)
                ),
                right.start,
                right.length,
            );
            return None;
        }
        let source = self.expression(right.as_deref())?;
        let left_name = name_of(left).unwrap_or_default();
        if !self.is_string_value(&source) {
            return self.fail(
                right.as_deref().unwrap_or(node),
                format!(
                    "'{left_name}' is a string<{}>: it is assigned a string — a literal, a const, a parameter, or another string variable",
                    number_to_string(capacity)
                ),
            );
        }
        Some(Stmt::StringCopy(StringCopy {
            target: Expr::Ref(Ref {
                name: left_name.to_string(),
                ty: Nullable::Absent,
                start: Some(i64::from(left.start)),
                length: Some(i64::from(left.length)),
            }),
            source,
            capacity: int(capacity),
            start: i64::from(left.start),
            length: i64::from(left.length),
        }))
    }

    /// Is this lowered expression a string, as far as this module can tell?
    #[must_use]
    pub fn is_string_value(&self, expr: &Expr) -> bool {
        match expr {
            Expr::String(_) => true,
            Expr::Ref(r) => {
                // A parameter, a string variable, or — unknown here — an import the linker
                // will check.
                let name = r.name.as_str();
                self.current_params.get(name).is_some_and(|t| t == "string")
                    || self.string_buffers.contains_key(name)
                    || !(self.current_params.contains_key(name)
                        || self.global_types.contains_key(name)
                        || self.function_types.contains_key(name)
                        || self.arrays.contains_key(name)
                        || self.own_consts.contains_key(name))
            }
            _ => false,
        }
    }

    /// `let hp: array<utinyint, 4>;`, `const TABLE: array<utinyint, 3> = [1, 2, 3];`,
    /// `@address(0x0400) let screenRam: array<utinyint, 1000>;`.
    pub fn array_global(&mut self, node: &Node) {
        let NodeKind::VariableDeclaration {
            kind,
            name: Some(name_node),
            type_annotation,
            initializer,
            exported,
            ..
        } = &node.kind
        else {
            return;
        };
        let name = name_of(name_node).unwrap_or_default().to_string();
        let annotation = type_annotation.as_deref();
        let (ty, length) = match resolve_array_type(annotation, &self.own_consts) {
            Ok(array) => (array.type_, array.length),
            Err(error) => {
                self.report(annotation.unwrap_or(node), error);
                return;
            }
        };
        let constant = kind == "const";

        let Some(address) = self.address_decorators(
            node,
            "@address needs one integer literal, or a const declared in this module",
        ) else {
            return;
        };

        let mut init: Option<Vec<ArrayElement>> = None;
        if let Some(initializer) = initializer.as_deref() {
            if address.is_some() {
                self.report(
                    node,
                    "an @address array maps hardware and cannot have an initializer",
                );
                return;
            }
            let NodeKind::ArrayLiteral { elements } = &initializer.kind else {
                self.report(
                    initializer,
                    "an array initializer is written [v, v, ...]: one compile-time value per element",
                );
                return;
            };
            if elements.len() as f64 != length {
                self.push_error(
                    codes::ARRAY_SIZE_MISMATCH,
                    format!(
                        "'{name}' is an array<{ty}, {}>, so its initializer needs {} element{}, not {}",
                        number_to_string(length),
                        number_to_string(length),
                        if length == 1.0 { "" } else { "s" },
                        elements.len()
                    ),
                    initializer.start,
                    initializer.length,
                );
                return;
            }
            let mut values = Vec::new();
            let (min, max) = if ty == "bool" {
                (0, 1)
            } else {
                resolve_integer_type(ty).map_or((0, 1), |t| (t.min, t.max))
            };
            for element in elements {
                let Some(value) = self.expression(Some(element)) else {
                    return;
                };
                // `BorderColor.BLUE`, or an imported const: a compile-time value only the
                // linker can see. Left as is for it to fill in.
                let pending = match &value {
                    Expr::NamespaceConst(_) => true,
                    Expr::Ref(r) => !self.declares(&r.name),
                    _ => false,
                };
                if pending {
                    values.push(ArrayElement::Pending(value));
                    continue;
                }
                let Expr::Const(c) = value else {
                    self.report(
                        element,
                        "an array element is a literal or a const: the data is laid out at compile time",
                    );
                    return;
                };
                if c.value < min || c.value > max {
                    self.push_error(
                        codes::VALUE_OUT_OF_RANGE,
                        format!(
                            "{} does not fit in {ty} ({min}..{max})",
                            self.shown(c.value)
                        ),
                        element.start,
                        element.length,
                    );
                    return;
                }
                values.push(ArrayElement::Value(c.value));
            }
            init = Some(values);
        }
        if constant && address.is_some() {
            self.report(
                node,
                "a const array is data in the program; it cannot be mapped with @address",
            );
            return;
        }
        if constant && init.is_none() {
            self.report(
                node,
                "a const array needs its values: const NAME: array<T, N> = [...]",
            );
            return;
        }

        let init = init.map(|values| {
            if values.iter().all(|v| matches!(v, ArrayElement::Value(_))) {
                GlobalInit::Array(
                    values
                        .into_iter()
                        .filter_map(|v| match v {
                            ArrayElement::Value(n) => Some(n),
                            ArrayElement::Pending(_) => None,
                        })
                        .collect(),
                )
            } else {
                GlobalInit::Elements(values)
            }
        });
        self.globals.push(Global {
            name,
            ty: ty.to_string(),
            volatile: false,
            address: address.map(int),
            init,
            exported: *exported,
            start: i64::from(name_node.start),
            length: i64::from(name_node.length),
            array: Some(int(length)),
            constant: Some(constant),
            string_capacity: None,
        });
    }

    /// What an `a` in `a[i]` / `a.length` / `a[i] = v` names, as far as this module can tell:
    /// its own array (with everything known), a name it declares that is not an array
    /// (refused), or a name it does not declare — an import, left to the linker.
    pub fn array_reference(&mut self, object: Option<&Node>, what: &str) -> Option<ArrayReference> {
        let Some(object) = object else {
            self.report_at(
                0,
                0,
                format!("{what} is only compilable on an array by name"),
            );
            return None;
        };
        let NodeKind::Identifier { name, .. } = &object.kind else {
            return self.fail(
                object,
                format!("{what} is only compilable on an array by name"),
            );
        };
        let reference = Expr::Ref(Ref {
            name: name.clone(),
            ty: Nullable::Absent,
            start: Some(i64::from(object.start)),
            length: Some(i64::from(object.length)),
        });
        // An array parameter is the array it was handed, with its element type and length
        // known from its own type.
        if let Some(p) = self.current_array_params.get(name) {
            return Some(ArrayReference {
                reference,
                array: Some(p.clone()),
            });
        }
        if self.current_params.contains_key(name) {
            return self.fail(
                object,
                format!("'{name}' is a parameter or local, not an array: {what} needs an array"),
            );
        }
        if let Some(a) = self.arrays.get(name) {
            return Some(ArrayReference {
                reference,
                array: Some(ArrayDesc {
                    ty: a.type_.to_string(),
                    length: a.length,
                    constant: a.constant,
                }),
            });
        }
        if self.declares(name)
            || self.own_consts.contains_key(name)
            || self.pending_consts.contains(name)
        {
            return self.fail(
                object,
                format!("'{name}' is not an array: {what} needs an array<T, N>"),
            );
        }
        Some(ArrayReference {
            reference,
            array: None,
        })
    }

    /// A parameter's default, lowered: a number, or a pending expression the linker resolves
    /// (`BorderColor.BLACK`, an imported const). `None`, with a diagnostic, for anything that
    /// is not a compile-time value.
    pub fn parameter_default(&mut self, p: &Node, ty: &str) -> Option<Expr> {
        let NodeKind::Parameter { default_value, .. } = &p.kind else {
            return None;
        };
        let default_node = default_value.as_deref();
        let at = default_node.unwrap_or(p);
        let value = self.expression(default_node)?;
        if ty == "string" {
            if !matches!(value, Expr::String(_)) {
                return self.fail(
                    at,
                    "a string parameter's default is a string literal or a string const",
                );
            }
            return Some(value);
        }
        let pending = match &value {
            Expr::NamespaceConst(_) => true,
            Expr::Ref(r) => !self.declares(&r.name) && !self.current_params.contains_key(&r.name),
            _ => false,
        };
        if pending {
            return Some(value);
        }
        let Expr::Const(c) = &value else {
            return self.fail(
                at,
                "a parameter default is a literal or a const: it is filled in at compile time",
            );
        };
        let range = if ty == "bool" {
            Some((0, 1))
        } else {
            resolve_integer_type(ty).map(|t| (t.min, t.max))
        };
        if let Some((min, max)) = range
            && (c.value < min || c.value > max)
        {
            self.push_error(
                codes::VALUE_OUT_OF_RANGE,
                format!(
                    "{} does not fit in {ty} ({min}..{max})",
                    self.shown(c.value)
                ),
                at.start,
                at.length,
            );
            return None;
        }
        Some(value)
    }

    /// The argument count of a call to one of this module's own functions, against its
    /// parameters: too many, or fewer than those without a default, is a diagnostic here.
    pub fn check_arity(&mut self, node: &Node, name: &str, count: usize) -> bool {
        let Some(arity) = self.function_arity.get(name).copied() else {
            return true;
        };
        if self.current_params.contains_key(name) {
            return true;
        }
        if count > arity.max || count < arity.min {
            let takes = if arity.min == arity.max {
                format!("{}", arity.max)
            } else {
                format!("{} to {}", arity.min, arity.max)
            };
            self.push_error(
                codes::WRONG_ARGUMENT_COUNT,
                format!(
                    "'{name}' takes {takes} argument{}, not {count}",
                    if arity.max == 1 { "" } else { "s" }
                ),
                node.start,
                node.length,
            );
            return false;
        }
        true
    }

    /// Does this module declare `name` as something other than a const — a global, function,
    /// array, or string?
    #[must_use]
    pub fn declares(&self, name: &str) -> bool {
        if self.const_names.contains(name) {
            return false;
        }
        self.global_types.contains_key(name)
            || self.function_types.contains_key(name)
            || self.arrays.contains_key(name)
            || self.string_buffers.contains_key(name)
    }

    /// Index range check for an own array with a literal index; true when it passed.
    pub fn index_in_range(
        &mut self,
        index_node: &Node,
        index: &Expr,
        array: Option<&ArrayDesc>,
    ) -> bool {
        let (Some(array), Expr::Const(c)) = (array, index) else {
            return true;
        };
        if (c.value as f64) < 0.0 || (c.value as f64) >= array.length {
            self.push_error(
                codes::INDEX_OUT_OF_RANGE,
                format!(
                    "index {} is outside an array<{}, {}>: elements are 0..{}",
                    self.shown(c.value),
                    array.ty,
                    number_to_string(array.length),
                    number_to_string(array.length - 1.0)
                ),
                index_node.start,
                index_node.length,
            );
            return false;
        }
        true
    }

    /// `a[i]` as an IR read.
    pub fn index_read(&mut self, node: &Node) -> Option<Expr> {
        let NodeKind::IndexExpression { object, index } = &node.kind else {
            return None;
        };
        let target = self.array_reference(Some(object), "indexing")?;
        let index_node = index.as_deref();
        let index = self.expression(index_node)?;
        // A hole in the index would have returned above; the node is there.
        let at = index_node.unwrap_or(node);
        if !self.index_in_range(at, &index, target.array.as_ref()) {
            return None;
        }
        let element_type = target.array.map(|a| a.ty);
        Some(Expr::Index(Index {
            array: Box::new(target.reference),
            index: Box::new(index),
            element_type: element_type.clone(),
            ty: element_type,
        }))
    }
}
