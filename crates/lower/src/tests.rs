//! Test lowering (test spec 3.3): a `TestDecl` becomes a private `__test_<k>(): void`, an
//! `Assert` becomes the shapes that call `__8bs_test_fail<W>`, and everything the binary must
//! not carry (names, spans, text, messages, operand types) goes to a sidecar.
//!
//! Only a lowering started with [`TestLowering`] does any of this. A normal build never sees a
//! `TestDecl`, `Assert` or `Fail`: the parser strips the declarations, and the macros are
//! reported outside a test.

use jsnum::Nullable;
use mos_ir::{Binop, Call, Const, Expr, Function, If, Local, Ref, Stmt, Unop};
use sema::types::resolve_integer_type;
use serde::{Deserialize, Serialize};
use syntax::{Node, NodeKind};

use crate::module::{Lowering, type_of};

const COMPARISONS: [&str; 6] = ["==", "!=", "<", "<=", ">", ">="];

/// Where the numbering of a lowering starts: the counts of the modules lowered before it, so
/// `k` and `id` are global over the module load order.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TestLowering {
    pub first_test: u32,
    pub first_assert: u32,
}

/// `tests[]` of the sidecar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestRecord {
    pub k: u32,
    pub name: String,
    pub file: String,
    pub start: u32,
    pub length: u32,
    pub line: u32,
}

/// `asserts[]` of the sidecar. `type` is `None` and `width` 0 when the assert has no operands
/// the runner can print.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssertRecord {
    pub id: u32,
    pub file: String,
    pub start: u32,
    pub length: u32,
    pub line: u32,
    pub column: u32,
    pub text: String,
    pub message: Option<String>,
    #[serde(rename = "type")]
    pub ty: Option<String>,
    pub width: u32,
    pub signed: bool,
}

/// What a test lowering records besides IR: `{version, tests, asserts}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestSidecar {
    pub version: u32,
    pub tests: Vec<TestRecord>,
    pub asserts: Vec<AssertRecord>,
}

impl Default for TestSidecar {
    fn default() -> Self {
        Self {
            version: 1,
            tests: Vec::new(),
            asserts: Vec::new(),
        }
    }
}

/// The counters and records of a lowering in test mode.
#[derive(Debug, Default)]
pub struct TestState {
    pub next_test: u32,
    pub next_assert: u32,
    pub sidecar: TestSidecar,
}

impl TestState {
    #[must_use]
    pub fn new(first: TestLowering) -> Self {
        Self {
            next_test: first.first_test,
            next_assert: first.first_assert,
            sidecar: TestSidecar::default(),
        }
    }
}

/// `source.slice(start, start + length)` over UTF-16 code units.
fn slice_utf16(source: &str, start: u32, length: u32) -> String {
    let units: Vec<u16> = source.encode_utf16().collect();
    let from = (start as usize).min(units.len());
    let to = (start as usize + length as usize).min(units.len());
    String::from_utf16_lossy(&units[from..to])
}

/// The 1-based line and column of a UTF-16 offset.
fn line_column(source: &str, offset: u32) -> (u32, u32) {
    let mut line = 1u32;
    let mut column = 1u32;
    for (i, unit) in source.encode_utf16().enumerate() {
        if i >= offset as usize {
            break;
        }
        if unit == 0x0A {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line, column)
}

/// The width the runner prints a pair of operands at: 8, 16 or 32 bits, 24 widening to 32.
/// `None` when either type is not a known integer or bool (an import's, say).
fn operand_width(left: Option<&str>, right: Option<&str>) -> Option<(u32, bool, String)> {
    let one = |ty: &str| -> Option<(u32, bool, String)> {
        if ty == "bool" {
            return Some((8, false, "bool".to_string()));
        }
        let t = resolve_integer_type(ty)?;
        Some((t.bits, t.signed, t.canonical_name.clone()))
    };
    let a = one(left?)?;
    let b = one(right?)?;
    let wider = if a.0 >= b.0 { a } else { b };
    let width = match wider.0 {
        0..=8 => 8,
        9..=16 => 16,
        _ => 32,
    };
    Some((width, wider.1, wider.2))
}

impl Lowering {
    fn test_const(&self, value: u32) -> Expr {
        Expr::Const(Const {
            value: i64::from(value),
            ty: resolve_integer_type("u16").map(|t| t.canonical_name.clone()),
        })
    }

    fn fail_call(&self, width: u32, args: Vec<Expr>, node: &Node) -> Stmt {
        Stmt::Call(Call {
            name: format!("__8bs_test_fail{width}"),
            args,
            ty: Nullable::Null,
            start: Some(i64::from(node.start)),
            length: Some(i64::from(node.length)),
            instance: None,
        })
    }

    /// `#[test] fn` as `__test_<k>(): void`, added to `functions`.
    pub fn test_declaration(&mut self, node: &Node) {
        let NodeKind::TestDecl { name, body } = &node.kind else {
            return;
        };
        let Some(state) = self.tests.as_mut() else {
            self.report(node, "a test is built only by '8bs test'");
            return;
        };
        let k = state.next_test;
        state.next_test += 1;
        let (line, _) = self
            .source
            .as_deref()
            .map_or((1, 1), |s| line_column(s, node.start));
        let file = self.file.clone();
        if let Some(state) = self.tests.as_mut() {
            state.sidecar.tests.push(TestRecord {
                k,
                name: name.clone(),
                file,
                start: node.start,
                length: node.length,
                line,
            });
        }
        let outer_return = self.current_return_type.replace("void".to_string());
        let outer_params = std::mem::take(&mut self.current_params);
        let outer_arrays = std::mem::take(&mut self.current_array_params);
        let outer_block = self.block_names.replace(indexmap::IndexSet::new());
        let body = self.function_body(Some(body));
        self.block_names = outer_block;
        self.current_return_type = outer_return;
        self.current_params = outer_params;
        self.current_array_params = outer_arrays;
        self.functions.push(Function {
            name: format!("__test_{k}"),
            exported: false,
            component: Some(false),
            state: None,
            owner: Nullable::Null,
            method: Some(false),
            media_bind: None,
            params: Vec::new(),
            return_type: "void".to_string(),
            body,
            start: i64::from(node.start),
            length: i64::from(node.length),
            file: None,
        });
    }

    /// Record one assert and return its id.
    fn record_assert(
        &mut self,
        node: &Node,
        text: String,
        message: Option<String>,
        shape: Option<(u32, bool, String)>,
    ) -> u32 {
        let (line, column) = self
            .source
            .as_deref()
            .map_or((1, node.start + 1), |s| line_column(s, node.start));
        let file = self.file.clone();
        let Some(state) = self.tests.as_mut() else {
            return 0;
        };
        let id = state.next_assert;
        state.next_assert += 1;
        let (width, signed, ty) = match shape {
            Some((w, s, t)) => (w, s, Some(t)),
            None => (0, false, None),
        };
        state.sidecar.asserts.push(AssertRecord {
            id,
            file,
            start: node.start,
            length: node.length,
            line,
            column,
            text,
            message,
            ty,
            width,
            signed,
        });
        id
    }

    fn source_text(&self, node: &Node) -> String {
        self.source
            .as_deref()
            .map_or_else(String::new, |s| slice_utf16(s, node.start, node.length))
    }

    /// `Assert` and `Fail` as the statements they lower to; empty when one did not lower
    /// (what was wrong has been reported).
    pub fn test_macro(&mut self, node: &Node) -> Vec<Stmt> {
        if self.tests.is_none() {
            self.report(
                node,
                format!("a {} statement is not compilable yet", node.type_name()),
            );
            return Vec::new();
        }
        match &node.kind {
            NodeKind::Fail { message } => {
                let text = self.source_text(node);
                let id = self.record_assert(node, text, message.clone(), None);
                let id = self.test_const(id);
                vec![self.fail_call(0, vec![id], node)]
            }
            NodeKind::Assert { test, message } => self.assertion(node, test, message.clone()),
            _ => Vec::new(),
        }
    }

    fn assertion(&mut self, node: &Node, test: &Node, message: Option<String>) -> Vec<Stmt> {
        let span = (Some(i64::from(node.start)), Some(i64::from(node.length)));
        let not = |argument: Expr| {
            Expr::Unop(Unop {
                operator: "!".to_string(),
                argument: Box::new(argument),
                ty: Some("bool".to_string()),
            })
        };
        if let NodeKind::BinaryExpression {
            operator,
            left,
            right,
        } = &test.kind
            && COMPARISONS.contains(&operator.as_str())
        {
            let l = self.expression(Some(left));
            let r = self.expression(Some(right));
            let (Some(l), Some(r)) = (l, r) else {
                return Vec::new();
            };
            let text = format!(
                "{} {operator} {}",
                self.source_text(left),
                self.source_text(right)
            );
            let shape = operand_width(type_of(&l), type_of(&r));
            let types = (
                type_of(&l).map(str::to_string),
                type_of(&r).map(str::to_string),
            );
            let (Some(shape), (Some(lt), Some(rt))) = (shape, types) else {
                // An operand typed by an import: the runner cannot print it, so the plain
                // shape, with the same single evaluation of each operand.
                let id = self.record_assert(node, text, message, None);
                let cond = Expr::Binop(Binop {
                    operator: operator.clone(),
                    left: Box::new(l),
                    right: Box::new(r),
                    ty: Some("bool".to_string()),
                });
                let id = self.test_const(id);
                return vec![self.guard(not(cond), vec![self.fail_call(0, vec![id], node)], span)];
            };
            let width = shape.0;
            let id = self.record_assert(node, text, message, Some(shape));
            let (a, b) = (format!("__a{id}"), format!("__b{id}"));
            let local = |name: &str, ty: String, init: Expr| {
                Stmt::Local(Local {
                    name: name.to_string(),
                    ty,
                    init,
                    inlined: None,
                    start: span.0,
                    length: span.1,
                })
            };
            let reference = |name: &str, ty: &str| {
                Expr::Ref(Ref {
                    name: name.to_string(),
                    ty: Nullable::Value(ty.to_string()),
                    start: span.0,
                    length: span.1,
                })
            };
            let cond = Expr::Binop(Binop {
                operator: operator.clone(),
                left: Box::new(reference(&a, &lt)),
                right: Box::new(reference(&b, &rt)),
                ty: Some("bool".to_string()),
            });
            let call = self.fail_call(
                width,
                vec![self.test_const(id), reference(&a, &lt), reference(&b, &rt)],
                node,
            );
            return vec![
                local(&a, lt, l),
                local(&b, rt, r),
                self.guard(not(cond), vec![call], span),
            ];
        }
        let Some(cond) = self.expression(Some(test)) else {
            return Vec::new();
        };
        let text = self.source_text(test);
        let id = self.record_assert(node, text, message, None);
        let id = self.test_const(id);
        vec![self.guard(not(cond), vec![self.fail_call(0, vec![id], node)], span)]
    }

    #[allow(clippy::unused_self)]
    fn guard(&self, test: Expr, then: Vec<Stmt>, span: (Option<i64>, Option<i64>)) -> Stmt {
        Stmt::If(If {
            test,
            then,
            r#else: None,
            start: span.0.unwrap_or(0),
            length: span.1.unwrap_or(0),
        })
    }
}
