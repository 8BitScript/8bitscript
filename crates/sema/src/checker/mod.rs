//! Port of packages/compiler/src/checker/index.mjs:1-324
//!
//! The checker. Rules: an integer literal has to fit the type it is assigned to; the runtime
//! builtin's name, `waitFrame`, is reserved; a string that becomes program data (a literal, or
//! the text of a template) holds only the portable character set, at most 255 of them; a
//! template string sits where the compiler can lay it out (`namespace.print(cell, \`...\`)` as a
//! statement) with every field sized; and a top-level `const` is never assigned to.
//!
//! Still deliberately narrow: the initializer must be a literal, optionally negated.
//! `let x: u8 = 200 + 100` is not folded.

pub mod immutable;
pub mod scopes;

use std::collections::HashSet;

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use jsnum::number_to_string;
use syntax::{Node, NodeKind, walk};

use crate::templates::{
    TypeScope, is_template_call, layout_template, misplaced_template, parameter_types,
    resolve_scalar_type, scan_declared_types,
};
use crate::types::resolve_integer_type;
use immutable::check_immutable_lets;

/// The one runtime builtin that is a bare name: `waitFrame()` lowers to its own IR kind. Reserving
/// the name is what keeps a user's own `waitFrame` from being silently reinterpreted as the
/// builtin. The value is the description the message quotes.
const RESERVED_BUILTIN_NAMES: [(&str, &str); 1] =
    [("waitFrame", "the built-in frame wait, waitFrame()")];

fn reserved_description(name: &str) -> Option<&'static str> {
    RESERVED_BUILTIN_NAMES
        .iter()
        .find(|(reserved, _)| *reserved == name)
        .map(|(_, description)| *description)
}

const MAX_STRING_LENGTH: usize = 255;

/// `PORTABLE_CHARACTERS` for one character: `[ 0-9A-Za-z!,\-.:?]`.
fn is_portable_character(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '!' | ',' | '-' | '.' | ':' | '?')
}

/// The `value` of a `StringLiteral` or `TemplateText`, and whether it is `unterminated`.
fn screen_text(n: &Node) -> Option<(&str, bool)> {
    match &n.kind {
        NodeKind::StringLiteral {
            value,
            unterminated,
            ..
        } => Some((value, *unterminated == Some(true))),
        NodeKind::TemplateText { value } => Some((value, false)),
        _ => None,
    }
}

fn check_screen_text(n: &Node, file: &str, diagnostics: &mut Vec<Diagnostic>) {
    let Some((value, unterminated)) = screen_text(n) else {
        return;
    };
    if unterminated {
        return; // the lexer reported it; whatever follows the quote is not the text
    }
    if let Some(bad) = value.chars().find(|ch| !is_portable_character(*ch)) {
        diagnostics.push(diagnostic(
            codes::UNPORTABLE_CHARACTER,
            format!(
                "'{bad}' is not in the portable character set (space, 0-9, A-Z, a-z, and ! , - . : ?)"
            ),
            file,
            n.start,
            n.length,
            Severity::Error,
        ));
        return;
    }
    let length = value.encode_utf16().count();
    if length > MAX_STRING_LENGTH {
        diagnostics.push(diagnostic(
            codes::STRING_TOO_LONG,
            format!("a string holds at most {MAX_STRING_LENGTH} characters; this one is {length}"),
            file,
            n.start,
            n.length,
            Severity::Error,
        ));
    }
}

fn reserved_name_diagnostic(name_node: &Node, name: &str, file: &str) -> Diagnostic {
    diagnostic(
        codes::RESERVED_BUILTIN_NAME,
        format!(
            "'{name}' is reserved for {}",
            reserved_description(name).unwrap_or_default()
        ),
        file,
        name_node.start,
        name_node.length,
        Severity::Error,
    )
}

/// The `name` of an `Identifier` node.
fn identifier_name(node: &Node) -> Option<&str> {
    match &node.kind {
        NodeKind::Identifier { name, .. } => Some(name),
        _ => None,
    }
}

/// The constant value of an initializer, or `None` when it is not a plain literal.
fn literal_value(expression: Option<&Node>) -> Option<(f64, &Node)> {
    let expression = expression?;
    match &expression.kind {
        NodeKind::IntegerLiteral { value, .. } => Some((*value, expression)),
        NodeKind::UnaryExpression { operator, argument } if operator == "-" || operator == "+" => {
            let NodeKind::IntegerLiteral {
                value: magnitude, ..
            } = &argument.kind
            else {
                return None;
            };
            Some((
                if operator == "-" {
                    -magnitude
                } else {
                    *magnitude
                },
                expression,
            ))
        }
        _ => None,
    }
}

/// `CONST_NAME`: `^[A-Z][A-Z0-9_]*$`.
fn is_const_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// `VARIABLE_NAME`: `^[a-z_]`.
fn is_variable_name(name: &str) -> bool {
    name.chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
}

/// `OptionCount` -> `OPTION_COUNT`, `borders` -> `BORDERS`: the spelling a const should have.
/// `name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()`: matches do not overlap.
fn const_spelling(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let lower_or_digit = chars[i].is_ascii_lowercase() || chars[i].is_ascii_digit();
        if lower_or_digit && chars.get(i + 1).is_some_and(char::is_ascii_uppercase) {
            out.push(chars[i]);
            out.push('_');
            out.push(chars[i + 1]);
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out.to_uppercase()
}

fn check_name_case(
    kind: &str,
    name_node: &Node,
    name: &str,
    file: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if kind == "const" && !is_const_name(name) {
        diagnostics.push(diagnostic(
            codes::NAME_CASE,
            format!(
                "a const is written in upper case, so a reader knows it is resolved by 8bitscript: {}",
                const_spelling(name)
            ),
            file,
            name_node.start,
            name_node.length,
            Severity::Error,
        ));
    } else if kind == "let" && !is_variable_name(name) {
        diagnostics.push(diagnostic(
            codes::NAME_CASE,
            "a variable starts with a lower-case letter; an upper-case name is a const",
            file,
            name_node.start,
            name_node.length,
            Severity::Error,
        ));
    }
}

/// The rules that need a function's scope. Templates: each one must be the second argument of a
/// `namespace.print` call in statement position, and each of its fields must have a width the
/// layout can determine; a template outside any function (a global initializer) has nowhere to
/// be laid out at all. Consts: this module's top-level `const`s are never assigned to or
/// `++`/`--`ed, unless a parameter of the same name shadows one.
fn check_functions(
    ast: &Node,
    file: &str,
    source: Option<&str>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let declared = scan_declared_types(Some(ast));
    // `check` returns before this for any root that is not a Program.
    let NodeKind::Program { body } = &ast.kind else {
        return;
    };
    let consts: HashSet<&str> = body
        .iter()
        .filter_map(|n| match &n.kind {
            NodeKind::VariableDeclaration {
                kind,
                name: Some(name),
                ..
            } if kind == "const" => identifier_name(name),
            _ => None,
        })
        .collect();
    let const_arrays: HashSet<&str> = declared
        .array_types
        .iter()
        .filter(|(_, a)| a.constant)
        .map(|(name, _)| name.as_str())
        .collect();
    // `HALF = 2` on a const, or `Table[0] = 2` on a const array (whose elements are data in the
    // program): checked in the walk below; either way the name is the span.
    let visit_function = |function: &Node, diagnostics: &mut Vec<Diagnostic>| {
        let NodeKind::FunctionDeclaration { body: fn_body, .. } = &function.kind else {
            return;
        };
        let Some(fn_body) = fn_body.as_deref() else {
            return; // a function whose body is still being typed
        };
        // Locals count with parameters here: function-scoped, an approximation of the block
        // scoping lowering applies, enough to know a name is not the const or array it shadows
        // and what type a field of it has.
        let mut param_types = parameter_types(function);
        walk(fn_body, &mut |n, _parent| {
            let NodeKind::VariableDeclaration {
                kind,
                name: Some(name),
                type_annotation,
                ..
            } = &n.kind
            else {
                return;
            };
            if kind != "let" {
                return;
            }
            let Some(annotation) = type_annotation.as_deref() else {
                return;
            };
            let NodeKind::TypeReference {
                name: type_name,
                type_arguments,
            } = &annotation.kind
            else {
                return;
            };
            if type_name.is_empty() {
                return;
            }
            if let Some(ty) = resolve_scalar_type(type_name, false, false)
                && type_arguments.is_empty()
            {
                param_types.insert(
                    identifier_name(name).unwrap_or_default().to_string(),
                    ty.to_string(),
                );
            }
        });
        let scope = TypeScope {
            param_types,
            global_types: declared.global_types.clone(),
            function_types: declared.function_types.clone(),
            array_types: declared.array_types.clone(),
        };
        // Parents are visited before children, so a template reached through its statement is
        // claimed here before walk() descends to it.
        let mut placed: HashSet<*const Node> = HashSet::new();
        walk(fn_body, &mut |n, _parent| {
            if let NodeKind::ExpressionStatement { expression } = &n.kind
                && is_template_call(Some(expression))
            {
                if let NodeKind::CallExpression { args, .. } = &expression.kind
                    && let Some(template) = args.get(1)
                {
                    placed.insert(std::ptr::from_ref(template));
                    diagnostics.extend(layout_template(template, &scope, file, source).diagnostics);
                }
                return;
            }
            if matches!(n.kind, NodeKind::TemplateLiteral { .. })
                && !placed.contains(&std::ptr::from_ref(n))
            {
                diagnostics.push(misplaced_template(n, file, None));
                return;
            }
            let target = match &n.kind {
                NodeKind::AssignmentExpression { left, .. } => Some(&**left),
                NodeKind::UpdateExpression { argument, .. } => Some(&**argument),
                _ => None,
            };
            let Some(target) = target else {
                return;
            };
            let (name, is_index) = match &target.kind {
                NodeKind::IndexExpression { object, .. } => (&**object, true),
                _ => (target, false),
            };
            let NodeKind::Identifier { name: ident, .. } = &name.kind else {
                return;
            };
            if scope.param_types.contains_key(ident.as_str()) {
                return;
            }
            let hit = if is_index {
                const_arrays.contains(ident.as_str())
            } else {
                consts.contains(ident.as_str())
            };
            if hit {
                diagnostics.push(diagnostic(
                    codes::ASSIGN_TO_CONST,
                    if is_index {
                        format!("'{ident}' is a const array \u{2014} data in the program, not RAM \u{2014} and cannot be assigned to")
                    } else {
                        format!("'{ident}' is a const \u{2014} a compile-time value with no storage \u{2014} and cannot be assigned")
                    },
                    file,
                    name.start,
                    name.length,
                    Severity::Error,
                ));
            }
        });
    };
    for node in body {
        match &node.kind {
            NodeKind::FunctionDeclaration { .. } => visit_function(node, diagnostics),
            NodeKind::NamespaceDeclaration { members, .. } => {
                for member in members.iter().flatten() {
                    if matches!(member.kind, NodeKind::FunctionDeclaration { .. }) {
                        visit_function(member, diagnostics);
                    }
                }
            }
            NodeKind::VariableDeclaration { initializer, .. } => {
                if let Some(initializer) = initializer.as_deref() {
                    walk(initializer, &mut |n, _parent| {
                        if matches!(n.kind, NodeKind::TemplateLiteral { .. }) {
                            diagnostics.push(misplaced_template(n, file, None));
                        }
                    });
                }
            }
            _ => {}
        }
    }
}

/// `options` of [`check`].
#[derive(Debug, Clone, Copy, Default)]
pub struct CheckOptions {
    pub skip_screen_text: bool,
}

/// `check(ast, file, source, options)`: the diagnostics for one parsed module.
#[must_use]
pub fn check(
    ast: Option<&Node>,
    file: &str,
    source: Option<&str>,
    options: CheckOptions,
) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let Some(ast) = ast else {
        return diagnostics;
    };
    // R7.8: JS throws in checkFunctions (`ast.body.filter`) for a root that is not a Program, and
    // reads an array-bodied root (a BlockStatement) as the top level. Neither caller can produce
    // one, so Rust returns the empty result at entry instead of carrying on with a substitute.
    if !matches!(ast.kind, NodeKind::Program { .. }) {
        return diagnostics;
    }

    check_functions(ast, file, source, &mut diagnostics);
    diagnostics.extend(check_immutable_lets(ast, file));

    walk(ast, &mut |n, parent| match &n.kind {
        NodeKind::RecordLiteral { .. } => {
            let format = parent.is_some_and(|p| match &p.kind {
                NodeKind::CallExpression { callee, args, .. } => {
                    matches!(&callee.kind, NodeKind::MemberExpression { property, .. }
                            if identifier_name(property) == Some("format"))
                        && args.get(1).is_some_and(|a| std::ptr::eq(a, n))
                }
                _ => false,
            });
            if !format {
                diagnostics.push(diagnostic(
                    codes::I18N_FORMAT,
                    "a record { name: value } is the argument list for i18n.format",
                    file,
                    n.start,
                    n.length,
                    Severity::Error,
                ));
            }
        }
        NodeKind::StringLiteral { .. } | NodeKind::TemplateText { .. }
            if !options.skip_screen_text
                && !(matches!(n.kind, NodeKind::StringLiteral { .. })
                    && parent
                        .is_some_and(|p| matches!(p.kind, NodeKind::ImportDeclaration { .. }))) =>
        {
            check_screen_text(n, file, &mut diagnostics);
        }
        NodeKind::ImportDeclaration { specifiers, .. } => {
            for specifier in specifiers {
                if let Some(name) = identifier_name(specifier)
                    && reserved_description(name).is_some()
                {
                    diagnostics.push(reserved_name_diagnostic(specifier, name, file));
                }
            }
        }
        NodeKind::FunctionDeclaration { name, .. } => {
            if let Some(name_node) = name.as_deref() {
                check_reserved(name_node, file, &mut diagnostics);
            }
        }
        NodeKind::Parameter { name, .. } => check_reserved(name, file, &mut diagnostics),
        NodeKind::VariableDeclaration {
            kind,
            name,
            type_annotation,
            initializer,
            ..
        } => check_variable(
            (
                kind,
                name.as_deref(),
                type_annotation.as_deref(),
                initializer.as_deref(),
            ),
            file,
            &mut diagnostics,
        ),
        _ => {}
    });

    diagnostics
}

fn check_reserved(name_node: &Node, file: &str, diagnostics: &mut Vec<Diagnostic>) {
    if let Some(name) = identifier_name(name_node)
        && reserved_description(name).is_some()
    {
        diagnostics.push(reserved_name_diagnostic(name_node, name, file));
    }
}

type VariableParts<'a> = (
    &'a str,
    Option<&'a Node>,
    Option<&'a Node>,
    Option<&'a Node>,
);

fn check_variable(
    (kind, name, type_annotation, initializer): VariableParts<'_>,
    file: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if let Some(name_node) = name {
        check_reserved(name_node, file, diagnostics);
        if let Some(text) = identifier_name(name_node) {
            check_name_case(kind, name_node, text, file, diagnostics);
        }
    }

    let (type_name, type_arguments): (&str, &[Node]) = match type_annotation.map(|t| &t.kind) {
        Some(NodeKind::TypeReference {
            name,
            type_arguments,
        }) => (name, type_arguments),
        _ => ("", &[]),
    };
    // A type constructor such as ptr<u8> has type arguments and is not itself an integer, so it
    // never resolves against the registry below.
    if !type_arguments.is_empty() {
        return;
    }
    let resolved = if type_name.is_empty() {
        None
    } else {
        resolve_integer_type(type_name)
    };
    let Some(resolved) = resolved else {
        return;
    };

    let Some((value, node)) = literal_value(initializer) else {
        return;
    };

    // The message keeps whatever the programmer actually wrote (`u8` or `utinyint`) even though
    // both resolve to the same type.
    let (min, max) = (resolved.min, resolved.max);
    if value < min as f64 || value > max as f64 {
        diagnostics.push(diagnostic(
            codes::VALUE_OUT_OF_RANGE,
            format!(
                "{} does not fit in {type_name} ({min}..{max})",
                number_to_string(value)
            ),
            file,
            node.start,
            node.length,
            Severity::Error,
        ));
    }
}
