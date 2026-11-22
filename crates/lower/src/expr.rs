//! Port of packages/compiler/src/ir/index.mjs:1386-1563 (`lower::expr`)
//!
//! An AST expression as IR, with the call arm that lands with call lowering.

use jsnum::{Nullable, number_to_string};
use mos_ir::{
    Binop, Cond, Const, Expr, NamespaceConst, Record, RecordField, Ref, StringByte, StringLength,
    StringLiteral, Unop,
};
use sema::templates::{COMPARISON_OPERATORS, misplaced_template, type_for_count, wider_of};
use sema::types::narrowest_integer_type;
use syntax::{Node, NodeKind};

use crate::module::{Lowering, int, is_wide, name_of, nullable, span, type_of, wide_of};
use crate::stmt::CallIr;

impl Lowering {
    /// A constant as JS prints it in a message: the number it held, not its saturated IR value.
    pub(crate) fn shown(&self, value: i64) -> String {
        match self.last_wide {
            Some(wide) if is_wide(value) => number_to_string(wide),
            _ => number_to_string(value as f64),
        }
    }

    /// An AST expression as IR (`expression(node)`, `ir/index.mjs:1386`).
    #[allow(clippy::too_many_lines)]
    pub fn expression(&mut self, node: Option<&Node>) -> Option<Expr> {
        let node = node?; // a hole the parser already reported
        match &node.kind {
            NodeKind::IntegerLiteral { value, .. } => {
                self.last_wide = wide_of(*value);
                Some(Expr::Const(Const {
                    value: int(*value),
                    ty: Some(narrowest_integer_type(*value)),
                }))
            }
            NodeKind::BooleanLiteral { value, .. } => Some(Expr::Const(Const {
                value: i64::from(*value),
                ty: Some("bool".to_string()),
            })),
            NodeKind::StringLiteral { value, .. } => Some(self.string_constant(node, value)),
            NodeKind::TemplateLiteral { .. } => {
                self.diagnostics
                    .push(misplaced_template(node, &self.file, None));
                None
            }
            NodeKind::IndexExpression { object, index } => {
                // `s[i]`: the i-th byte of a string parameter; otherwise `a[i]`.
                if let NodeKind::Identifier { name, .. } = &object.kind
                    && self.is_string_parameter(name)
                {
                    let index = self.expression(index.as_deref())?;
                    return Some(Expr::StringByte(StringByte {
                        string: Box::new(self.string_ref(object)),
                        index: Box::new(index),
                        ty: "utinyint".to_string(),
                    }));
                }
                self.index_read(node)
            }
            NodeKind::ArrayLiteral { .. } => self.fail(
                node,
                "an array literal only initializes an array<T, N> declaration",
            ),
            NodeKind::Identifier { name, .. } => self.identifier(node, name),
            NodeKind::ConditionalExpression {
                test,
                consequent,
                alternate,
            } => {
                let test = self.expression(Some(test));
                let consequent = self.expression(consequent.as_deref());
                let alternate = self.expression(alternate.as_deref());
                let (test, consequent, alternate) = (test?, consequent?, alternate?);
                let ty = wider_of(type_of(&consequent), type_of(&alternate));
                Some(Expr::Cond(Cond {
                    test: Box::new(test),
                    consequent: Box::new(consequent),
                    alternate: Box::new(alternate),
                    ty: nullable(ty),
                }))
            }
            NodeKind::BinaryExpression {
                operator,
                left,
                right,
            } => {
                let left = self.expression(Some(left));
                let right = self.expression(Some(right));
                let (left, right) = (left?, right?);
                // Comparisons and the logical operators always produce a bool.
                let ty = if COMPARISON_OPERATORS.contains(&operator.as_str()) {
                    Some("bool".to_string())
                } else {
                    wider_of(type_of(&left), type_of(&right))
                };
                Some(Expr::Binop(Binop {
                    operator: operator.clone(),
                    left: Box::new(left),
                    right: Box::new(right),
                    ty,
                }))
            }
            NodeKind::UnaryExpression { operator, argument } => {
                let argument = self.expression(Some(argument))?;
                // A signed literal is written `-128`, so a negated constant has to be a
                // constant. Only `-`/`+`; `~` and `!` are left to the target.
                if let Expr::Const(c) = &argument
                    && (operator == "-" || operator == "+")
                {
                    let value = if operator == "-" {
                        self.last_wide = self.last_wide.map(|w| -w);
                        c.value.saturating_neg()
                    } else {
                        c.value
                    };
                    // The value's own sign decides its type here, not the operand's.
                    return Some(Expr::Const(Const {
                        value,
                        ty: Some(narrowest_integer_type(value as f64)),
                    }));
                }
                let ty = if operator == "!" {
                    Some("bool".to_string())
                } else {
                    type_of(&argument).map(str::to_string)
                };
                Some(Expr::Unop(Unop {
                    operator: operator.clone(),
                    argument: Box::new(argument),
                    ty,
                }))
            }
            NodeKind::CallExpression { .. } => {
                let call = self.call_expression(node)?;
                match call {
                    CallIr::MemoryWrite(_) => self.fail(
                        node,
                        "memory.write does not return a value and cannot be used as an expression",
                    ),
                    CallIr::WaitFrame(_) => self.fail(
                        node,
                        "waitFrame() does not return a value and cannot be used as an expression",
                    ),
                    other => other.into_expr(),
                }
            }
            NodeKind::RecordLiteral { properties } => {
                let mut fields = Vec::new();
                for prop in properties {
                    let NodeKind::RecordProperty { key, value } = &prop.kind else {
                        continue;
                    };
                    let value = self.expression(Some(value))?;
                    fields.push(RecordField {
                        name: key.clone(),
                        value,
                        start: i64::from(prop.start),
                        length: i64::from(prop.length),
                    });
                }
                Some(Expr::Record(Record {
                    fields,
                    start: i64::from(node.start),
                    length: i64::from(node.length),
                }))
            }
            NodeKind::MemberExpression { object, property } => {
                self.member_expression(node, object, property)
            }
            _ => self.fail(
                node,
                format!("a {} expression is not compilable yet", node.type_name()),
            ),
        }
    }

    /// The `Identifier` arm of `expression`.
    pub(crate) fn identifier(&mut self, node: &Node, name: &str) -> Option<Expr> {
        let shadowed = self.current_params.contains_key(name);
        // A const declared in this module is its value, here and now — but a parameter of the
        // same name shadows it, ordinary lexical scoping.
        if !shadowed && let Some(value) = self.own_consts.get(name) {
            self.last_wide = wide_of(*value);
            return Some(Expr::Const(Const {
                value: int(*value),
                ty: self.own_const_types.get(name).cloned(),
            }));
        }
        if !shadowed && let Some(index) = self.own_strings.get(name) {
            let (start, length) = span(node);
            return Some(Expr::String(StringLiteral {
                index: *index,
                ty: Nullable::Value("string".to_string()),
                start,
                length,
            }));
        }
        // An array is used one element at a time; its bare name is not a value.
        if !shadowed && self.arrays.contains_key(name) {
            return self.fail(
                node,
                format!("'{name}' is an array: read an element ({name}[i]) or its .length"),
            );
        }
        if self.current_array_params.contains_key(name) {
            return self.fail(
                node,
                format!(
                    "'{name}' is an array parameter: read an element ({name}[i]) or its .length"
                ),
            );
        }
        // The span rides along so the linker can point a diagnostic at the exact reference.
        // Its type comes from wherever the name is declared; an imported name stays untyped.
        let (start, length) = span(node);
        Some(Expr::Ref(Ref {
            name: name.to_string(),
            ty: nullable(
                self.current_params
                    .get(name)
                    .or_else(|| self.global_types.get(name))
                    .cloned(),
            ),
            start,
            length,
        }))
    }

    /// The `MemberExpression` arm of `expression`.
    pub(crate) fn member_expression(
        &mut self,
        node: &Node,
        object: &Node,
        property: &Node,
    ) -> Option<Expr> {
        let property_name = name_of(property).unwrap_or_default();
        let (start, length) = (i64::from(node.start), i64::from(node.length));
        let NodeKind::Identifier {
            name: object_name, ..
        } = &object.kind
        else {
            if property_name == "length" {
                let inner = self.expression(Some(object))?;
                return Some(Expr::StringLength(StringLength {
                    string: Box::new(inner),
                    ty: "utinyint".to_string(),
                    start: Some(start),
                    length: Some(length),
                }));
            }
            return self.fail(node, "a member expression is not compilable yet");
        };
        // `s.length`: how many bytes a string parameter holds.
        if self.is_string_parameter(object_name) {
            if property_name != "length" {
                return self.fail(
                    node,
                    format!("a string has no '{property_name}'; it has .length and s[i]"),
                );
            }
            return Some(Expr::StringLength(StringLength {
                string: Box::new(self.string_ref(object)),
                ty: "utinyint".to_string(),
                start: None,
                length: None,
            }));
        }
        // `t.length` on an array parameter: the length is part of the parameter's type.
        if let Some(p) = self.current_array_params.get(object_name) {
            let length = p.length;
            if property_name != "length" {
                return self.fail(
                    node,
                    format!("an array has no '{property_name}'; it has .length and a[i]"),
                );
            }
            return Some(Expr::Const(Const {
                value: int(length),
                ty: Some(type_for_count(length).to_string()),
            }));
        }
        // `a.length` on this module's own array: a number, right here.
        if !self.current_params.contains_key(object_name)
            && let Some(array) = self.arrays.get(object_name)
        {
            let length = array.length;
            if property_name != "length" {
                return self.fail(
                    node,
                    format!("an array has no '{property_name}'; it has .length and a[i]"),
                );
            }
            return Some(Expr::Const(Const {
                value: int(length),
                ty: Some(type_for_count(length).to_string()),
            }));
        }
        // `BorderColor.BLUE`: a namespace const used as a value, resolved by the linker.
        Some(Expr::NamespaceConst(NamespaceConst {
            namespace: object_name.clone(),
            member: property_name.to_string(),
            ty: Nullable::Null,
            start,
            length,
        }))
    }
}
