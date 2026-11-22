//! Port of packages/compiler/src/ir/index.mjs:900-1385 (`lower::stmt`)
//!
//! Statements, calls and the intrinsics, assignments and `++`/`--`, and the scoping around
//! them (`block`, `scoped`, `local`, `forStatement`).
//!
//! The IR types have no statement form of `port.read(...)` and no expression form of
//! `port.write(...)` (the JS produces both, and no backend reads either there). Lowering
//! either one in that position gives `None` with no diagnostic; `oracle/divergences.toml`
//! names it.

use diagnostics::codes;
use jsnum::Nullable;
use mos_ir::{
    Asm, Assign, Binop, Block, Break, Call, Const, Continue, Expr, For, If, Index, Local,
    MemoryRead, MemoryWrite, NamespaceCall, PortRead, PortWrite, Ref, Return, Stmt, StoreIndex,
    WaitFrame, While,
};
use sema::templates::{resolve_scalar_type, wider_of};
use sema::types::resolve_integer_type;
use syntax::{Node, NodeKind};

use crate::module::{Lowering, name_of, nullable, span, type_arguments, type_of};

/// What `callExpression` returns: a node that is a statement or an expression, by where the
/// call stands.
#[derive(Debug, Clone, PartialEq)]
pub enum CallIr {
    Call(Call),
    NamespaceCall(NamespaceCall),
    MemoryRead(MemoryRead),
    MemoryWrite(MemoryWrite),
    PortRead(PortRead),
    PortWrite(PortWrite),
    WaitFrame(WaitFrame),
}

impl CallIr {
    /// The call as a statement.
    #[must_use]
    pub fn into_stmt(self) -> Option<Stmt> {
        match self {
            CallIr::Call(c) => Some(Stmt::Call(c)),
            CallIr::NamespaceCall(c) => Some(Stmt::NamespaceCall(c)),
            CallIr::MemoryRead(c) => Some(Stmt::MemoryRead(c)),
            CallIr::MemoryWrite(c) => Some(Stmt::MemoryWrite(c)),
            CallIr::PortWrite(c) => Some(Stmt::PortWrite(c)),
            CallIr::WaitFrame(c) => Some(Stmt::WaitFrame(c)),
            CallIr::PortRead(c) => Some(Stmt::PortRead(c)),
        }
    }

    /// The call as an expression. `None` for `memory.write` and `waitFrame`, which the caller refuses first.
    #[must_use]
    pub fn into_expr(self) -> Option<Expr> {
        match self {
            CallIr::Call(c) => Some(Expr::Call(c)),
            CallIr::NamespaceCall(c) => Some(Expr::NamespaceCall(c)),
            CallIr::MemoryRead(c) => Some(Expr::MemoryRead(c)),
            CallIr::PortRead(c) => Some(Expr::PortRead(c)),
            CallIr::PortWrite(c) => Some(Expr::PortWrite(Box::new(c))),
            CallIr::MemoryWrite(_) | CallIr::WaitFrame(_) => None,
        }
    }
}

fn int_span(node: &Node) -> (i64, i64) {
    (i64::from(node.start), i64::from(node.length))
}

impl Lowering {
    /// A function's body: its own scope, but the block the parameters are declared in.
    pub fn function_body(&mut self, node: Option<&Node>) -> Vec<Stmt> {
        let outer = self.current_params.clone();
        let out = self.statements(node);
        self.current_params = outer;
        out
    }

    /// The statements of a block node, each lowered; a statement that did not lower is dropped.
    fn statements(&mut self, node: Option<&Node>) -> Vec<Stmt> {
        let mut out = Vec::new();
        if let Some(Node {
            kind: NodeKind::BlockStatement { body },
            ..
        }) = node
        {
            for statement in body {
                if let Some(lowered) = self.statement(Some(statement)) {
                    out.push(lowered);
                }
            }
        }
        out
    }

    pub fn block(&mut self, node: Option<&Node>) -> Vec<Stmt> {
        self.scoped(|this| this.statements(node))
    }

    /// Run `f` with a copy of the current names-in-scope, so a local declared inside a block is
    /// not visible after it: block scoping, the same rule C applies to block-scoped locals.
    pub fn scoped<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> T {
        let outer = self.current_params.clone();
        let outer_block = self.block_names.replace(indexmap::IndexSet::new());
        let out = f(self);
        self.current_params = outer;
        self.block_names = outer_block;
        out
    }

    /// `let i: utinyint = 0;` inside a function: a local, storage that exists while the
    /// function runs. A `const` here is refused.
    pub fn local(&mut self, node: &Node) -> Option<Stmt> {
        let NodeKind::VariableDeclaration {
            kind,
            name,
            type_annotation,
            initializer,
            ..
        } = &node.kind
        else {
            return None;
        };
        // The parser reported the missing name.
        let name_node = name.as_deref()?;
        let name = name_of(name_node).unwrap_or_default().to_string();
        if kind == "const" {
            return self.fail(
                node,
                "a const is a compile-time value declared at the top level of a module, not inside a fn",
            );
        }
        let Some(annotation) = type_annotation.as_deref() else {
            return self.fail(node, "a local needs an explicit type to be compilable");
        };
        let annotation_name = name_of(annotation).unwrap_or_default();
        if annotation_name == "array" {
            return self.fail(
                annotation,
                "a local array is not compilable yet: declare the array at the top level",
            );
        }
        let resolved = resolve_scalar_type(annotation_name, false, false);
        let Some(ty) = resolved.filter(|_| type_arguments(annotation).is_empty()) else {
            return self.fail(
                annotation,
                format!(
                    "a local of type {annotation_name} is not compilable yet: an integer or bool"
                ),
            );
        };
        if let Some(decorator) = node.decorators.as_ref().and_then(|d| d.first()) {
            let decorator_name = match &decorator.kind {
                NodeKind::Decorator { name, .. } => name.as_str(),
                _ => "",
            };
            return self.fail(
                decorator,
                format!(
                    "@{decorator_name} does not belong on a local — @address maps hardware and belongs on a top-level declaration; @unroll belongs on a for loop"
                ),
            );
        }
        // One declaration per name per block: the same rule C enforces, reported here instead.
        if self.block_names.as_ref().is_some_and(|b| b.contains(&name)) {
            return self.fail(
                name_node,
                format!("'{name}' is already declared in this block"),
            );
        }
        // Left off, a local starts at 0 typed as itself.
        let init = if let Some(initializer) = initializer.as_deref() {
            self.expression(Some(initializer))?
        } else {
            Expr::Const(Const {
                value: 0,
                ty: Some(ty.to_string()),
            })
        };
        if matches!(init, Expr::String(_)) {
            return self.fail(
                initializer.as_deref().unwrap_or(node),
                format!(
                    "a string cannot initialize a {ty}: a string lives in a string<N> or a const"
                ),
            );
        }
        // In scope from here on: shadows a global, const, or array of the name.
        self.current_params.insert(name.clone(), ty.to_string());
        if let Some(b) = self.block_names.as_mut() {
            b.insert(name.clone());
        }
        let (start, length) = span(name_node);
        Some(Stmt::Local(Local {
            name,
            ty: ty.to_string(),
            init,
            inlined: None,
            start,
            length,
        }))
    }

    /// `for (let i: u8 = 0; i < 4; i++) { ... }`, emitted as the target's own `for`.
    pub fn for_statement(&mut self, node: &Node) -> Option<Stmt> {
        self.scoped(|this| {
            let NodeKind::ForStatement {
                init: init_node,
                test: test_node,
                update: update_node,
                body,
            } = &node.kind
            else {
                return None;
            };
            let mut init = None;
            if let Some(init_node) = init_node.as_deref() {
                let lowered = if matches!(init_node.kind, NodeKind::VariableDeclaration { .. }) {
                    this.local(init_node)
                } else {
                    this.expression_as_statement(Some(init_node), "a for initializer")
                };
                init = Some(lowered?);
            }
            let test = match test_node.as_deref() {
                Some(t) => Some(this.expression(Some(t))?),
                None => None,
            };
            let mut update = None;
            if let Some(update_node) = update_node.as_deref() {
                update = Some(this.expression_as_statement(Some(update_node), "a for update")?);
            }
            let body = this.block_or_statement(body.as_deref());
            // `@unroll`: only the name and the arity are checkable here; the linker decides the
            // rest once every const is inlined.
            let mut unroll = false;
            for decorator in node.decorators.iter().flatten() {
                let (name, args) = match &decorator.kind {
                    NodeKind::Decorator { name, args } => (name.as_str(), args.len()),
                    _ => ("", 0),
                };
                if name != "unroll" {
                    return this.fail(
                        decorator,
                        format!("@{name} is not a loop decorator — only @unroll is"),
                    );
                }
                if args > 0 {
                    return this.fail(
                        decorator,
                        "@unroll takes no arguments yet: it fully unrolls the loop, however many iterations that is",
                    );
                }
                unroll = true;
            }
            let (start, length) = span(node);
            Some(Stmt::For(For {
                init: init.map_or(Nullable::Null, |s| Nullable::Value(Box::new(s))),
                test: test.map_or(Nullable::Null, Nullable::Value),
                update: update.map_or(Nullable::Null, |s| Nullable::Value(Box::new(s))),
                body,
                unroll: Some(unroll),
                start,
                length,
            }))
        })
    }

    /// An expression in statement position: an assignment, `++`/`--`, or a call.
    pub fn expression_as_statement(&mut self, e: Option<&Node>, what: &str) -> Option<Stmt> {
        let e = e?;
        match &e.kind {
            NodeKind::AssignmentExpression { .. } => self.assignment(e),
            NodeKind::UpdateExpression { .. } => self.update(e),
            NodeKind::CallExpression { .. } => self.call_expression(e)?.into_stmt(),
            _ => self.fail(
                e,
                format!(
                    "{what} is an assignment, ++/--, or a call, not a {}",
                    e.type_name()
                ),
            ),
        }
    }

    pub fn statement(&mut self, node: Option<&Node>) -> Option<Stmt> {
        // A hole the parser left behind has already been reported.
        let node = node?;
        // A decorator on any statement but a `for` (`@unroll`) or a `let`/`const` (which `local`
        // refuses with its own message) would otherwise be dropped silently.
        if let Some(decorator) = node.decorators.as_ref().and_then(|d| d.first())
            && !matches!(
                node.kind,
                NodeKind::ForStatement { .. } | NodeKind::VariableDeclaration { .. }
            )
        {
            let name = match &decorator.kind {
                NodeKind::Decorator { name, .. } => name.as_str(),
                _ => "",
            };
            return self.fail(
                decorator,
                format!(
                    "@{name} does not belong here — only @address on a top-level declaration and @unroll on a for loop are compilable"
                ),
            );
        }
        let (start, length) = int_span(node);
        match &node.kind {
            NodeKind::ExpressionStatement { expression: e } => match &e.kind {
                NodeKind::AssignmentExpression { .. } => self.assignment(e),
                NodeKind::UpdateExpression { .. } => self.update(e),
                NodeKind::CallExpression { args, .. } => {
                    // A template string as the last argument is laid out into calls here: a
                    // statement, since it expands to several.
                    if args
                        .last()
                        .is_some_and(|a| matches!(a.kind, NodeKind::TemplateLiteral { .. }))
                    {
                        return self.template_call(e);
                    }
                    self.call_expression(e)?.into_stmt()
                }
                _ => self.fail(
                    node,
                    format!("a bare {} statement is not compilable yet", e.type_name()),
                ),
            },
            NodeKind::VariableDeclaration { .. } => self.local(node),
            NodeKind::ForStatement { .. } => self.for_statement(node),
            NodeKind::IfStatement {
                test,
                consequent,
                alternate,
            } => {
                let test = self.expression(test.as_deref());
                let then = match consequent.as_deref() {
                    Some(c) => self.block_or_statement(Some(c)),
                    None => Vec::new(),
                };
                let otherwise = alternate
                    .as_deref()
                    .map(|a| self.block_or_statement(Some(a)));
                Some(Stmt::If(If {
                    test: test?,
                    then,
                    r#else: otherwise,
                    start,
                    length,
                }))
            }
            NodeKind::WhileStatement { test, body } => {
                let test = self.expression(test.as_deref());
                let body = self.block_or_statement(body.as_deref());
                Some(Stmt::While(While {
                    test: test?,
                    body,
                    start,
                    length,
                }))
            }
            NodeKind::ReturnStatement { argument } => {
                if let Some(argument) = argument.as_deref() {
                    if self.current_return_type.as_deref() == Some("void") {
                        return self
                            .fail(node, "a fn declared to return void cannot return a value");
                    }
                    let value = self.expression(Some(argument))?;
                    return Some(Stmt::Return(Return {
                        value: Some(value),
                        start,
                        length,
                    }));
                }
                if let Some(ty) = self.current_return_type.as_deref()
                    && !ty.is_empty()
                    && ty != "void"
                {
                    let message = format!("this fn must return a value of type {ty}");
                    return self.fail(node, message);
                }
                Some(Stmt::Return(Return {
                    value: None,
                    start,
                    length,
                }))
            }
            NodeKind::BreakStatement {} => Some(Stmt::Break(Break { start, length })),
            NodeKind::ContinueStatement {} => Some(Stmt::Continue(Continue { start, length })),
            NodeKind::AsmBlock { body } => {
                // `body.slice(1, -1)`: the braces off, by UTF-16 unit.
                let units: Vec<u16> = body.encode_utf16().collect();
                let text = if units.len() >= 2 {
                    String::from_utf16_lossy(&units[1..units.len() - 1])
                } else {
                    String::new()
                };
                Some(Stmt::Asm(Asm {
                    text,
                    start,
                    length,
                }))
            }
            NodeKind::BlockStatement { .. } => {
                let body = self.block(Some(node));
                Some(Stmt::Block(Block {
                    body,
                    origin: None,
                    start: Some(start),
                    length: Some(length),
                }))
            }
            _ => self.fail(
                node,
                format!("a {} statement is not compilable yet", node.type_name()),
            ),
        }
    }

    /// A call can be a statement (its result, if any, discarded) or a subexpression; the
    /// caller picks the form from [`CallIr`].
    ///
    /// `memory.read`/`memory.write` and `port.read`/`port.write` are compiler-owned
    /// intrinsics. Every other `object.member(...)` is a namespace-qualified call, recorded for
    /// the linker to resolve.
    pub fn call_expression(&mut self, node: &Node) -> Option<CallIr> {
        let NodeKind::CallExpression {
            callee,
            args,
            instance,
        } = &node.kind
        else {
            return None;
        };
        if let NodeKind::MemberExpression { object, property } = &callee.kind
            && let NodeKind::Identifier {
                name: object_name, ..
            } = &object.kind
        {
            if object_name == "memory" {
                return self.memory_intrinsic(node, args, name_of(property).unwrap_or_default());
            }
            if object_name == "port" {
                return self.port_intrinsic(node, args, name_of(property).unwrap_or_default());
            }
            let mut lowered_args = Vec::new();
            for argument in args {
                lowered_args.push(self.expression(Some(argument))?);
            }
            let (start, length) = int_span(node);
            return Some(CallIr::NamespaceCall(NamespaceCall {
                namespace: object_name.clone(),
                member: name_of(property).unwrap_or_default().to_string(),
                args: lowered_args,
                // Unknown here: only the linker can say what the namespace's member returns.
                ty: Nullable::Null,
                start,
                length,
            }));
        }
        let NodeKind::Identifier {
            name: callee_name, ..
        } = &callee.kind
        else {
            return self.fail(node, "a call through member access is not compilable yet");
        };
        // `waitFrame()`: a builtin with its own IR kind, which every backend emits its own way.
        if callee_name == "waitFrame" {
            if !args.is_empty() {
                return self.fail(node, "waitFrame() takes no arguments");
            }
            let (start, length) = int_span(node);
            return Some(CallIr::WaitFrame(WaitFrame { start, length }));
        }
        if !self.check_arity(node, callee_name, args.len()) {
            return None;
        }
        let mut lowered_args = Vec::new();
        for argument in args {
            // An array is handed over by name, and this is the one place its bare name is a
            // value: the address of its first element, nothing copied.
            if let NodeKind::Identifier { name, .. } = &argument.kind
                && !self.current_params.contains_key(name)
                && (self.arrays.contains_key(name) || self.current_array_params.contains_key(name))
            {
                let (start, length) = span(argument);
                lowered_args.push(Expr::Ref(Ref {
                    name: name.clone(),
                    ty: Nullable::Absent,
                    start,
                    length,
                }));
                continue;
            }
            lowered_args.push(self.expression(Some(argument))?);
        }
        let (start, length) = span(callee);
        Some(CallIr::Call(Call {
            name: callee_name.clone(),
            args: lowered_args,
            ty: nullable(self.function_types.get(callee_name).cloned()),
            start,
            length,
            // An element's instance tag, when the elaborator gave the call one.
            instance: instance.clone().filter(|i| !i.is_empty()),
        }))
    }

    fn memory_intrinsic(&mut self, node: &Node, args: &[Node], member: &str) -> Option<CallIr> {
        let (start, length) = int_span(node);
        if member == "write" {
            if args.len() != 2 {
                return self.fail(
                    node,
                    "memory.write needs exactly two arguments: (address, value)",
                );
            }
            let address = self.memory_argument(&args[0], "usmallint");
            let value = self.memory_argument(&args[1], "utinyint");
            return Some(CallIr::MemoryWrite(MemoryWrite {
                address: address?,
                value: value?,
                start,
                length,
            }));
        }
        if member == "read" {
            if args.len() != 1 {
                return self.fail(node, "memory.read needs exactly one argument: (address)");
            }
            let address = self.memory_argument(&args[0], "usmallint")?;
            // Memory is byte-addressed: one read is always one byte, on every machine.
            return Some(CallIr::MemoryRead(MemoryRead {
                address: Box::new(address),
                ty: "utinyint".to_string(),
                start,
                length,
            }));
        }
        self.fail(
            node,
            format!("memory.{member} is not compilable yet: only read and write exist"),
        )
    }

    fn port_intrinsic(&mut self, node: &Node, args: &[Node], member: &str) -> Option<CallIr> {
        let (start, length) = int_span(node);
        if member == "write" {
            if args.len() != 2 {
                return self.fail(
                    node,
                    "port.write needs exactly two arguments: (port, value)",
                );
            }
            let port = self.memory_argument(&args[0], "utinyint");
            let value = self.memory_argument(&args[1], "utinyint");
            return Some(CallIr::PortWrite(PortWrite {
                port: port?,
                value: value?,
                start,
                length,
            }));
        }
        if member == "read" {
            if args.len() != 1 {
                return self.fail(node, "port.read needs exactly one argument: (port)");
            }
            let port = self.memory_argument(&args[0], "utinyint")?;
            return Some(CallIr::PortRead(PortRead {
                port: Box::new(port),
                ty: "utinyint".to_string(),
                start,
                length,
            }));
        }
        self.fail(
            node,
            format!("port.{member} is not compilable yet: only read and write exist"),
        )
    }

    /// Lower one `memory.read`/`memory.write` argument, range-checking it against `type_name`
    /// when it is a literal.
    fn memory_argument(&mut self, node: &Node, type_name: &str) -> Option<Expr> {
        let value = self.expression(Some(node))?;
        if let Expr::Const(c) = &value
            && let Some(range) = resolve_integer_type(type_name)
            && (c.value < range.min || c.value > range.max)
        {
            let (min, max) = (range.min, range.max);
            let message = format!(
                "{} does not fit in {type_name} ({min}..{max})",
                self.shown(c.value)
            );
            self.push_error(codes::VALUE_OUT_OF_RANGE, message, node.start, node.length);
            return None;
        }
        Some(value)
    }

    pub fn block_or_statement(&mut self, node: Option<&Node>) -> Vec<Stmt> {
        // `while (x)` with no body typed yet.
        let Some(node) = node else {
            return Vec::new();
        };
        if matches!(node.kind, NodeKind::BlockStatement { .. }) {
            return self.block(Some(node));
        }
        self.scoped(|this| this.statement(Some(node)).into_iter().collect())
    }

    pub fn assignment(&mut self, node: &Node) -> Option<Stmt> {
        let NodeKind::AssignmentExpression {
            operator,
            left,
            right,
        } = &node.kind
        else {
            return None;
        };
        if matches!(left.kind, NodeKind::IndexExpression { .. }) {
            let operator = &operator[..operator.len().saturating_sub(1)];
            return self.index_store(
                left,
                (!operator.is_empty()).then_some(operator),
                right.as_deref(),
            );
        }
        let NodeKind::Identifier { name, .. } = &left.kind else {
            return self.fail(
                left,
                format!("assigning to a {} is not compilable yet", left.type_name()),
            );
        };
        let in_scope = self.current_params.contains_key(name);
        if self.arrays.contains_key(name) && !in_scope {
            return self.fail(
                left,
                format!(
                    "'{name}' is an array: it is written one element at a time, {name}[i] = ..."
                ),
            );
        }
        if !in_scope && let Some(capacity) = self.string_buffers.get(name).copied() {
            return self.string_assignment(node, capacity);
        }
        if !in_scope && self.own_strings.contains_key(name) {
            self.push_error(
                codes::ASSIGN_TO_CONST,
                format!(
                    "'{name}' is a const — a compile-time value with no storage — and cannot be assigned"
                ),
                left.start,
                left.length,
            );
            return None;
        }
        let mut value = self.expression(right.as_deref())?;
        // A string into something this module knows is a number (a local, a parameter, an own
        // global); an imported target is the linker's to judge.
        if matches!(value, Expr::String(_)) && (in_scope || self.declares(name)) {
            return self.fail(
                right.as_deref().unwrap_or(node),
                format!("'{name}' is not a string: a string is assigned to a string<N>"),
            );
        }
        let (start, length) = span(left);
        if operator != "=" {
            // `x += e` is `x = x + e`; the operator minus its trailing `=`.
            let target_type = self
                .current_params
                .get(name)
                .or_else(|| self.global_types.get(name))
                .cloned();
            let ty = wider_of(target_type.as_deref(), type_of(&value));
            value = Expr::Binop(Binop {
                operator: operator[..operator.len() - 1].to_string(),
                left: Box::new(Expr::Ref(Ref {
                    name: name.clone(),
                    ty: nullable(target_type),
                    start,
                    length,
                })),
                right: Box::new(value),
                ty,
            });
        }
        Some(Stmt::Assign(Assign {
            target: name.clone(),
            value,
            start,
            length,
        }))
    }

    /// `a[i] = v`, `a[i] += v`, `a[i]++`: one element written. `operator` is the binary
    /// operator of a compound assignment, and `right` its right-hand side (`None` for `++`/`--`,
    /// which is `+ 1`).
    pub fn index_store(
        &mut self,
        left: &Node,
        operator: Option<&str>,
        right: Option<&Node>,
    ) -> Option<Stmt> {
        let NodeKind::IndexExpression { object, index } = &left.kind else {
            return None;
        };
        let object_name =
            name_of(object).filter(|_| matches!(object.kind, NodeKind::Identifier { .. }));
        if let Some(name) = object_name
            && self.is_string_parameter(name)
        {
            return self.fail(
                left,
                format!(
                    "a string is assigned whole ({name} = \"...\"), not one character at a time"
                ),
            );
        }
        let target = self.array_reference(Some(object), "assigning to an element")?;
        if target.array.as_ref().is_some_and(|a| a.constant) {
            self.push_error(
                codes::ASSIGN_TO_CONST,
                format!(
                    "'{}' is a const array — data in the program, not RAM — and cannot be assigned to",
                    object_name.unwrap_or_default()
                ),
                object.start,
                object.length,
            );
            return None;
        }
        let index_node = index.as_deref();
        let index = self.expression(index_node)?;
        if !self.index_in_range(index_node.unwrap_or(left), &index, target.array.as_ref()) {
            return None;
        }
        let mut value = match right {
            Some(r) => self.expression(Some(r))?,
            None => Expr::Const(Const {
                value: 1,
                ty: Some("utinyint".to_string()),
            }),
        };
        let element_type = target.array.as_ref().map(|a| a.ty.clone());
        if let Some(operator) = operator {
            // `a[i] += e` is `a[i] = a[i] + e`; the read gets its own copies of the array and
            // index nodes, since the linker renames in place.
            let read_back = Expr::Index(Index {
                array: Box::new(target.reference.clone()),
                index: Box::new(index.clone()),
                element_type: element_type.clone(),
                ty: element_type.clone(),
            });
            let ty = wider_of(element_type.as_deref(), type_of(&value));
            value = Expr::Binop(Binop {
                operator: operator.to_string(),
                left: Box::new(read_back),
                right: Box::new(value),
                ty,
            });
        }
        let (start, length) = int_span(object);
        Some(Stmt::StoreIndex(StoreIndex {
            array: target.reference,
            index,
            value,
            element_type,
            start,
            length,
        }))
    }

    pub fn update(&mut self, node: &Node) -> Option<Stmt> {
        let NodeKind::UpdateExpression {
            operator, argument, ..
        } = &node.kind
        else {
            return None;
        };
        let op = if operator == "++" { "+" } else { "-" };
        if matches!(argument.kind, NodeKind::IndexExpression { .. }) {
            return self.index_store(argument, Some(op), None);
        }
        let NodeKind::Identifier { name, .. } = &argument.kind else {
            return self.fail(
                argument,
                format!("updating a {} is not compilable yet", argument.type_name()),
            );
        };
        let target_type = self
            .current_params
            .get(name)
            .or_else(|| self.global_types.get(name))
            .cloned();
        let (start, length) = span(argument);
        let ty = wider_of(target_type.as_deref(), Some("utinyint"));
        Some(Stmt::Assign(Assign {
            target: name.clone(),
            start,
            length,
            value: Expr::Binop(Binop {
                operator: op.to_string(),
                left: Box::new(Expr::Ref(Ref {
                    name: name.clone(),
                    ty: nullable(target_type),
                    start,
                    length,
                })),
                right: Box::new(Expr::Const(Const {
                    value: 1,
                    ty: Some("utinyint".to_string()),
                })),
                ty,
            }),
        }))
    }
}
