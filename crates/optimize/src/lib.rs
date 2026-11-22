//! Port of `packages/compiler/src/linker/optimize.mjs:1-666`: the leaf passes of the
//! pre-lowering IR rewrites. The functions the rest of the file calls (`substitute_bindings`,
//! `forward_expr_call`, `site_count`, `optimize_statement`) are stubs that return `Unported`.

use diagnostics::Diagnostic;
use indexmap::{IndexMap, IndexSet};
use jsnum::{Nullable, to_int32};
use mos_ir::walk::{Flow, Node, visit_body, visit_expr, visit_stmt};
use mos_ir::{Asm, Binop, Call, Const, Expr, For, Function, IrString, Stmt};
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
    if site_count(&call.name, ctx, functions, &mut IndexSet::new())? > 1 {
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
        let substituted = optimize_body(&substitute_bindings(rest, &bindings)?, ctx, functions)?;
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

/// Stub: `substituteBindings` (`:667`) belongs to a later unit.
pub fn substitute_bindings(
    _body: &[Stmt],
    _bindings: &IndexMap<String, Expr>,
) -> Result<Vec<Stmt>, Unported> {
    Err(Unported)
}

/// Stub: `forwardExprCall` (`:758`) belongs to a later unit.
pub fn forward_expr_call(
    _call: &Call,
    _ctx: &mut Ctx,
    _functions: &[Function],
) -> Result<Option<Expr>, Unported> {
    Err(Unported)
}

/// Stub: `siteCount` (`:930`) belongs to a later unit.
pub fn site_count(
    _name: &str,
    _ctx: &Ctx,
    _functions: &[Function],
    _seen: &mut IndexSet<String>,
) -> Result<usize, Unported> {
    Err(Unported)
}

/// Stub: `optimizeStatement` (`:1214`) belongs to a later unit.
pub fn optimize_statement(
    _statement: &Stmt,
    _ctx: &mut Ctx,
    _functions: &[Function],
) -> Result<Vec<Stmt>, Unported> {
    Err(Unported)
}
