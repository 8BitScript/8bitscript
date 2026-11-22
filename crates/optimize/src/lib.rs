//! Port of `packages/compiler/src/linker/optimize.mjs:1-1213`: the leaf passes and the inlining
//! passes of the pre-lowering IR rewrites. `optimize_statement` is still a stub that returns
//! `Unported`.

use diagnostics::Diagnostic;
use indexmap::{IndexMap, IndexSet};
use jsnum::{Nullable, to_int32};
use mos_ir::walk::{Flow, Node, visit_body, visit_expr, visit_stmt};
use mos_ir::{Asm, Binop, Block, Call, Const, Expr, For, Function, IrString, Local, Stmt};
use sema::types::{resolve_integer_type, storage_bytes};
use serde::Serialize;
use serde_json::Value;

/// A forward call into a function a later unit ports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unported;

/// The optimizer's working state (`optimizeIr`'s `ctx`). `functions_by_name` maps a name to its
/// index in the function list every pass is handed beside the context.
#[derive(Debug, Default)]
pub struct Ctx {
    pub functions_by_name: IndexMap<String, usize>,
    pub strings: Vec<IrString>,
    pub inlining: IndexSet<String>,
    pub unrolling_string_copy: bool,
    pub taken: IndexSet<String>,
    pub caller_bound: IndexSet<String>,
    pub zp_names: IndexSet<String>,
    pub current_fn: Option<String>,
    pub remarks: Vec<Diagnostic>,
    pub consumed: IndexSet<String>,
    pub retired: IndexSet<String>,
    pub addressed: IndexSet<String>,
}

/// Unroll a literal string copy only while the stores beat a looped print; 32 characters is still smaller than print+place+ascii.
pub const MAX_UNROLL: f64 = 32.0;

/// The cap for a loop a program marked `@unroll` itself.
pub const UNROLL_DECORATOR_MAX: f64 = 4096.0;

/// Any IR value the generic walks run over: a statement, an expression or a list of either.
pub trait IrValue {
    fn walk<'a>(&'a self, f: &mut impl FnMut(Node<'a>) -> Flow) -> Flow;
}

impl IrValue for Stmt {
    fn walk<'a>(&'a self, f: &mut impl FnMut(Node<'a>) -> Flow) -> Flow {
        visit_stmt(self, f)
    }
}

impl IrValue for Expr {
    fn walk<'a>(&'a self, f: &mut impl FnMut(Node<'a>) -> Flow) -> Flow {
        visit_expr(self, f)
    }
}

impl IrValue for [Stmt] {
    fn walk<'a>(&'a self, f: &mut impl FnMut(Node<'a>) -> Flow) -> Flow {
        visit_body(self, f)
    }
}

impl IrValue for [Expr] {
    fn walk<'a>(&'a self, f: &mut impl FnMut(Node<'a>) -> Flow) -> Flow {
        for expr in self {
            if visit_expr(expr, f) == Flow::Stop {
                return Flow::Stop;
            }
        }
        Flow::Continue
    }
}

/// Whether `found` stops the walk over `node` (JS `some`).
fn some<'a>(node: &'a (impl IrValue + ?Sized), mut found: impl FnMut(Node<'a>) -> bool) -> bool {
    node.walk(&mut |n| if found(n) { Flow::Stop } else { Flow::Continue }) == Flow::Stop
}

pub fn collect_assigned(node: &(impl IrValue + ?Sized), out: &mut IndexSet<String>) {
    node.walk(&mut |n| {
        if let Node::Stmt(Stmt::Assign(assign)) = n {
            out.insert(assign.target.clone());
        }
        Flow::Continue
    });
}

pub fn collect_bound_names(node: &(impl IrValue + ?Sized), out: &mut IndexSet<String>) {
    node.walk(&mut |n| {
        if let Node::Stmt(Stmt::Local(local)) = n {
            out.insert(local.name.clone());
        }
        Flow::Continue
    });
}

pub fn contains_string_byte(node: &(impl IrValue + ?Sized)) -> bool {
    some(node, |n| matches!(n, Node::Expr(Expr::StringByte(_))))
}

// Bodies at or under this many IR nodes still inline at several call
// sites: about 13 bytes at the ratio above, which is the neighbourhood
// where a duplicated body and the call it replaces cost the same.
pub const INLINE_DUPLICATE_NODE_LIMIT: usize = 8;

/// How many IR nodes a body is made of: every JSON object counts, and a call counts three more per argument.
pub fn node_count<T: Serialize + ?Sized>(node: &T) -> usize {
    fn walk(value: &Value, n: &mut usize) {
        match value {
            Value::Array(items) => {
                for item in items {
                    walk(item, n);
                }
            }
            Value::Object(fields) => {
                *n += 1;
                if fields.get("kind").and_then(Value::as_str) == Some("call") {
                    *n += 3 * fields
                        .get("args")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                }
                for inner in fields.values() {
                    walk(inner, n);
                }
            }
            _ => {}
        }
    }
    let mut n = 0;
    walk(&serde_json::to_value(node).unwrap_or(Value::Null), &mut n);
    n
}

pub fn contains_jump(node: &(impl IrValue + ?Sized)) -> bool {
    some(node, |n| {
        matches!(n, Node::Stmt(Stmt::Break(_) | Stmt::Continue(_)))
    })
}

pub fn contains_return(node: &(impl IrValue + ?Sized)) -> bool {
    some(node, |n| matches!(n, Node::Stmt(Stmt::Return(_))))
}

/// Whether an `asm6502` block's text writes any of `names` as a word — the shape mos/lower's frameOperand resolves against the frame.
pub fn asm_names(node: &Asm, names: &IndexSet<String>) -> bool {
    let text = node.text.as_str();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
                j += 1;
            }
            if names.contains(&text[i..j]) {
                return true;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    false
}

pub fn references_names(node: &(impl IrValue + ?Sized), names: &IndexSet<String>) -> bool {
    if names.is_empty() {
        return false;
    }
    some(node, |n| match n {
        // An `asm6502` block may name the function's own parameters or locals
        // as operands (mos/lower's frameOperand), so a name written in its text
        // is a reference.
        Node::Stmt(Stmt::Asm(asm)) => asm_names(asm, names),
        Node::Expr(Expr::Ref(r)) => names.contains(&r.name),
        Node::Stmt(Stmt::Assign(a)) => names.contains(&a.target),
        _ => false,
    })
}

pub fn wrap_unsigned(value: f64, ty: Option<&str>) -> Option<f64> {
    let desc = resolve_integer_type(ty?)?;
    if desc.signed {
        return None;
    }
    let modulus = desc.max as f64 + 1.0;
    Some(((value % modulus) + modulus) % modulus)
}

pub fn is_numeric_const(node: &Expr) -> bool {
    matches!(node, Expr::Const(_))
}

pub fn is_compile_time_arg(node: &Expr) -> bool {
    if is_numeric_const(node) {
        return true;
    }
    matches!(node, Expr::String(_))
}

/// Expression kinds with no stores, calls, or hardware reads.
pub const PURE_EXPR: [&str; 9] = [
    "const",
    "ref",
    "binop",
    "unop",
    "index",
    "string",
    "stringByte",
    "stringLength",
    "namespaceConst",
];

/// Every JSON object under `node` has a pure kind; anything that is not an object is free.
pub fn is_side_effect_free<T: Serialize + ?Sized>(node: &T) -> bool {
    fn free(value: &Value) -> bool {
        match value {
            Value::Array(items) => items.iter().all(free),
            Value::Object(fields) => {
                let pure = fields
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| PURE_EXPR.contains(&kind));
                pure && fields.values().all(free)
            }
            _ => true,
        }
    }
    free(&serde_json::to_value(node).unwrap_or(Value::Null))
}

fn truthy(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
}

/// The arms of `constValue` for a binop whose operands are already numbers.
fn binop_value(operator: &str, left: f64, right: f64, ty: Option<&str>) -> Option<f64> {
    let flag = |b: bool| Some(if b { 1.0 } else { 0.0 });
    match operator {
        "==" => flag(left == right),
        "!=" => flag(left != right),
        "<" => flag(left < right),
        "<=" => flag(left <= right),
        ">" => flag(left > right),
        ">=" => flag(left >= right),
        "&&" => flag(truthy(left) && truthy(right)),
        "||" => flag(truthy(left) || truthy(right)),
        "+" => wrap_unsigned(left + right, ty),
        "-" => wrap_unsigned(left - right, ty),
        // The same wrapping-unsigned rule as '+'/'-' (rewrite 3 in the file
        // header), extended to the operators 0.2.2's backends lower.
        // '/'/'%' of zero stay unfolded so the backends keep their own say
        // about a divide-by-zero's runtime shape.
        "*" => wrap_unsigned(left * right, ty),
        "/" if right == 0.0 => None,
        "/" => wrap_unsigned((left / right).floor(), ty),
        "%" if right == 0.0 => None,
        "%" => wrap_unsigned(left % right, ty),
        "&" => wrap_unsigned(f64::from(to_int32(left) & to_int32(right)), ty),
        "|" => wrap_unsigned(f64::from(to_int32(left) | to_int32(right)), ty),
        "^" => wrap_unsigned(f64::from(to_int32(left) ^ to_int32(right)), ty),
        "<<" => wrap_unsigned(left * right.exp2(), ty),
        ">>" => wrap_unsigned((left / right.exp2()).floor(), ty),
        _ => None,
    }
}

/// Comparisons, boolean combinators, and unsigned wrapping +/− of constants.
pub fn const_value(node: &Expr) -> Option<f64> {
    match node {
        Expr::Const(c) => Some(c.value as f64),
        Expr::Unop(u) if u.operator == "!" => {
            let inner = const_value(&u.argument)?;
            Some(if truthy(inner) { 0.0 } else { 1.0 })
        }
        Expr::Binop(b) => {
            let left = const_value(&b.left);
            let right = const_value(&b.right);
            binop_value(&b.operator, left?, right?, b.ty.as_deref())
        }
        _ => None,
    }
}

fn const_expr(value: i64, ty: Option<&str>) -> Expr {
    Expr::Const(Const {
        value,
        ty: ty.map(str::to_string),
    })
}

/// `x * C` with one side a compile-time constant, rewritten into the shifts
/// and adds the backends lower more cheaply than a general multiply.
pub fn reduce_multiply(node: &Binop) -> Option<Expr> {
    let ty = node.ty.as_deref();
    let (value, other) = if let Expr::Const(c) = &*node.left {
        (c.value, &*node.right)
    } else if let Expr::Const(c) = &*node.right {
        (c.value, &*node.left)
    } else {
        return None;
    };
    if value < 0 {
        return None;
    }
    // `x * 0` only folds away a bare ref: anything with a call in it would
    // lose that call's own work.
    if value == 0 {
        return if matches!(other, Expr::Ref(_)) {
            Some(const_expr(0, ty))
        } else {
            None
        };
    }
    if value == 1 {
        return Some(other.clone());
    }
    let shift = |amount: i64| {
        Expr::Binop(Binop {
            operator: "<<".to_string(),
            left: Box::new(other.clone()),
            right: Box::new(const_expr(amount, Some("utinyint"))),
            ty: node.ty.clone(),
        })
    };
    let value = value as f64;
    let mut bits = Vec::new();
    let mut b = 0_i64;
    while (b as f64).exp2() <= value {
        if to_int32(value) & to_int32((b as f64).exp2()) != 0 {
            bits.push(b);
        }
        b += 1;
    }
    if bits.len() == 1 {
        return Some(shift(bits[0]));
    }
    if bits.len() == 2 && matches!(other, Expr::Ref(_)) {
        return Some(Expr::Binop(Binop {
            operator: "+".to_string(),
            left: Box::new(shift(bits[1])),
            right: Box::new(shift(bits[0])),
            ty: node.ty.clone(),
        }));
    }
    None
}

/// `x / 256` → `x >> 8`, and every other power-of-two divisor. Unsigned only.
pub fn reduce_divide(node: &Binop) -> Option<Expr> {
    let desc = resolve_integer_type(node.ty.as_deref()?)?;
    if desc.signed {
        return None;
    }
    let Expr::Const(divisor) = &*node.right else {
        return None;
    };
    let divisor = divisor.value;
    if divisor < 1 {
        return None;
    }
    if divisor == 1 {
        return Some((*node.left).clone());
    }
    let bit = (divisor as f64).log2();
    if bit.fract() != 0.0 {
        return None;
    }
    Some(Expr::Binop(Binop {
        operator: ">>".to_string(),
        left: node.left.clone(),
        right: Box::new(const_expr(bit as i64, Some("utinyint"))),
        ty: node.ty.clone(),
    }))
}

/// `x % 256` → `x & 255`, and every other power-of-two modulus. Unsigned only.
pub fn reduce_modulo(node: &Binop) -> Option<Expr> {
    let desc = resolve_integer_type(node.ty.as_deref()?)?;
    if desc.signed {
        return None;
    }
    let Expr::Const(modulus) = &*node.right else {
        return None;
    };
    let modulus = modulus.value;
    if modulus < 1 {
        return None;
    }
    if modulus == 1 {
        return Some(const_expr(0, node.ty.as_deref()));
    }
    if (modulus as f64).log2().fract() != 0.0 {
        return None;
    }
    Some(Expr::Binop(Binop {
        operator: "&".to_string(),
        left: node.left.clone(),
        right: Box::new(const_expr(modulus - 1, node.ty.as_deref())),
        ty: node.ty.clone(),
    }))
}

pub fn string_bytes<'a>(node: &Expr, ctx: &'a Ctx) -> Option<&'a [u8]> {
    let Expr::String(string) = node else {
        return None;
    };
    let entry = ctx.strings.get(usize::try_from(string.index).ok()?)?;
    Some(entry.bytes.as_slice())
}

/// What `foldExpr` returns for a statement: the statement, or an expression a call statement became.
#[derive(Debug, Clone, PartialEq)]
pub enum Folded {
    Stmt(Box<Stmt>),
    Expr(Box<Expr>),
}

enum CallFolded {
    Call(Box<Call>),
    Expr(Box<Expr>),
}

fn fold_exprs(exprs: &mut [Expr], ctx: &mut Ctx, functions: &[Function]) -> Result<(), Unported> {
    for expr in exprs {
        *expr = fold_expr(expr, ctx, functions)?;
    }
    Ok(())
}

/// The call branch of `foldExpr`: its arguments folded, then the call evaluated or forwarded.
fn fold_call(call: &Call, ctx: &mut Ctx, functions: &[Function]) -> Result<CallFolded, Unported> {
    let mut out = call.clone();
    fold_exprs(&mut out.args, ctx, functions)?;
    if let Some(evaluated) = const_eval_call(&out, ctx, functions)? {
        let ty = out.ty.as_option().map_or("utinyint", String::as_str);
        return Ok(CallFolded::Expr(Box::new(const_expr(
            evaluated as i64,
            Some(ty),
        ))));
    }
    if let Some(forwarded) = forward_expr_call(&out, ctx, functions)? {
        return Ok(CallFolded::Expr(Box::new(forwarded)));
    }
    Ok(CallFolded::Call(Box::new(out)))
}

pub fn fold_expr(node: &Expr, ctx: &mut Ctx, functions: &[Function]) -> Result<Expr, Unported> {
    if let Expr::Call(call) = node {
        return Ok(match fold_call(call, ctx, functions)? {
            CallFolded::Call(call) => Expr::Call(*call),
            CallFolded::Expr(expr) => *expr,
        });
    }
    let mut out = node.clone();
    match &mut out {
        Expr::Binop(b) => {
            *b.left = fold_expr(&b.left, ctx, functions)?;
            *b.right = fold_expr(&b.right, ctx, functions)?;
        }
        Expr::Unop(u) => *u.argument = fold_expr(&u.argument, ctx, functions)?,
        Expr::NamespaceCall(c) => fold_exprs(&mut c.args, ctx, functions)?,
        Expr::PortWrite(p) => p.value = fold_expr(&p.value, ctx, functions)?,
        Expr::MemoryRead(m) => *m.address = fold_expr(&m.address, ctx, functions)?,
        Expr::Cond(c) => {
            *c.test = fold_expr(&c.test, ctx, functions)?;
            *c.consequent = fold_expr(&c.consequent, ctx, functions)?;
            *c.alternate = fold_expr(&c.alternate, ctx, functions)?;
        }
        Expr::StringByte(s) => {
            *s.string = fold_expr(&s.string, ctx, functions)?;
            *s.index = fold_expr(&s.index, ctx, functions)?;
        }
        Expr::StringLength(s) => *s.string = fold_expr(&s.string, ctx, functions)?,
        Expr::Index(i) => *i.index = fold_expr(&i.index, ctx, functions)?,
        Expr::Call(_)
        | Expr::Const(_)
        | Expr::Ref(_)
        | Expr::String(_)
        | Expr::NamespaceConst(_)
        | Expr::PortRead(_)
        | Expr::Record(_) => {}
    }
    // `#fact(...) ? a : b`, or any `?:` whose test is known: the taken arm,
    // and the other one is gone (spec §49).
    if let Expr::Cond(c) = &out
        && let Some(test) = const_value(&c.test)
    {
        return Ok(if test != 0.0 {
            (*c.consequent).clone()
        } else {
            (*c.alternate).clone()
        });
    }
    if let Expr::StringLength(s) = &out
        && let Some(bytes) = string_bytes(&s.string, ctx)
    {
        return Ok(const_expr(bytes.len() as i64, Some(&s.ty)));
    }
    // A fractional index is left unfolded; JS folds on `bytes[1.5]` (undefined).
    if let Expr::StringByte(s) = &out
        && let Some(bytes) = string_bytes(&s.string, ctx)
        && let Some(index) = const_value(&s.index)
        && index >= 0.0
        && index < bytes.len() as f64
        && index.fract() == 0.0
    {
        return Ok(const_expr(i64::from(bytes[index as usize]), Some(&s.ty)));
    }
    if let Expr::Binop(b) = &out {
        let reduced = match b.operator.as_str() {
            "*" => reduce_multiply(b),
            "/" => reduce_divide(b),
            "%" => reduce_modulo(b),
            _ => None,
        };
        if let Some(reduced) = reduced {
            return Ok(reduced);
        }
    }
    if !is_numeric_const(&out)
        && let Some(value) = const_value(&out)
    {
        let (operator, ty) = match &out {
            Expr::Binop(b) => (b.operator.as_str(), b.ty.clone()),
            Expr::Unop(u) => (u.operator.as_str(), u.ty.clone()),
            _ => ("", None),
        };
        let comparison = matches!(
            operator,
            "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||" | "!"
        );
        let ty = ty.or_else(|| comparison.then(|| "bool".to_string()));
        return Ok(const_expr(value as i64, ty.as_deref()));
    }
    Ok(out)
}

/// `foldExpr` over a statement: the expressions it holds are folded; a call statement may become an expression.
pub fn fold_stmt(node: &Stmt, ctx: &mut Ctx, functions: &[Function]) -> Result<Folded, Unported> {
    if let Stmt::Call(call) = node {
        return Ok(match fold_call(call, ctx, functions)? {
            CallFolded::Call(call) => Folded::Stmt(Box::new(Stmt::Call(*call))),
            CallFolded::Expr(expr) => Folded::Expr(expr),
        });
    }
    let mut out = node.clone();
    match &mut out {
        Stmt::Assign(a) => a.value = fold_expr(&a.value, ctx, functions)?,
        Stmt::Local(l) => l.init = fold_expr(&l.init, ctx, functions)?,
        Stmt::Return(r) => {
            if let Some(value) = &r.value {
                r.value = Some(fold_expr(value, ctx, functions)?);
            }
        }
        Stmt::MemoryWrite(m) => {
            m.value = fold_expr(&m.value, ctx, functions)?;
            m.address = fold_expr(&m.address, ctx, functions)?;
        }
        Stmt::StoreIndex(s) => {
            s.value = fold_expr(&s.value, ctx, functions)?;
            s.index = fold_expr(&s.index, ctx, functions)?;
        }
        Stmt::If(i) => i.test = fold_expr(&i.test, ctx, functions)?,
        Stmt::While(w) => w.test = fold_expr(&w.test, ctx, functions)?,
        Stmt::For(f) => {
            if let Some(test) = f.test.as_option() {
                f.test = Nullable::Value(fold_expr(test, ctx, functions)?);
            }
            // A `local` init is not folded. An init that folds to an expression stays as it
            // was: no `for` init is a call statement.
            if let Some(init) = f.init.as_option()
                && !matches!(**init, Stmt::Local(_))
                && let Folded::Stmt(folded) = fold_stmt(init, ctx, functions)?
            {
                f.init = Nullable::Value(folded);
            }
        }
        Stmt::MemoryRead(m) => *m.address = fold_expr(&m.address, ctx, functions)?,
        Stmt::PortWrite(p) => p.value = fold_expr(&p.value, ctx, functions)?,
        Stmt::NamespaceCall(c) => fold_exprs(&mut c.args, ctx, functions)?,
        Stmt::Asm(_)
        | Stmt::Block(_)
        | Stmt::Break(_)
        | Stmt::Call(_)
        | Stmt::Continue(_)
        | Stmt::WaitFrame(_)
        | Stmt::StringCopy(_)
        | Stmt::PortRead(_) => {}
    }
    Ok(Folded::Stmt(Box::new(out)))
}

/// How a statement ended in `evalStmt`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Eval {
    Abort,
    Fell,
    Returned(f64),
}

pub fn eval_expr(
    node: &Expr,
    env: &IndexMap<String, f64>,
    ctx: &mut Ctx,
    functions: &[Function],
) -> Result<Option<f64>, Unported> {
    match node {
        Expr::Const(c) => Ok(Some(c.value as f64)),
        Expr::Ref(r) if env.contains_key(&r.name) => Ok(env.get(&r.name).copied()),
        Expr::StringLength(s) => Ok(string_bytes(&s.string, ctx).map(|bytes| bytes.len() as f64)),
        Expr::StringByte(s) => {
            let index = eval_expr(&s.index, env, ctx, functions)?;
            let Some(bytes) = string_bytes(&s.string, ctx) else {
                return Ok(None);
            };
            Ok(index
                .filter(|&i| i >= 0.0 && i < bytes.len() as f64 && i.fract() == 0.0)
                .map(|i| f64::from(bytes[i as usize])))
        }
        Expr::Unop(u) if u.operator == "!" => {
            let inner = eval_expr(&u.argument, env, ctx, functions)?;
            Ok(inner.map(|v| if truthy(v) { 0.0 } else { 1.0 }))
        }
        Expr::Binop(b) => {
            let left = eval_expr(&b.left, env, ctx, functions)?;
            let right = eval_expr(&b.right, env, ctx, functions)?;
            let (Some(left), Some(right)) = (left, right) else {
                return Ok(None);
            };
            Ok(binop_value(&b.operator, left, right, b.ty.as_deref()))
        }
        Expr::Call(c) => {
            let mut values = Vec::new();
            for arg in &c.args {
                values.push(eval_expr(arg, env, ctx, functions)?);
            }
            if values.iter().any(Option::is_none) {
                return Ok(None);
            }
            // The argument's own type is never read: `const_eval_call` takes the value.
            let args = values
                .into_iter()
                .flatten()
                .map(|value| const_expr(value as i64, None))
                .collect();
            let call = Call { args, ..c.clone() };
            const_eval_call(&call, ctx, functions)
        }
        _ => Ok(const_value(node)),
    }
}

pub fn eval_block(
    body: &[Stmt],
    env: &mut IndexMap<String, f64>,
    ctx: &mut Ctx,
    functions: &[Function],
) -> Result<Eval, Unported> {
    for statement in body {
        match eval_stmt(statement, env, ctx, functions)? {
            Eval::Abort => return Ok(Eval::Abort),
            Eval::Returned(value) => return Ok(Eval::Returned(value)),
            Eval::Fell => {}
        }
    }
    Ok(Eval::Fell)
}

pub fn eval_stmt(
    statement: &Stmt,
    env: &mut IndexMap<String, f64>,
    ctx: &mut Ctx,
    functions: &[Function],
) -> Result<Eval, Unported> {
    match statement {
        Stmt::Block(b) => eval_block(&b.body, env, ctx, functions),
        Stmt::Local(l) => {
            let Some(value) = eval_expr(&l.init, env, ctx, functions)? else {
                return Ok(Eval::Abort);
            };
            env.insert(l.name.clone(), value);
            Ok(Eval::Fell)
        }
        Stmt::Assign(a) => {
            if !env.contains_key(&a.target) {
                return Ok(Eval::Abort);
            }
            let Some(value) = eval_expr(&a.value, env, ctx, functions)? else {
                return Ok(Eval::Abort);
            };
            env.insert(a.target.clone(), value);
            Ok(Eval::Fell)
        }
        Stmt::Return(r) => {
            let Some(value) = &r.value else {
                return Ok(Eval::Returned(0.0));
            };
            Ok(match eval_expr(value, env, ctx, functions)? {
                Some(value) => Eval::Returned(value),
                None => Eval::Abort,
            })
        }
        Stmt::If(i) => {
            let Some(test) = eval_expr(&i.test, env, ctx, functions)? else {
                return Ok(Eval::Abort);
            };
            if truthy(test) {
                return eval_block(&i.then, env, ctx, functions);
            }
            if let Some(arm) = &i.r#else {
                return eval_block(arm, env, ctx, functions);
            }
            Ok(Eval::Fell)
        }
        _ => Ok(Eval::Abort),
    }
}

pub fn const_eval_call(
    call: &Call,
    ctx: &mut Ctx,
    functions: &[Function],
) -> Result<Option<f64>, Unported> {
    let Some(&index) = ctx.functions_by_name.get(&call.name) else {
        return Ok(None);
    };
    let func = &functions[index];
    if func.body.is_empty() {
        return Ok(None);
    }
    if ctx.inlining.contains(&call.name) {
        return Ok(None);
    }
    let return_type = func.return_type.as_str();
    if return_type != "void" && return_type != "bool" && storage_bytes(return_type) != 1 {
        return Ok(None);
    }
    if site_count(&call.name, ctx, functions, &mut IndexSet::new()) > 1 {
        return Ok(None);
    }
    let params = &func.params;
    let args = &call.args;
    if params.len() != args.len() {
        return Ok(None);
    }
    for arg in args {
        if !is_numeric_const(arg) && eval_expr(arg, &IndexMap::new(), ctx, functions)?.is_none() {
            return Ok(None);
        }
    }
    let mut env = IndexMap::new();
    for (param, arg) in params.iter().zip(args) {
        let value = match arg {
            Expr::Const(c) => Some(c.value as f64),
            _ => eval_expr(arg, &IndexMap::new(), ctx, functions)?,
        };
        let Some(value) = value else {
            return Ok(None);
        };
        env.insert(param.name.clone(), value);
    }
    ctx.inlining.insert(call.name.clone());
    let result = eval_block(&func.body, &mut env, ctx, functions)?;
    ctx.inlining.shift_remove(&call.name);
    Ok(match result {
        Eval::Returned(value) => Some(value),
        Eval::Abort | Eval::Fell => None,
    })
}

pub fn always_returns(statement: &Stmt) -> bool {
    let last_returns = |body: &[Stmt]| body.last().is_some_and(always_returns);
    match statement {
        Stmt::Return(_) => true,
        Stmt::Block(b) => last_returns(&b.body),
        Stmt::If(i) => match &i.r#else {
            Some(otherwise) if !otherwise.is_empty() => {
                last_returns(&i.then) && last_returns(otherwise)
            }
            _ => false,
        },
        _ => false,
    }
}

pub fn optimize_body(
    body: &[Stmt],
    ctx: &mut Ctx,
    functions: &[Function],
) -> Result<Vec<Stmt>, Unported> {
    let mut out = Vec::new();
    for statement in body {
        for piece in optimize_statement(statement, ctx, functions)? {
            let returns = always_returns(&piece);
            out.push(piece);
            if returns {
                return propagate_const_locals(out, ctx, functions);
            }
        }
    }
    propagate_const_locals(out, ctx, functions)
}

pub fn binds_name(node: &(impl IrValue + ?Sized), name: &str) -> bool {
    some(
        node,
        |n| matches!(n, Node::Stmt(Stmt::Local(l)) if l.name == name),
    )
}

/// A local rule 9 pasted in holding a constant that nothing ever assigns is the constant:
/// every read of it in the rest of its block becomes the value, and the declaration goes.
pub fn propagate_const_locals(
    statements: Vec<Stmt>,
    ctx: &mut Ctx,
    functions: &[Function],
) -> Result<Vec<Stmt>, Unported> {
    for (i, statement) in statements.iter().enumerate() {
        let Stmt::Local(local) = statement else {
            continue;
        };
        let Expr::Const(init) = &local.init else {
            continue;
        };
        if local.inlined != Some(true) {
            continue;
        }
        let rest = &statements[i + 1..];
        let mut assigned = IndexSet::new();
        collect_assigned(rest, &mut assigned);
        if assigned.contains(&local.name) || binds_name(rest, &local.name) {
            continue;
        }
        let value = const_expr(init.value, Some(&local.ty));
        // The rest goes round again: a value that was a variable a moment ago
        // may now fold — an address into a literal, a call into its result.
        let bindings = IndexMap::from([(local.name.clone(), value)]);
        let substituted = optimize_body(&substitute_bindings(rest, &bindings), ctx, functions)?;
        let mut out = statements[..i].to_vec();
        out.extend(substituted);
        return Ok(out);
    }
    Ok(statements)
}

/// What `matchCountedFor` found: the loop variable, its trip count and its type.
#[derive(Debug, Clone, PartialEq)]
pub struct CountedFor {
    pub name: String,
    pub count: f64,
    pub ty: String,
}

/// Whether `statement` is `for (let i: T = 0; i < N; i++) { ... }`, N a
/// compile-time value and 0 < N <= `max_unroll` — the one shape this pass
/// knows how to substitute a constant `i` into.
pub fn match_counted_for(statement: &For, max_unroll: f64) -> Option<CountedFor> {
    let Stmt::Local(init) = &**statement.init.as_option()? else {
        return None;
    };
    if init.name.is_empty() {
        return None;
    }
    let name = &init.name;
    if !matches!(&init.init, Expr::Const(c) if c.value == 0) {
        return None;
    }
    let Expr::Binop(test) = statement.test.as_option()? else {
        return None;
    };
    if test.operator != "<" || !matches!(&*test.left, Expr::Ref(r) if r.name == *name) {
        return None;
    }
    let count = const_value(&test.right)?;
    if count <= 0.0 || count > max_unroll {
        return None;
    }
    let Stmt::Assign(update) = &**statement.update.as_option()? else {
        return None;
    };
    if update.target != *name {
        return None;
    }
    let Expr::Binop(inc) = &update.value else {
        return None;
    };
    if inc.operator != "+" || !matches!(&*inc.left, Expr::Ref(r) if r.name == *name) {
        return None;
    }
    if !matches!(&*inc.right, Expr::Const(c) if c.value == 1) {
        return None;
    }
    if contains_jump(statement.body.as_slice()) {
        return None;
    }
    Some(CountedFor {
        name: name.clone(),
        count,
        ty: init.ty.clone(),
    })
}

// ---- the generic rewrites `mapDeep` does over untyped objects ----------------------------------
//
// A visitor over `&mut` IR in the order of `mos_ir::walk` (spec fact F5). `stmt` and `expr` run on
// a node before its children and answer whether to go into them: a node a visitor replaced is
// not walked again (`mapDeep` does not recurse into what `fn` returned).

trait Rewrite {
    fn stmt(&mut self, _stmt: &mut Stmt) -> bool {
        true
    }
    fn expr(&mut self, _expr: &mut Expr) -> bool {
        true
    }
}

fn rewrite_body(body: &mut [Stmt], v: &mut impl Rewrite) {
    for stmt in body {
        rewrite_stmt(stmt, v);
    }
}

fn rewrite_exprs(exprs: &mut [Expr], v: &mut impl Rewrite) {
    for expr in exprs {
        rewrite_expr(expr, v);
    }
}

fn rewrite_stmt(stmt: &mut Stmt, v: &mut impl Rewrite) {
    if !v.stmt(stmt) {
        return;
    }
    match stmt {
        Stmt::Asm(_) | Stmt::Break(_) | Stmt::Continue(_) | Stmt::WaitFrame(_) => {}
        Stmt::Assign(s) => rewrite_expr(&mut s.value, v),
        Stmt::Block(s) => rewrite_body(&mut s.body, v),
        Stmt::Call(s) => rewrite_exprs(&mut s.args, v),
        Stmt::For(s) => {
            if let Nullable::Value(init) = &mut s.init {
                rewrite_stmt(init, v);
            }
            if let Nullable::Value(test) = &mut s.test {
                rewrite_expr(test, v);
            }
            if let Nullable::Value(update) = &mut s.update {
                rewrite_stmt(update, v);
            }
            rewrite_body(&mut s.body, v);
        }
        Stmt::If(s) => {
            rewrite_expr(&mut s.test, v);
            rewrite_body(&mut s.then, v);
            if let Some(arm) = &mut s.r#else {
                rewrite_body(arm, v);
            }
        }
        Stmt::Local(s) => rewrite_expr(&mut s.init, v),
        Stmt::MemoryRead(s) => rewrite_expr(&mut s.address, v),
        Stmt::MemoryWrite(s) => {
            rewrite_expr(&mut s.address, v);
            rewrite_expr(&mut s.value, v);
        }
        Stmt::Return(s) => {
            if let Some(value) = &mut s.value {
                rewrite_expr(value, v);
            }
        }
        Stmt::StoreIndex(s) => {
            rewrite_expr(&mut s.array, v);
            rewrite_expr(&mut s.index, v);
            rewrite_expr(&mut s.value, v);
        }
        Stmt::While(s) => {
            rewrite_expr(&mut s.test, v);
            rewrite_body(&mut s.body, v);
        }
        Stmt::PortWrite(s) => {
            rewrite_expr(&mut s.port, v);
            rewrite_expr(&mut s.value, v);
        }
        Stmt::StringCopy(s) => {
            rewrite_expr(&mut s.target, v);
            rewrite_expr(&mut s.source, v);
        }
        Stmt::NamespaceCall(s) => rewrite_exprs(&mut s.args, v),
        Stmt::PortRead(s) => rewrite_expr(&mut s.port, v),
    }
}

fn rewrite_expr(expr: &mut Expr, v: &mut impl Rewrite) {
    if !v.expr(expr) {
        return;
    }
    match expr {
        Expr::Const(_) | Expr::Ref(_) | Expr::String(_) | Expr::NamespaceConst(_) => {}
        Expr::Binop(e) => {
            rewrite_expr(&mut e.left, v);
            rewrite_expr(&mut e.right, v);
        }
        Expr::Call(e) => rewrite_exprs(&mut e.args, v),
        Expr::Index(e) => {
            rewrite_expr(&mut e.array, v);
            rewrite_expr(&mut e.index, v);
        }
        Expr::MemoryRead(e) => rewrite_expr(&mut e.address, v),
        Expr::StringByte(e) => {
            rewrite_expr(&mut e.string, v);
            rewrite_expr(&mut e.index, v);
        }
        Expr::StringLength(e) => rewrite_expr(&mut e.string, v),
        Expr::Unop(e) => rewrite_expr(&mut e.argument, v),
        Expr::Cond(e) => {
            rewrite_expr(&mut e.test, v);
            rewrite_expr(&mut e.consequent, v);
            rewrite_expr(&mut e.alternate, v);
        }
        Expr::PortRead(e) => rewrite_expr(&mut e.port, v),
        Expr::PortWrite(e) => {
            rewrite_expr(&mut e.port, v);
            rewrite_expr(&mut e.value, v);
        }
        Expr::NamespaceCall(e) => rewrite_exprs(&mut e.args, v),
        Expr::Record(e) => {
            for field in &mut e.fields {
                rewrite_expr(&mut field.value, v);
            }
        }
    }
}

/// Every `ref` named in `bindings` becomes a copy of its binding.
struct Substitute<'a>(&'a IndexMap<String, Expr>);

impl Rewrite for Substitute<'_> {
    fn expr(&mut self, expr: &mut Expr) -> bool {
        if let Expr::Ref(r) = &*expr
            && let Some(value) = self.0.get(&r.name)
        {
            *expr = value.clone();
            return false;
        }
        true
    }
}

/// Every name a callee binds is renamed: refs, locals (marked `inlined`) and assignment targets.
struct Rename<'a>(&'a IndexMap<String, String>);

impl Rewrite for Rename<'_> {
    fn stmt(&mut self, stmt: &mut Stmt) -> bool {
        match stmt {
            Stmt::Local(local) => {
                if let Some(name) = self.0.get(&local.name) {
                    local.name.clone_from(name);
                    local.inlined = Some(true);
                }
            }
            Stmt::Assign(assign) => {
                if let Some(name) = self.0.get(&assign.target) {
                    assign.target.clone_from(name);
                }
            }
            _ => {}
        }
        true
    }

    fn expr(&mut self, expr: &mut Expr) -> bool {
        if let Expr::Ref(r) = expr
            && let Some(name) = self.0.get(&r.name)
        {
            r.name.clone_from(name);
        }
        true
    }
}

/// The `n`th call expression of a walk (counted in `mos_ir::walk` order) becomes `with`.
struct ReplaceCall<'a> {
    target: usize,
    seen: usize,
    with: &'a Expr,
}

impl Rewrite for ReplaceCall<'_> {
    fn expr(&mut self, expr: &mut Expr) -> bool {
        if matches!(expr, Expr::Call(_)) {
            let hit = self.seen == self.target;
            self.seen += 1;
            if hit {
                *expr = self.with.clone();
                return false;
            }
        }
        true
    }
}

pub fn substitute_bindings(body: &[Stmt], bindings: &IndexMap<String, Expr>) -> Vec<Stmt> {
    let mut out = body.to_vec();
    rewrite_body(&mut out, &mut Substitute(bindings));
    out
}

/// `substituteBindings` over a call node (the wrapped call of a forwarder).
fn substitute_call(call: &Call, bindings: &IndexMap<String, Expr>) -> Call {
    let mut out = call.clone();
    rewrite_exprs(&mut out.args, &mut Substitute(bindings));
    out
}

/// A function a call names, through the context's name table.
fn function_named<'a>(ctx: &Ctx, functions: &'a [Function], name: &str) -> Option<&'a Function> {
    ctx.functions_by_name
        .get(name)
        .and_then(|&index| functions.get(index))
}

/// The `type` field of an expression, when it has one.
fn expr_type(expr: &Expr) -> Option<&str> {
    match expr {
        Expr::Binop(e) => e.ty.as_deref(),
        Expr::Call(e) => e.ty.as_option().map(String::as_str),
        Expr::Const(e) => e.ty.as_deref(),
        Expr::Index(e) => e.ty.as_deref(),
        Expr::MemoryRead(e) => Some(&e.ty),
        Expr::Ref(e) => e.ty.as_option().map(String::as_str),
        Expr::String(e) => e.ty.as_option().map(String::as_str),
        Expr::StringByte(e) => Some(&e.ty),
        Expr::StringLength(e) => Some(&e.ty),
        Expr::Unop(e) => e.ty.as_deref(),
        Expr::Cond(e) => e.ty.as_option().map(String::as_str),
        Expr::PortRead(e) => Some(&e.ty),
        Expr::NamespaceCall(e) => e.ty.as_option().map(String::as_str),
        Expr::NamespaceConst(e) => e.ty.as_option().map(String::as_str),
        Expr::Record(_) | Expr::PortWrite(_) => None,
    }
}

fn stmt_kind(stmt: &Stmt) -> &'static str {
    match stmt {
        Stmt::Asm(_) => "asm",
        Stmt::Assign(_) => "assign",
        Stmt::Block(_) => "block",
        Stmt::Break(_) => "break",
        Stmt::Call(_) => "call",
        Stmt::Continue(_) => "continue",
        Stmt::For(_) => "for",
        Stmt::If(_) => "if",
        Stmt::Local(_) => "local",
        Stmt::MemoryRead(_) => "memoryRead",
        Stmt::MemoryWrite(_) => "memoryWrite",
        Stmt::Return(_) => "return",
        Stmt::StoreIndex(_) => "storeIndex",
        Stmt::WaitFrame(_) => "waitFrame",
        Stmt::While(_) => "while",
        Stmt::PortWrite(_) => "portWrite",
        Stmt::StringCopy(_) => "stringCopy",
        Stmt::NamespaceCall(_) => "namespaceCall",
        Stmt::PortRead(_) => "portRead",
    }
}

fn expr_kind(expr: &Expr) -> &'static str {
    match expr {
        Expr::Binop(_) => "binop",
        Expr::Call(_) => "call",
        Expr::Const(_) => "const",
        Expr::Index(_) => "index",
        Expr::MemoryRead(_) => "memoryRead",
        Expr::Ref(_) => "ref",
        Expr::String(_) => "string",
        Expr::StringByte(_) => "stringByte",
        Expr::StringLength(_) => "stringLength",
        Expr::Unop(_) => "unop",
        Expr::Cond(_) => "cond",
        Expr::PortRead(_) => "portRead",
        Expr::NamespaceCall(_) => "namespaceCall",
        Expr::NamespaceConst(_) => "namespaceConst",
        Expr::Record(_) => "record",
        Expr::PortWrite(_) => "portWrite",
    }
}

/// The one call a forwarder's body consists of (`forwardedCall`): `wrapped` is the call,
/// `constants` how many of its arguments are literals, `used` which parameters it passes on.
#[derive(Debug, Clone, PartialEq)]
pub struct Forwarded<'a> {
    pub wrapped: &'a Call,
    pub constants: usize,
    pub used: IndexSet<String>,
}

/// The one call a forwarder's body consists of, when it is one: a call whose every argument is
/// one of the function's own parameters (each at most once) or a numeric constant, as the body's
/// only statement (`void`) or as the value of its only `return`.
pub fn forwarded_call(func: &Function) -> Option<Forwarded<'_>> {
    let [only] = func.body.as_slice() else {
        return None;
    };
    let return_type = func.return_type.as_str();
    let wrapped = match only {
        Stmt::Call(call) => {
            if return_type != "void" {
                return None;
            }
            call
        }
        Stmt::Return(r) => {
            let Some(Expr::Call(call)) = &r.value else {
                return None;
            };
            let ty = call.ty.as_option().map_or(return_type, String::as_str);
            if return_type == "void" || ty != return_type {
                return None;
            }
            call
        }
        _ => return None,
    };
    if wrapped.name == func.name {
        return None;
    }
    let params: IndexSet<&str> = func.params.iter().map(|p| p.name.as_str()).collect();
    let mut used = IndexSet::new();
    let mut constants = 0;
    for arg in &wrapped.args {
        match arg {
            _ if is_numeric_const(arg) => constants += 1,
            Expr::Ref(r) if params.contains(r.name.as_str()) && !used.contains(&r.name) => {
                used.insert(r.name.clone());
            }
            _ => return None,
        }
    }
    Some(Forwarded {
        wrapped,
        constants,
        used,
    })
}

/// The call a site of a forwarder becomes: the wrapped call with the site's arguments in the
/// forwarded parameters' places. `None` when the rewrite would change what runs or what it costs.
pub fn forward_call(
    call: &Call,
    func: &Function,
    forwarded: &Forwarded<'_>,
    ctx: &Ctx,
    functions: &[Function],
) -> Option<Call> {
    let params = &func.params;
    let args = &call.args;
    if params.len() != args.len() {
        return None;
    }
    let Forwarded {
        wrapped,
        constants,
        used,
    } = forwarded;
    let mut bindings = IndexMap::new();
    for (param, arg) in params.iter().zip(args) {
        if !used.contains(&param.name) && !is_side_effect_free(arg) {
            return None;
        }
        bindings.insert(param.name.clone(), arg.clone());
    }
    let order = wrapped.args.iter().filter_map(|arg| match arg {
        Expr::Ref(r) => Some(params.iter().position(|p| p.name == r.name)),
        _ => None,
    });
    let reordered = order
        .enumerate()
        .any(|(position, index)| index != Some(position));
    if reordered && args.iter().any(|arg| !is_side_effect_free(arg)) {
        return None;
    }
    if *constants > 0 {
        let sites = site_count(&call.name, ctx, functions, &mut IndexSet::new());
        if (*constants as i64) * (sites as i64 - 1) > used.len() as i64 {
            return None;
        }
    }
    let mut rewritten = substitute_call(wrapped, &bindings);
    if !rewritten.ty.is_value() {
        rewritten.ty = Nullable::Value(func.return_type.clone());
    }
    Some(rewritten)
}

/// A non-void forwarder in expression position — `return f(x);` — is `f(x)` where it was called.
pub fn forward_expr_call(
    call: &Call,
    ctx: &mut Ctx,
    functions: &[Function],
) -> Result<Option<Expr>, Unported> {
    let Some(func) = function_named(ctx, functions, &call.name) else {
        return Ok(None);
    };
    if ctx.inlining.contains(&call.name) {
        return Ok(None);
    }
    if !matches!(func.body.first(), Some(Stmt::Return(_))) {
        return Ok(None);
    }
    let Some(forwarded) = forwarded_call(func) else {
        return Ok(None);
    };
    let Some(rewritten) = forward_call(call, func, &forwarded, ctx, functions) else {
        return Ok(None);
    };
    ctx.inlining.insert(call.name.clone());
    let folded = fold_expr(&Expr::Call(rewritten), ctx, functions);
    ctx.inlining.shift_remove(&call.name);
    folded.map(Some)
}

// ---- rule 9: a single caller ----------------------------------------------------------------

pub fn contains_kind(node: &(impl IrValue + ?Sized), kind: &str) -> bool {
    some(node, |n| match n {
        Node::Stmt(s) => stmt_kind(s) == kind,
        Node::Expr(e) => expr_kind(e) == kind,
    })
}

pub fn count_returns(node: &(impl IrValue + ?Sized)) -> usize {
    let mut n = 0;
    node.walk(&mut |node| {
        if matches!(node, Node::Stmt(Stmt::Return(_))) {
            n += 1;
        }
        Flow::Continue
    });
    n
}

/// Every name a body reads or writes as a variable: refs, assignment targets, locals.
pub fn collect_names(node: &(impl IrValue + ?Sized), out: &mut IndexSet<String>) {
    node.walk(&mut |n| {
        match n {
            Node::Expr(Expr::Ref(r)) => {
                out.insert(r.name.clone());
            }
            Node::Stmt(Stmt::Local(l)) => {
                out.insert(l.name.clone());
            }
            Node::Stmt(Stmt::Assign(a)) => {
                out.insert(a.target.clone());
            }
            _ => {}
        }
        Flow::Continue
    });
}

/// The names a function binds itself: its parameters and every local in its body.
pub fn bound_names(func: &Function) -> IndexSet<String> {
    let mut out: IndexSet<String> = func.params.iter().map(|p| p.name.clone()).collect();
    collect_bound_names(func.body.as_slice(), &mut out);
    out
}

/// A name not in `taken`, built from `name`; it is added to `taken`.
pub fn fresh_name(name: &str, taken: &mut IndexSet<String>) -> String {
    let mut out = name.to_string();
    let mut n = 2;
    while taken.contains(&out) {
        out = format!("{name}_{n}");
        n += 1;
    }
    taken.insert(out.clone());
    out
}

/// Every variable a function writes, itself or through anything it calls: assignment targets and
/// string copies. A variable at a hardware address counts as written by any body.
pub fn writes_of(func: &Function, ctx: &Ctx, functions: &[Function]) -> IndexSet<String> {
    fn visit(
        root: &Function,
        f: &Function,
        ctx: &Ctx,
        functions: &[Function],
        out: &mut IndexSet<String>,
        seen: &mut IndexSet<String>,
    ) {
        if !seen.insert(f.name.clone()) {
            return;
        }
        // The function's own writes by name, parameters and locals included; a callee's only for
        // what it does not bind itself — its locals are its own, whatever they happen to be called.
        let mut own = IndexSet::new();
        collect_assigned(f.body.as_slice(), &mut own);
        let mut callees = Vec::new();
        visit_body(&f.body, &mut |n| {
            if let Node::Stmt(Stmt::StringCopy(copy)) = n
                && let Expr::Ref(target) = &copy.target
            {
                own.insert(target.name.clone());
            }
            if let Some(call) = n.as_call() {
                callees.push(call.name.clone());
            }
            Flow::Continue
        });
        for name in callees {
            if let Some(callee) = function_named(ctx, functions, &name) {
                visit(root, callee, ctx, functions, out, seen);
            }
        }
        let bound = if std::ptr::eq(f, root) {
            IndexSet::new()
        } else {
            bound_names(f)
        };
        for name in own {
            if !bound.contains(&name) {
                out.insert(name);
            }
        }
    }
    let mut out = ctx.addressed.clone();
    visit(func, func, ctx, functions, &mut out, &mut IndexSet::new());
    out
}

/// Whether `func`, or anything it calls, has a node `test` accepts.
pub fn reachable_has(
    func: &Function,
    ctx: &Ctx,
    functions: &[Function],
    test: &mut dyn FnMut(Node<'_>) -> bool,
) -> bool {
    fn visit(
        f: &Function,
        ctx: &Ctx,
        functions: &[Function],
        seen: &mut IndexSet<String>,
        test: &mut dyn FnMut(Node<'_>) -> bool,
    ) -> bool {
        if !seen.insert(f.name.clone()) {
            return false;
        }
        visit_body(&f.body, &mut |n| {
            if test(n) {
                return Flow::Stop;
            }
            if let Some(call) = n.as_call()
                && let Some(callee) = function_named(ctx, functions, &call.name)
                && visit(callee, ctx, functions, seen, test)
            {
                return Flow::Stop;
            }
            Flow::Continue
        }) == Flow::Stop
    }
    visit(func, ctx, functions, &mut IndexSet::new(), test)
}

/// Rename the names a callee binds (its parameters, its locals) everywhere in `body`.
pub fn rename_bound(body: &[Stmt], renames: &IndexMap<String, String>) -> Vec<Stmt> {
    let mut out = body.to_vec();
    rewrite_body(&mut out, &mut Rename(renames));
    out
}

/// The callee a call has exactly one live site of, when its body can stand where the call is:
/// not recursive, not empty, no `asm6502`, and — the `return` rule — a void body with a `return`
/// anywhere stays a call, while a non-void body must end in its only `return`.
pub fn single_caller_callee<'a>(
    call: &Call,
    ctx: &Ctx,
    functions: &'a [Function],
    want_value: bool,
) -> Option<&'a Function> {
    let func = function_named(ctx, functions, &call.name)?;
    if ctx.inlining.contains(&call.name) {
        return None;
    }
    // Inside an unrolled copy every site is one of N; inside a forwarder the sites are the
    // forwarder's, and rule 8 puts this call at each of them. The running function is the one
    // the name table holds under `current_fn`.
    if ctx.unrolling_string_copy {
        return None;
    }
    if let Some(current) = ctx
        .current_fn
        .as_deref()
        .and_then(|name| function_named(ctx, functions, name))
        && forwarded_call(current).is_some()
    {
        return None;
    }
    let body = &func.body;
    if body.is_empty() || contains_kind(body.as_slice(), "asm") {
        return None;
    }
    if func.params.len() != call.args.len() {
        return None;
    }
    let return_type = func.return_type.as_str();
    if want_value {
        if return_type == "void" {
            return None;
        }
        let Some(Stmt::Return(last)) = body.last() else {
            return None;
        };
        if last.value.is_none() || count_returns(body.as_slice()) != 1 {
            return None;
        }
    } else if return_type != "void" || contains_return(body.as_slice()) {
        return None;
    }
    if ctx.consumed.contains(&call.name) || ctx.retired.contains(&call.name) {
        return None;
    }
    if site_count(&call.name, ctx, functions, &mut IndexSet::new()) != 1 {
        return None;
    }
    Some(func)
}

/// How many places a function is called from once every forwarder of it has been written out: a
/// forwarder's own sites are the wrapped function's. Counted over the bodies as they stand.
pub fn site_count(
    name: &str,
    ctx: &Ctx,
    functions: &[Function],
    seen: &mut IndexSet<String>,
) -> usize {
    if seen.contains(name) {
        return 2;
    }
    seen.insert(name.to_string());
    let mut n = 0;
    for &index in ctx.functions_by_name.values() {
        let Some(func) = functions.get(index) else {
            continue;
        };
        // A body written into its one caller stands in for that copy until the caller's own
        // optimized body is stored; after that it is counted there, and the original is on its
        // way out.
        if ctx.retired.contains(&func.name) {
            continue;
        }
        let direct = count_calls_in(func.body.as_slice(), name);
        if direct == 0 {
            continue;
        }
        n += match forwarded_call(func) {
            Some(forwarded) if forwarded.wrapped.name == name => {
                site_count(&func.name, ctx, functions, seen)
            }
            _ => direct,
        };
    }
    n
}

pub fn count_calls_in(body: &[Stmt], name: &str) -> usize {
    let mut n = 0;
    visit_body(body, &mut |node| {
        if node.as_call().is_some_and(|call| call.name == name) {
            n += 1;
        }
        Flow::Continue
    });
    n
}

/// What `siteBody` builds: the callee's body made to stand at a call site.
#[derive(Debug, Clone, PartialEq)]
pub struct SiteBody {
    pub statements: Vec<Stmt>,
    pub returned: Option<Expr>,
    pub locals: IndexMap<String, Option<String>>,
    pub free: IndexSet<String>,
}

/// The callee's body, made to stand at the call site: its own names made fresh so nothing in the
/// caller is shadowed, each parameter either the argument itself or a local holding it. `None`
/// when a name the body reads without binding is one the caller binds, or a string or array
/// argument would need a local.
pub fn site_body(
    call: &Call,
    func: &Function,
    ctx: &mut Ctx,
    functions: &[Function],
) -> Option<SiteBody> {
    // JS reads an argument the call lacks as undefined and throws; refuse before any side effect.
    if call.args.len() < func.params.len() {
        return None;
    }
    let bound = bound_names(func);
    let mut free = IndexSet::new();
    collect_names(func.body.as_slice(), &mut free);
    for name in &bound {
        free.shift_remove(name);
    }
    if free.iter().any(|name| ctx.caller_bound.contains(name)) {
        return None;
    }
    let assigned = writes_of(func, ctx, functions);
    let mut renames = IndexMap::new();
    for name in &bound {
        let fresh = fresh_name(name, &mut ctx.taken);
        ctx.zp_names.insert(fresh.clone());
        renames.insert(name.clone(), fresh);
    }
    let params = &func.params;
    let args = &call.args;
    let mut statements = Vec::new();
    let mut bindings = IndexMap::new();
    for (param, arg) in params.iter().zip(args) {
        let renamed = renames
            .get(&param.name)
            .cloned()
            .unwrap_or_else(|| param.name.clone());
        let plain_read = match arg {
            Expr::Ref(r) if !assigned.contains(&r.name) => Some(&r.name),
            _ => None,
        };
        // A read of the caller's own local or parameter is a zero-page read, as the parameter's
        // was; a global is an absolute read, one byte more at every use, so it is copied into a
        // local once — the store the call made — and read from there. An array is its address
        // either way.
        let zero_page =
            plain_read.is_some_and(|name| ctx.zp_names.contains(name) || param.ty == "array");
        if (is_compile_time_arg(arg) || zero_page) && !assigned.contains(&param.name) {
            bindings.insert(renamed, arg.clone());
        } else if param.ty == "string" || param.ty == "array" || expr_type(arg) == Some("string") {
            // A string or an array is a pointer the backends only hold in a parameter slot or a
            // global; there is no local to copy it into.
            return None;
        } else {
            statements.push(Stmt::Local(Local {
                name: renamed,
                ty: param.ty.clone(),
                init: arg.clone(),
                inlined: Some(true),
                start: None,
                length: None,
            }));
        }
    }
    let mut body = substitute_bindings(&rename_bound(&func.body, &renames), &bindings);
    let mut returned = None;
    if func.return_type != "void" {
        // The caller guarantees a last `return`; a body without one gives no value.
        if let Some(Stmt::Return(last)) = body.pop() {
            returned = last.value;
        }
    }
    let mut locals = IndexMap::new();
    for statement in &body {
        if let Stmt::Local(local) = statement {
            locals.insert(local.name.clone(), Some(local.ty.clone()));
        }
    }
    ctx.consumed.insert(func.name.clone());
    statements.extend(body);
    Some(SiteBody {
        statements,
        returned,
        locals,
        free,
    })
}

/// The first single-caller call in a statement's expressions (not in the statement lists control
/// flow owns, nor a `for`'s `local` init), children before the call itself.
pub fn find_value_call<'a>(
    statement: &'a Stmt,
    ctx: &Ctx,
    functions: &[Function],
) -> Option<&'a Call> {
    let container = match statement {
        Stmt::Call(call) => Some(call),
        _ => None,
    };
    find_value_call_stmt(statement, ctx, functions, container)
}

/// The statement's own expressions in order; a `for`'s init and update are statements of their own.
fn find_value_call_stmt<'a>(
    statement: &'a Stmt,
    ctx: &Ctx,
    functions: &[Function],
    container: Option<&Call>,
) -> Option<&'a Call> {
    let search = |expr: &'a Expr| find_value_call_expr(expr, ctx, functions, container);
    let nested = |inner: &'a Stmt| {
        find_value_call_stmt(inner, ctx, functions, container).or_else(|| match inner {
            Stmt::Call(call)
                if !container.is_some_and(|c| std::ptr::eq(c, call))
                    && single_caller_callee(call, ctx, functions, true).is_some() =>
            {
                Some(call)
            }
            _ => None,
        })
    };
    match statement {
        Stmt::Local(s) => search(&s.init),
        Stmt::Assign(s) => search(&s.value),
        Stmt::Call(s) => s.args.iter().find_map(search),
        Stmt::MemoryRead(s) => search(&s.address),
        Stmt::MemoryWrite(s) => search(&s.address).or_else(|| search(&s.value)),
        Stmt::StoreIndex(s) => search(&s.array)
            .or_else(|| search(&s.index))
            .or_else(|| search(&s.value)),
        Stmt::Return(s) => s.value.as_ref().and_then(search),
        Stmt::If(s) => search(&s.test),
        Stmt::While(s) => search(&s.test),
        Stmt::For(s) => {
            let init = match s.init.as_option().map(|init| &**init) {
                Some(Stmt::Local(_)) | None => None,
                Some(init) => nested(init),
            };
            init.or_else(|| s.test.as_option().and_then(search))
                .or_else(|| {
                    s.update
                        .as_option()
                        .map(|update| &**update)
                        .and_then(nested)
                })
        }
        Stmt::PortWrite(s) => search(&s.port).or_else(|| search(&s.value)),
        Stmt::StringCopy(s) => search(&s.target).or_else(|| search(&s.source)),
        Stmt::NamespaceCall(s) => s.args.iter().find_map(search),
        Stmt::PortRead(s) => search(&s.port),
        Stmt::Asm(_) | Stmt::Block(_) | Stmt::Break(_) | Stmt::Continue(_) | Stmt::WaitFrame(_) => {
            None
        }
    }
}

fn find_value_call_expr<'a>(
    expr: &'a Expr,
    ctx: &Ctx,
    functions: &[Function],
    container: Option<&Call>,
) -> Option<&'a Call> {
    let search = |inner: &'a Expr| find_value_call_expr(inner, ctx, functions, container);
    let hit = match expr {
        Expr::Const(_) | Expr::Ref(_) | Expr::String(_) | Expr::NamespaceConst(_) => None,
        Expr::Binop(e) => search(&e.left).or_else(|| search(&e.right)),
        Expr::Call(e) => e.args.iter().find_map(search),
        Expr::Index(e) => search(&e.array).or_else(|| search(&e.index)),
        Expr::MemoryRead(e) => search(&e.address),
        Expr::StringByte(e) => search(&e.string).or_else(|| search(&e.index)),
        Expr::StringLength(e) => search(&e.string),
        Expr::Unop(e) => search(&e.argument),
        Expr::Cond(e) => search(&e.test)
            .or_else(|| search(&e.consequent))
            .or_else(|| search(&e.alternate)),
        Expr::PortRead(e) => search(&e.port),
        Expr::PortWrite(e) => search(&e.port).or_else(|| search(&e.value)),
        Expr::NamespaceCall(e) => e.args.iter().find_map(search),
        Expr::Record(e) => e.fields.iter().find_map(|field| search(&field.value)),
    };
    if hit.is_some() {
        return hit;
    }
    match expr {
        Expr::Call(call)
            if !container.is_some_and(|c| std::ptr::eq(c, call))
                && single_caller_callee(call, ctx, functions, true).is_some() =>
        {
            Some(call)
        }
        _ => None,
    }
}

/// `statement` with the one call node `target` (a node of `statement`, found by identity)
/// replaced by `replacement`.
pub fn replace_node(statement: &Stmt, target: &Call, replacement: &Expr) -> Stmt {
    let mut ordinal = 0;
    let mut found = None;
    visit_stmt(statement, &mut |node| {
        if let Node::Expr(Expr::Call(call)) = node {
            if std::ptr::eq(call, target) {
                found = Some(ordinal);
                return Flow::Stop;
            }
            ordinal += 1;
        }
        Flow::Continue
    });
    let mut out = statement.clone();
    if let Some(target) = found {
        rewrite_stmt(
            &mut out,
            &mut ReplaceCall {
                target,
                seen: 0,
                with: replacement,
            },
        );
    }
    out
}

/// Whether the rest of `statement`, with `call` taken out, would run the same before the callee's
/// body as after it: only constants, reads, and arithmetic on them — no other call, no hardware or
/// array read — and no read of a variable the callee writes.
pub fn rest_is_inert(
    statement: &Stmt,
    call: &Call,
    func: &Function,
    ctx: &Ctx,
    functions: &[Function],
) -> bool {
    fn inert(expr: &Expr, call: &Call, assigned: &IndexSet<String>, stores: bool) -> bool {
        let again = |inner: &Expr| inert(inner, call, assigned, stores);
        match expr {
            Expr::Call(c) => std::ptr::eq(c, call),
            Expr::Ref(r) => {
                !assigned.contains(&r.name)
                    && !(stores && r.ty.as_option().map(String::as_str) == Some("string"))
            }
            Expr::Index(e) => !stores && again(&e.index),
            Expr::Const(_) | Expr::String(_) | Expr::NamespaceConst(_) => true,
            Expr::Binop(e) => again(&e.left) && again(&e.right),
            Expr::Unop(e) => again(&e.argument),
            Expr::StringByte(e) => again(&e.string) && again(&e.index),
            Expr::StringLength(e) => again(&e.string),
            _ => false,
        }
    }
    let assigned = writes_of(func, ctx, functions);
    let stores = reachable_has(func, ctx, functions, &mut |node| {
        matches!(
            node,
            Node::Stmt(Stmt::StoreIndex(_) | Stmt::MemoryWrite(_) | Stmt::StringCopy(_))
        )
    });
    let again = |expr: &Expr| inert(expr, call, &assigned, stores);
    match statement {
        Stmt::Local(s) => again(&s.init),
        Stmt::Assign(s) => again(&s.value),
        Stmt::Call(s) if std::ptr::eq(s, call) => true,
        Stmt::Call(s) => s.args.iter().all(again),
        Stmt::MemoryWrite(s) => again(&s.address) && again(&s.value),
        Stmt::StoreIndex(s) => again(&s.array) && again(&s.index) && again(&s.value),
        Stmt::Return(s) => s.value.as_ref().is_none_or(again),
        Stmt::If(s) => again(&s.test),
        Stmt::While(s) => again(&s.test),
        // A for's init and update are statements, never pure expressions; only the found call
        // statement itself is inert (JS `node === call`).
        Stmt::For(s) => {
            let is_call = |part: &Stmt| matches!(part, Stmt::Call(c) if std::ptr::eq(c, call));
            s.init.as_option().is_none_or(|init| is_call(init))
                && s.update.as_option().is_none_or(|update| is_call(update))
                && s.test.as_option().is_none_or(again)
        }
        Stmt::MemoryRead(s) => again(&s.address),
        Stmt::PortWrite(s) => again(&s.port) && again(&s.value),
        Stmt::PortRead(s) => again(&s.port),
        Stmt::StringCopy(s) => again(&s.target) && again(&s.source),
        Stmt::NamespaceCall(s) => s.args.iter().all(again),
        Stmt::Asm(_) | Stmt::Block(_) | Stmt::Break(_) | Stmt::Continue(_) | Stmt::WaitFrame(_) => {
            true
        }
    }
}

/// Statement kinds whose expressions run once, in order, right where they stand.
fn hoistable(statement: &Stmt) -> bool {
    matches!(
        statement,
        Stmt::Local(_)
            | Stmt::Assign(_)
            | Stmt::Call(_)
            | Stmt::MemoryWrite(_)
            | Stmt::StoreIndex(_)
            | Stmt::Return(_)
            | Stmt::If(_)
    )
}

fn origin_block(origin: &str, body: Vec<Stmt>) -> Stmt {
    Stmt::Block(Block {
        body,
        origin: Some(origin.to_string()),
        start: None,
        length: None,
    })
}

/// Rule 9 for a value: the first single-caller call in `statement` whose body can run ahead of it
/// is that body, then the statement reading the returned expression where the call was. `let r =
/// f(x)` whose value is one of f's own locals keeps that local as `r` — no copy.
pub fn hoist_value_call(
    statement: &Stmt,
    ctx: &mut Ctx,
    functions: &[Function],
) -> Result<Option<Vec<Stmt>>, Unported> {
    if !hoistable(statement) {
        return Ok(None);
    }
    let Some(call) = find_value_call(statement, ctx, functions) else {
        return Ok(None);
    };
    let Some(func) = function_named(ctx, functions, &call.name) else {
        return Ok(None);
    };
    if !rest_is_inert(statement, call, func, ctx, functions) {
        return Ok(None);
    }
    let Some(site) = site_body(call, func, ctx, functions) else {
        return Ok(None);
    };
    // A body the caller can read a value from always ends in its `return`; no value, no hoist.
    let SiteBody {
        mut statements,
        returned: Some(returned),
        locals,
        ..
    } = site
    else {
        return Ok(None);
    };
    let kept_local = match (statement, &returned) {
        (Stmt::Local(local), Expr::Ref(r))
            if matches!(&local.init, Expr::Call(c) if std::ptr::eq(c, call))
                && locals
                    .get(&r.name)
                    .is_some_and(|ty| ty.as_deref() == Some(local.ty.as_str())) =>
        {
            // The caller's name must be new to the pasted body: not a global it reads, not an
            // argument it was handed.
            let mut names = IndexSet::new();
            collect_names(statements.as_slice(), &mut names);
            (!names.contains(&local.name)).then(|| (r.name.clone(), local.name.clone()))
        }
        _ => None,
    };
    let rest = if let Some((from, to)) = kept_local {
        statements = rename_bound(&statements, &IndexMap::from([(from, to)]));
        Vec::new()
    } else {
        vec![replace_node(statement, call, &returned)]
    };
    ctx.inlining.insert(call.name.clone());
    let inlined = optimize_body(&statements, ctx, functions).and_then(|mut first| {
        first.extend(optimize_body(&rest, ctx, functions)?);
        Ok(first)
    });
    // A statement that declares nothing the code after it reads can take the callee's locals in a
    // block of its own, so their zero page is released when it ends — as the callee's frame was.
    let outcome = inlined.map(|inlined| {
        if matches!(statement, Stmt::Local(_)) || ctx.inlining.len() > 1 {
            inlined
        } else {
            vec![origin_block(&call.name, inlined)]
        }
    });
    ctx.inlining.shift_remove(&call.name);
    outcome.map(Some)
}

/// Rule 9 for a void call statement: the callee's body, in a block of its own.
pub fn inline_single_caller(
    statement: &Call,
    func: &Function,
    ctx: &mut Ctx,
    functions: &[Function],
) -> Result<Option<Vec<Stmt>>, Unported> {
    let Some(site) = site_body(statement, func, ctx, functions) else {
        return Ok(None);
    };
    ctx.inlining.insert(statement.name.clone());
    let outcome = optimize_body(&site.statements, ctx, functions).map(|inlined| {
        if ctx.inlining.len() > 1 {
            inlined
        } else {
            vec![origin_block(&statement.name, inlined)]
        }
    });
    ctx.inlining.shift_remove(&statement.name);
    outcome.map(Some)
}

pub fn inline_void_call(
    statement: &Call,
    ctx: &mut Ctx,
    functions: &[Function],
) -> Result<Option<Vec<Stmt>>, Unported> {
    let Some(func) = function_named(ctx, functions, &statement.name) else {
        return Ok(None);
    };
    if func.body.is_empty() {
        if statement.args.iter().any(|arg| !is_side_effect_free(arg)) {
            return Ok(None);
        }
        return Ok(Some(Vec::new()));
    }
    if !func.return_type.is_empty() && func.return_type != "void" {
        return Ok(None);
    }
    if ctx.inlining.contains(&statement.name) {
        return Ok(None);
    }
    // Rewrite 8: a void forwarder is the call it wraps, whatever its arguments are — and the
    // result goes round again, so a forwarder of a forwarder, or of an empty function, or of a
    // body the rules below inline, ends where a hand-written call would.
    if let Some(forwarded) = forwarded_call(func)
        && let Some(rewritten) = forward_call(statement, func, &forwarded, ctx, functions)
    {
        ctx.inlining.insert(statement.name.clone());
        let result = optimize_statement(&Stmt::Call(rewritten), ctx, functions);
        ctx.inlining.shift_remove(&statement.name);
        return result.map(Some);
    }
    // A `return` inside the body would stop meaning "leave this callee" once the body is pasted
    // into the caller; a body with a return anywhere stays a real call.
    if contains_return(func.body.as_slice()) {
        return Ok(None);
    }
    let params = &func.params;
    let args = &statement.args;
    if params.len() != args.len() || !args.iter().all(is_compile_time_arg) {
        return Ok(None);
    }
    let param_names: IndexSet<String> = params.iter().map(|p| p.name.clone()).collect();
    let unused_params = !params.is_empty() && !references_names(func.body.as_slice(), &param_names);
    let string_copy = contains_string_byte(func.body.as_slice()) || ctx.unrolling_string_copy;
    // A component is a composition written as a function: when every prop is a compile-time value
    // the element is its body with those values in.
    let component = func.component == Some(true);
    if !params.is_empty() && !string_copy && !unused_params && !component {
        return Ok(None);
    }
    let sites = |ctx: &Ctx| site_count(&statement.name, ctx, functions, &mut IndexSet::new());
    if unused_params && sites(ctx) > 1 {
        return Ok(None);
    }
    // Inlining a body that more than one place calls writes that body out once per call site: a
    // win only while the body is smaller than the call it replaces.
    if node_count(&func.body) > INLINE_DUPLICATE_NODE_LIMIT && sites(ctx) > 1 {
        return Ok(None);
    }
    let bindings: IndexMap<String, Expr> = params
        .iter()
        .zip(args)
        .map(|(param, arg)| (param.name.clone(), arg.clone()))
        .collect();
    ctx.inlining.insert(statement.name.clone());
    let inlined = optimize_body(&substitute_bindings(&func.body, &bindings), ctx, functions)?;
    ctx.inlining.shift_remove(&statement.name);
    if !ctx.inlining.is_empty() {
        return Ok(Some(inlined));
    }
    Ok(Some(vec![origin_block(&statement.name, inlined)]))
}

/// Stub: `optimizeStatement` (`:1214`) belongs to a later unit.
pub fn optimize_statement(
    _statement: &Stmt,
    _ctx: &mut Ctx,
    _functions: &[Function],
) -> Result<Vec<Stmt>, Unported> {
    Err(Unported)
}
