//! Port of packages/compiler/src/templates/index.mjs:1-291
//!
//! Template layout: a template string split into runs of text and number fields, each at the
//! cell the pieces before it add up to. One implementation for the checker and for lowering.

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use indexmap::IndexMap;
use jsnum::{number_to_string, utf16_len};
use syntax::{Node, NodeKind};

use crate::types::resolve_integer_type;

/// A string holds at most this many characters (one length byte).
pub const MAX_STRING_LENGTH: u32 = 255;

/// Elements an array may hold at most: an index has to fit the machine's address arithmetic.
pub const MAX_ARRAY_LENGTH: u32 = 65535;

/// Operators whose result is always bool, whatever their operands' types.
pub const COMPARISON_OPERATORS: [&str; 8] = ["==", "!=", "<", ">", "<=", ">=", "&&", "||"];

/// `void` / `bool` / `string` / an integer type, or `None` when `name` is none of them.
#[must_use]
pub fn resolve_scalar_type(
    name: &str,
    allow_void: bool,
    allow_string: bool,
) -> Option<&'static str> {
    if name == "void" {
        return allow_void.then_some("void");
    }
    if name == "string" {
        return allow_string.then_some("string");
    }
    if name == "bool" {
        return Some("bool");
    }
    resolve_integer_type(name).map(|t| t.canonical_name.as_str())
}

/// `array<T, N>` resolved: the element type and the length.
#[derive(Debug, Clone, PartialEq)]
pub struct ArrayType {
    pub type_: &'static str,
    pub length: f64,
}

/// A module's array: [`ArrayType`] plus whether it is `const` (data) or `let` (RAM).
#[derive(Debug, Clone, PartialEq)]
pub struct ArrayInfo {
    pub type_: &'static str,
    pub length: f64,
    pub constant: bool,
}

/// How many arguments an own function takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Arity {
    pub min: usize,
    pub max: usize,
}

/// The `name` of a node that has a string `name` (an identifier or a type reference).
fn name_of(node: &Node) -> Option<&str> {
    match &node.kind {
        NodeKind::Identifier { name, .. } | NodeKind::TypeReference { name, .. } => Some(name),
        _ => None,
    }
}

fn type_arguments(node: &Node) -> &[Node] {
    match &node.kind {
        NodeKind::TypeReference { type_arguments, .. } => type_arguments,
        _ => &[],
    }
}

/// `array<T, N>` resolved: the element type and the length, or a reason it cannot be. `N` is a
/// literal or a const in `consts` (name to value).
pub fn resolve_array_type(
    annotation: Option<&Node>,
    consts: &IndexMap<String, f64>,
) -> Result<ArrayType, String> {
    let args = annotation.map_or(&[][..], type_arguments);
    let (element, size) = (args.first(), args.get(1));
    let ty = element
        .and_then(name_of)
        .filter(|name| !name.is_empty())
        .and_then(|name| resolve_scalar_type(name, false, false));
    let (Some(element), Some(ty)) = (element, ty) else {
        return Err("array<T, N> needs an integer or bool element type T".to_string());
    };
    if !type_arguments(element).is_empty() {
        return Err("array<T, N> needs an integer or bool element type T".to_string());
    }
    let mut length = None;
    if let Some(size) = size {
        match &size.kind {
            NodeKind::IntegerLiteral { value, .. } => length = Some(*value),
            NodeKind::TypeReference {
                name,
                type_arguments,
            } if type_arguments.is_empty() && consts.contains_key(name) => {
                length = Some(consts[name]);
            }
            _ => {}
        }
    }
    let Some(length) = length else {
        return Err(
            "array<T, N> needs a length N: an integer literal, or a const declared in this module"
                .to_string(),
        );
    };
    if length.fract() != 0.0
        || !length.is_finite()
        || length < 1.0
        || length > f64::from(MAX_ARRAY_LENGTH)
    {
        return Err(format!(
            "an array length must be 1..{MAX_ARRAY_LENGTH}, not {}",
            number_to_string(length)
        ));
    }
    Ok(ArrayType { type_: ty, length })
}

/// The type a `.length` folds to: the smallest unsigned type the number fits.
#[must_use]
pub fn type_for_count(n: f64) -> &'static str {
    if n <= 255.0 { "utinyint" } else { "usmallint" }
}

/// Decimal digits the widest value of an unsigned type needs: 255 -> 3, 65535 -> 5.
#[must_use]
pub fn digits_for(type_name: &str) -> Option<usize> {
    let ty = resolve_integer_type(type_name)?;
    if ty.signed || ty.bits > 16 {
        return None;
    }
    Some(ty.max.to_string().len())
}

/// Widest of two integer types, for the result of arithmetic on them. Ties keep the left type.
#[must_use]
pub fn wider_of(a: Option<&str>, b: Option<&str>) -> Option<String> {
    let ta = resolve_integer_type(a?)?;
    let tb = resolve_integer_type(b?)?;
    Some(
        if ta.bits >= tb.bits {
            &ta.canonical_name
        } else {
            &tb.canonical_name
        }
        .clone(),
    )
}

/// What `scanDeclaredTypes` reads from a module without a binder.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DeclaredTypes {
    pub global_types: IndexMap<String, String>,
    pub function_types: IndexMap<String, String>,
    pub array_types: IndexMap<String, ArrayInfo>,
    pub function_arity: IndexMap<String, Arity>,
}

/// The declared types of a module's top-level globals, consts, and functions (return types),
/// keyed by name.
#[must_use]
pub fn scan_declared_types(ast: Option<&Node>) -> DeclaredTypes {
    let mut out = DeclaredTypes::default();
    // Literal consts, in source order, so `array<u8, COUNT>` can be sized.
    let mut consts: IndexMap<String, f64> = IndexMap::new();
    let body: &[Node] = match ast.map(|n| &n.kind) {
        Some(NodeKind::Program { body }) => body,
        _ => &[],
    };
    for node in body {
        match &node.kind {
            NodeKind::VariableDeclaration {
                kind,
                name: Some(name),
                type_annotation: Some(annotation),
                initializer,
                ..
            } => {
                let var = name_of(name).unwrap_or_default();
                if kind == "const"
                    && let Some(init) = initializer
                    && let NodeKind::IntegerLiteral { value, .. } = &init.kind
                {
                    consts.insert(var.to_string(), *value);
                }
                let annotation_name = name_of(annotation).unwrap_or_default();
                if annotation_name == "array" {
                    if let Ok(resolved) = resolve_array_type(Some(annotation), &consts) {
                        out.array_types.insert(
                            var.to_string(),
                            ArrayInfo {
                                type_: resolved.type_,
                                length: resolved.length,
                                constant: kind == "const",
                            },
                        );
                    }
                    continue;
                }
                if annotation_name == "string" {
                    // A string const or a string<N>: `.length` is a byte either way.
                    out.global_types
                        .insert(var.to_string(), "string".to_string());
                    continue;
                }
                let scalar_name = if annotation_name == "volatile" {
                    type_arguments(annotation)
                        .first()
                        .and_then(name_of)
                        .unwrap_or_default()
                } else {
                    annotation_name
                };
                if let Some(ty) = resolve_scalar_type(scalar_name, false, false) {
                    out.global_types.insert(var.to_string(), ty.to_string());
                }
            }
            NodeKind::FunctionDeclaration {
                name: Some(name),
                params,
                return_type,
                ..
            } => {
                let fn_name = name_of(name).unwrap_or_default();
                let ret = return_type.as_deref().and_then(name_of).unwrap_or("void");
                if let Some(ty) = resolve_scalar_type(ret, true, false) {
                    out.function_types
                        .insert(fn_name.to_string(), ty.to_string());
                }
                let min = params
                    .iter()
                    .filter(|p| {
                        !matches!(
                            &p.kind,
                            NodeKind::Parameter {
                                default_value: Some(_),
                                ..
                            }
                        )
                    })
                    .count();
                out.function_arity.insert(
                    fn_name.to_string(),
                    Arity {
                        max: params.len(),
                        min,
                    },
                );
            }
            _ => {}
        }
    }
    out
}

/// The parameter types of a function declaration, keyed by name: the innermost scope a field
/// expression can name.
#[must_use]
pub fn parameter_types(function: &Node) -> IndexMap<String, String> {
    let mut out = IndexMap::new();
    let NodeKind::FunctionDeclaration { params, .. } = &function.kind else {
        return out;
    };
    for p in params {
        let NodeKind::Parameter {
            name,
            type_annotation,
            ..
        } = &p.kind
        else {
            continue;
        };
        let ty = type_annotation
            .as_deref()
            .and_then(name_of)
            .filter(|n| !n.is_empty())
            .and_then(|n| resolve_scalar_type(n, false, true));
        if let Some(ty) = ty {
            out.insert(
                name_of(name).unwrap_or_default().to_string(),
                ty.to_string(),
            );
        }
    }
    out
}

/// The four name-to-type maps a field expression is sized from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TypeScope {
    pub param_types: IndexMap<String, String>,
    pub global_types: IndexMap<String, String>,
    pub function_types: IndexMap<String, String>,
    pub array_types: IndexMap<String, ArrayInfo>,
}

/// The static type of an expression, as far as a module can tell on its own. `None` for
/// anything it cannot see.
#[must_use]
pub fn infer_type(node: &Node, scope: &TypeScope) -> Option<String> {
    let array_of = |object: &Node| -> Option<&ArrayInfo> {
        match &object.kind {
            NodeKind::Identifier { name, .. } if !scope.param_types.contains_key(name) => {
                scope.array_types.get(name)
            }
            _ => None,
        }
    };
    match &node.kind {
        NodeKind::IntegerLiteral { value, .. } => Some(
            if *value <= 255.0 {
                "utinyint"
            } else if *value <= 65535.0 {
                "usmallint"
            } else {
                "uint"
            }
            .to_string(),
        ),
        NodeKind::BooleanLiteral { .. } => Some("bool".to_string()),
        NodeKind::Identifier { name, .. } => scope
            .param_types
            .get(name)
            .or_else(|| scope.global_types.get(name))
            .cloned(),
        NodeKind::BinaryExpression {
            operator,
            left,
            right,
        } => {
            if COMPARISON_OPERATORS.contains(&operator.as_str()) {
                return Some("bool".to_string());
            }
            let l = infer_type(left, scope);
            let r = infer_type(right, scope);
            wider_of(l.as_deref(), r.as_deref())
        }
        NodeKind::UnaryExpression { operator, argument } => {
            if operator == "!" {
                Some("bool".to_string())
            } else {
                infer_type(argument, scope)
            }
        }
        NodeKind::IndexExpression { object, .. } => array_of(object).map(|a| a.type_.to_string()),
        NodeKind::MemberExpression { object, property } => {
            if name_of(property) != Some("length") {
                return None;
            }
            if let Some(array) = array_of(object) {
                return Some(type_for_count(array.length).to_string());
            }
            // `s.length` on a string (a parameter, const, or string<N>) is a byte.
            if matches!(object.kind, NodeKind::Identifier { .. })
                && infer_type(object, scope).as_deref() == Some("string")
            {
                Some("utinyint".to_string())
            } else {
                None
            }
        }
        NodeKind::CallExpression { callee, .. } => match &callee.kind {
            NodeKind::Identifier {
                name, compile_time, ..
            } if *compile_time != Some(true) => scope.function_types.get(name).cloned(),
            _ => None,
        },
        _ => None,
    }
}

/// Is this call the one shape a template may appear in: `namespace.print(cell, \`...\`)`,
/// exactly two arguments, the second a template?
#[must_use]
pub fn is_template_call(node: Option<&Node>) -> bool {
    let Some(node) = node else {
        return false;
    };
    let NodeKind::CallExpression { callee, args } = &node.kind else {
        return false;
    };
    let NodeKind::MemberExpression { object, property } = &callee.kind else {
        return false;
    };
    matches!(object.kind, NodeKind::Identifier { .. })
        && name_of(property) == Some("print")
        && args.len() == 2
        && matches!(args[1].kind, NodeKind::TemplateLiteral { .. })
}

/// The MISPLACED_TEMPLATE diagnostic for a template anywhere else.
#[must_use]
pub fn misplaced_template(template: &Node, file: &str, namespace: Option<&str>) -> Diagnostic {
    let message = match namespace.filter(|n| !n.is_empty()) {
        Some(namespace) => format!(
            "a template string is only valid as the second argument of {namespace}::print(cell, ...)"
        ),
        None => {
            "a template string is only valid as the second argument of a mod's print(cell, ...)"
                .to_string()
        }
    };
    diagnostic(
        codes::MISPLACED_TEMPLATE,
        message,
        file,
        template.start,
        template.length,
        Severity::Error,
    )
}

/// One laid-out piece of a template.
#[derive(Debug, Clone, PartialEq)]
pub enum Piece<'a> {
    Text {
        offset: u32,
        node: &'a Node,
    },
    Field {
        offset: u32,
        width: u32,
        node: &'a Node,
    },
}

/// The result of [`layout_template`].
#[derive(Debug, Clone, PartialEq)]
pub struct Layout<'a> {
    pub pieces: Vec<Piece<'a>>,
    pub diagnostics: Vec<Diagnostic>,
}

/// `source.slice(start, start + length)` over UTF-16 code units.
fn slice_utf16(source: &str, start: u32, length: u32) -> String {
    let units: Vec<u16> = source.encode_utf16().collect();
    let from = (start as usize).min(units.len());
    let to = (start as usize + length as usize).min(units.len());
    String::from_utf16_lossy(&units[from..to])
}

/// Lay a template out. Returns the pieces in order, each with the cell offset it starts at, and
/// the diagnostics that stopped any field.
#[must_use]
pub fn layout_template<'a>(
    template: &'a Node,
    scope: &TypeScope,
    file: &str,
    source: Option<&str>,
) -> Layout<'a> {
    let mut pieces = Vec::new();
    let mut diagnostics = Vec::new();
    let mut offset: u32 = 0;
    let NodeKind::TemplateLiteral { parts } = &template.kind else {
        return Layout {
            pieces,
            diagnostics,
        };
    };
    for part in parts {
        let (expression, part_width) = match &part.kind {
            NodeKind::TemplateText { value } => {
                pieces.push(Piece::Text { offset, node: part });
                // JS offsets are f64 and never wrap; saturate rather than overflow.
                offset = offset.saturating_add(u32::try_from(utf16_len(value)).unwrap_or(u32::MAX));
                continue;
            }
            NodeKind::TemplateField { expression, width } => (expression, width.as_deref()),
            _ => continue,
        };
        let width: u32;
        if let Some(w) = part_width {
            let value = match &w.kind {
                NodeKind::IntegerLiteral { value, .. } => *value,
                _ => f64::NAN,
            };
            if value < 1.0 || value > f64::from(MAX_STRING_LENGTH) {
                diagnostics.push(diagnostic(
                    codes::UNPRINTABLE_FIELD,
                    format!(
                        "a field width must be 1..{MAX_STRING_LENGTH}, not {}",
                        number_to_string(value)
                    ),
                    file,
                    w.start,
                    w.length,
                    Severity::Error,
                ));
                continue;
            }
            width = value as u32;
        } else {
            let ty = infer_type(expression, scope);
            let digits = ty.as_deref().and_then(digits_for);
            let Some(digits) = digits else {
                let quoted = match source.filter(|s| !s.is_empty()) {
                    Some(s) => slice_utf16(s, expression.start, expression.length),
                    None => "...".to_string(),
                };
                diagnostics.push(diagnostic(
                    codes::UNPRINTABLE_FIELD,
                    match &ty {
                        Some(ty) => format!(
                            "a {ty} cannot be a number field: fields show unsigned values up to 16 bits (utinyint, usmallint)"
                        ),
                        None => format!(
                            "this field's width cannot be taken from its expression here; say it: ${{{quoted}:3}}"
                        ),
                    },
                    file,
                    part.start,
                    part.length,
                    Severity::Error,
                ));
                continue;
            };
            width = digits as u32;
        }
        pieces.push(Piece::Field {
            offset,
            width,
            node: part,
        });
        offset = offset.saturating_add(width);
    }
    Layout {
        pieces,
        diagnostics,
    }
}
