//! Port of `packages/compiler/src/wasm/lower.ts:1-230`: the lowering context and its helpers.
//!
//! Plus `wasm/lower.ts:231-738`: instruction selection (`binop` to `lower`).
//!
//! `IrExpr` and `IrStatement` are `mos_ir::{Expr, Stmt}`; `LowerError` is `WasmError::Lower`.

use indexmap::IndexMap;
use mos_ir::{Binop, Call, Expr, Stmt, Unop};
use sema::types::{resolve_integer_type, storage_bytes};

use crate::WasmError;
use crate::encode::{
    block_type, memarg, memory_copy, opcode, signed_leb128, unsigned_leb128, val_type,
};

/// What a `controlStack` entry stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Break,
    Continue,
    Plain,
}

/// One entry of `Ctx.functions`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionInfo {
    pub index: u32,
    pub param_count: u32,
    pub returns_value: bool,
}

/// One entry of `Ctx.arrays`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArrayInfo {
    pub address: u32,
    pub element_width: u32,
    pub mutable: bool,
}

/// One entry of `Ctx.pinned`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedInfo {
    pub address: u32,
    pub width: u32,
}

/// The lowering context (`Ctx` in `lower.ts`), fields in the JS order.
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    /// Every name currently in scope, to its wasm local index.
    pub locals: IndexMap<String, u32>,
    /// The next unused local index.
    pub next_local: u32,
    /// Every non-pinned scalar global, to its wasm global-section index.
    pub globals: IndexMap<String, u32>,
    /// One entry per open `if` or loop construct, outermost first.
    pub control_stack: Vec<Control>,
    /// Every function this module defines, name to its wasm function index.
    pub functions: IndexMap<String, FunctionInfo>,
    /// Every string literal's linear-memory address, by its index in `ir.strings`.
    pub strings: Vec<u32>,
    /// Every array this module declares, name to address, element width and mutability.
    pub arrays: IndexMap<String, ArrayInfo>,
    /// Every `@address(...)`-pinned scalar global.
    pub pinned: IndexMap<String, PinnedInfo>,
    /// The imported `env.waitFrame`'s wasm function index, `None` when the program never waits.
    pub wait_frame_index: Option<u32>,
}

/// `i32Const`: `i32.const` and its signed LEB128 operand.
///
/// # Errors
/// `n` is not an integer.
pub fn i32_const(n: f64) -> Result<Vec<u8>, WasmError> {
    let mut code = vec![opcode::I32_CONST];
    code.extend(signed_leb128(n)?);
    Ok(code)
}

/// The get/set instruction pair and index `binding` returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Binding {
    pub get: u8,
    pub set: u8,
    pub index: u32,
}

/// `binding`: `name` as a local (checked first, so a local shadows a global) or a global.
///
/// # Errors
/// `name` is neither.
pub fn binding(ctx: &Ctx, name: &str) -> Result<Binding, WasmError> {
    if let Some(&index) = ctx.locals.get(name) {
        return Ok(Binding {
            get: opcode::LOCAL_GET,
            set: opcode::LOCAL_SET,
            index,
        });
    }
    if let Some(&index) = ctx.globals.get(name) {
        return Ok(Binding {
            get: opcode::GLOBAL_GET,
            set: opcode::GLOBAL_SET,
            index,
        });
    }
    Err(WasmError::Lower(format!(
        "'{name}' is not a lowered local or global — parameters aren't lowered yet"
    )))
}

/// `maskToType`: masks a just-computed `i32` result down to `ty`'s declared width.
///
/// # Errors
/// `ty` is a signed integer type narrower than 32 bits.
pub fn mask_to_type(mut code: Vec<u8>, ty: Option<&str>) -> Result<Vec<u8>, WasmError> {
    let ty = match ty {
        None | Some("" | "bool") => return Ok(code),
        Some(ty) => ty,
    };
    let Some(info) = resolve_integer_type(ty) else {
        return Ok(code);
    };
    if info.bits == 32 {
        return Ok(code);
    }
    if info.signed {
        return Err(WasmError::Lower(format!(
            "arithmetic producing a signed '{ty}' (narrower than 32 bits) is not lowered yet — only unsigned narrower types are masked so far"
        )));
    }
    code.extend(i32_const(2f64.powi(info.bits as i32) - 1.0)?);
    code.push(opcode::I32_AND);
    Ok(code)
}

/// `UNSIGNED_ORDERING`, in the JS order.
pub const UNSIGNED_ORDERING: [(&str, u8); 4] = [
    ("<", opcode::I32_LT_U),
    (">", opcode::I32_GT_U),
    ("<=", opcode::I32_LE_U),
    (">=", opcode::I32_GE_U),
];

/// `EQUALITY`, in the JS order.
pub const EQUALITY: [(&str, u8); 2] = [("==", opcode::I32_EQ), ("!=", opcode::I32_NE)];

/// `UNSIGNED_ORDERING[operator]`.
#[must_use]
pub fn unsigned_ordering(operator: &str) -> Option<u8> {
    UNSIGNED_ORDERING
        .iter()
        .find(|(k, _)| *k == operator)
        .map(|(_, v)| *v)
}

/// `EQUALITY[operator]`.
#[must_use]
pub fn equality(operator: &str) -> Option<u8> {
    EQUALITY
        .iter()
        .find(|(k, _)| *k == operator)
        .map(|(_, v)| *v)
}

/// A node's `type` field, `None` for `null`, absent, or a kind that has none.
fn node_type(node: &Expr) -> Option<&str> {
    match node {
        Expr::Binop(n) => n.ty.as_deref(),
        Expr::Call(n) => n.ty.as_option().map(String::as_str),
        Expr::Const(n) => n.ty.as_deref(),
        Expr::Index(n) => n.ty.as_deref(),
        Expr::MemoryRead(n) => Some(&n.ty),
        Expr::Ref(n) => n.ty.as_option().map(String::as_str),
        Expr::String(n) => n.ty.as_option().map(String::as_str),
        Expr::StringByte(n) => Some(&n.ty),
        Expr::StringLength(n) => Some(&n.ty),
        Expr::Unop(n) => n.ty.as_deref(),
        Expr::Cond(n) => n.ty.as_option().map(String::as_str),
        Expr::PortRead(n) => Some(&n.ty),
        Expr::NamespaceCall(n) => n.ty.as_option().map(String::as_str),
        Expr::NamespaceConst(n) => n.ty.as_option().map(String::as_str),
        Expr::Record(_) | Expr::PortWrite(_) => None,
    }
}

/// `operandIsSigned`: whether the operand's declared type is a signed integer.
#[must_use]
pub fn operand_is_signed(node: &Expr) -> bool {
    match node_type(node) {
        None | Some("" | "bool") => false,
        Some(ty) => resolve_integer_type(ty).is_some_and(|info| info.signed),
    }
}

/// Instruction bytes, or the error `lower` turns into a `LowerFailure`.
type Code = Result<Vec<u8>, WasmError>;

fn lower_error(message: String) -> WasmError {
    WasmError::Lower(message)
}

fn uleb(n: u32) -> Code {
    unsigned_leb128(f64::from(n))
}

/// `binop`.
fn binop(node: &Binop, ctx: &mut Ctx) -> Code {
    let operator = node.operator.as_str();
    let left = &*node.left;
    let right = &*node.right;

    if operator == "&&" || operator == "||" {
        // Left-to-right, short-circuit: `right` only runs when it can change the result.
        let a = expr(left, ctx)?;
        let b = expr(right, ctx)?;
        // This `if` produces a value, so its blocktype is `i32`, not empty.
        let mut code = a;
        code.push(opcode::IF);
        code.push(val_type::I32);
        if operator == "&&" {
            code.extend(b);
            code.push(opcode::ELSE);
            code.extend(i32_const(0.0)?);
        } else {
            code.extend(i32_const(1.0)?);
            code.push(opcode::ELSE);
            code.extend(b);
        }
        code.push(opcode::END);
        return Ok(code);
    }
    if let Some(op) = equality(operator) {
        let mut code = expr(left, ctx)?;
        code.extend(expr(right, ctx)?);
        code.push(op);
        return Ok(code);
    }
    if let Some(op) = unsigned_ordering(operator) {
        if operand_is_signed(left) || operand_is_signed(right) {
            return Err(lower_error(format!(
                "'{operator}' on a signed value is not lowered yet — only unsigned ordering comparisons are"
            )));
        }
        let mut code = expr(left, ctx)?;
        code.extend(expr(right, ctx)?);
        code.push(op);
        return Ok(code);
    }
    let arith = |op: u8, ctx: &mut Ctx| -> Code {
        let mut code = expr(left, ctx)?;
        code.extend(expr(right, ctx)?);
        code.push(op);
        mask_to_type(code, node.ty.as_deref())
    };
    if operator == "+" || operator == "-" {
        return arith(
            if operator == "+" {
                opcode::I32_ADD
            } else {
                opcode::I32_SUB
            },
            ctx,
        );
    }
    if operator == "*" {
        // The low 32 bits of a product are the same for signed and unsigned operands.
        return arith(opcode::I32_MUL, ctx);
    }
    if operator == "/" || operator == "%" {
        // Unsigned only so far.
        if operand_is_signed(left) || operand_is_signed(right) {
            return Err(lower_error(format!(
                "'{operator}' on a signed value is not lowered yet — only unsigned '/'/'%' are"
            )));
        }
        return arith(
            if operator == "/" {
                opcode::I32_DIV_U
            } else {
                opcode::I32_REM_U
            },
            ctx,
        );
    }
    if operator == "&" || operator == "|" || operator == "^" {
        // A bitwise op reads the same two's-complement bits whatever the declared type.
        let op = if operator == "&" {
            opcode::I32_AND
        } else if operator == "|" {
            opcode::I32_OR
        } else {
            opcode::I32_XOR
        };
        return arith(op, ctx);
    }
    if operator == "<<" || operator == ">>" {
        // `i32.shr_s` and `i32.shr_u` differ; only the unsigned one is wired up.
        if operator == ">>" && operand_is_signed(left) {
            return Err(lower_error(
                "'>>' on a signed value is not lowered yet — only unsigned '>>' is".to_string(),
            ));
        }
        return arith(
            if operator == "<<" {
                opcode::I32_SHL
            } else {
                opcode::I32_SHR_U
            },
            ctx,
        );
    }
    Err(lower_error(format!("'{operator}' is not lowered yet")))
}

/// `unop`.
fn unop(node: &Unop, ctx: &mut Ctx) -> Code {
    let operator = node.operator.as_str();
    let argument = &*node.argument;
    if operator == "!" {
        let mut code = expr(argument, ctx)?;
        code.push(opcode::I32_EQZ);
        return Ok(code);
    }
    if operator == "+" {
        return expr(argument, ctx);
    }
    if operator == "-" {
        let mut code = i32_const(0.0)?;
        code.extend(expr(argument, ctx)?);
        code.push(opcode::I32_SUB);
        return mask_to_type(code, node.ty.as_deref());
    }
    if operator == "~" {
        let mut code = expr(argument, ctx)?;
        code.extend(i32_const(-1.0)?);
        code.push(opcode::I32_XOR);
        return mask_to_type(code, node.ty.as_deref());
    }
    Err(lower_error(format!("'{operator}' is not lowered yet")))
}

/// `callTarget`: `name`'s entry in `ctx.functions`, or a linker-bug error.
fn call_target<'a>(ctx: &'a Ctx, name: &str) -> Result<&'a FunctionInfo, WasmError> {
    ctx.functions.get(name).ok_or_else(|| {
        lower_error(format!(
            "call to '{name}' resolves to nothing this backend knows about — a linker bug, not a missing lowering rule"
        ))
    })
}

/// `callSite`: every argument left to right onto the operand stack, then `call`.
fn call_site(node: &Call, ctx: &mut Ctx) -> Code {
    let (index, param_count) = {
        let target = call_target(ctx, &node.name)?;
        (target.index, target.param_count)
    };
    let args = &node.args;
    if args.len() != param_count as usize {
        return Err(lower_error(format!(
            "call to '{}': {} argument(s) but the function has {} parameter(s) — the linker should already have matched these",
            node.name,
            args.len(),
            param_count
        )));
    }
    let mut code = Vec::new();
    for a in args {
        code.extend(expr(a, ctx)?);
    }
    code.push(opcode::CALL);
    code.extend(uleb(index)?);
    Ok(code)
}

/// The JS `node.name` of an array operand: `undefined` when it is not a `ref`.
fn array_name(node: &Expr) -> &str {
    match node {
        Expr::Ref(r) => &r.name,
        _ => "undefined",
    }
}

/// `expr`.
fn expr(node: &Expr, ctx: &mut Ctx) -> Code {
    match node {
        Expr::Const(c) => i32_const(c.value as f64),
        Expr::Ref(r) => {
            // A scalar reads its local/global; an array decays to its fixed address; a pinned
            // scalar reads its value at the pin (checked first).
            let name = r.name.as_str();
            if let Some(pin) = ctx.pinned.get(name) {
                let load = if pin.width == 2 {
                    opcode::I32_LOAD16_U
                } else {
                    opcode::I32_LOAD8_U
                };
                let mut code = i32_const(0.0)?;
                code.push(load);
                code.extend(memarg(0.0, f64::from(pin.address))?);
                return Ok(code);
            }
            if !ctx.locals.contains_key(name)
                && !ctx.globals.contains_key(name)
                && let Some(array) = ctx.arrays.get(name)
            {
                return i32_const(f64::from(array.address));
            }
            let b = binding(ctx, name)?;
            let mut code = vec![b.get];
            code.extend(uleb(b.index)?);
            Ok(code)
        }
        Expr::Binop(b) => binop(b, ctx),
        Expr::Unop(u) => unop(u, ctx),
        Expr::Cond(c) => {
            // Only the taken arm runs; a `select` would evaluate both.
            let mut code = expr(&c.test, ctx)?;
            code.push(opcode::IF);
            code.push(block_type::I32);
            code.extend(expr(&c.consequent, ctx)?);
            code.push(opcode::ELSE);
            code.extend(expr(&c.alternate, ctx)?);
            code.push(opcode::END);
            Ok(code)
        }
        Expr::MemoryRead(m) => {
            // Byte-only at the language level: `i32.load8_u` zero-extends the one byte.
            let mut code = expr(&m.address, ctx)?;
            code.push(opcode::I32_LOAD8_U);
            code.extend(memarg(0.0, 0.0)?);
            Ok(code)
        }
        Expr::Call(c) => call_site(c, ctx),
        Expr::String(s) => {
            let slot = s.index;
            let address = usize::try_from(slot)
                .ok()
                .and_then(|i| ctx.strings.get(i).copied());
            match address {
                Some(address) => i32_const(f64::from(address)),
                None => Err(lower_error(format!(
                    "string literal #{slot} resolves to nothing this backend knows about — a linker bug, not a missing lowering rule"
                ))),
            }
        }
        Expr::StringLength(s) => {
            // Byte 0 of the string's data.
            let mut code = expr(&s.string, ctx)?;
            code.push(opcode::I32_LOAD8_U);
            code.extend(memarg(0.0, 0.0)?);
            Ok(code)
        }
        Expr::StringByte(s) => {
            // Byte `index + 1`, past the one-byte length prefix.
            let mut code = expr(&s.string, ctx)?;
            code.extend(expr(&s.index, ctx)?);
            code.push(opcode::I32_ADD);
            code.push(opcode::I32_LOAD8_U);
            code.extend(memarg(0.0, 1.0)?);
            Ok(code)
        }
        Expr::Index(i) => {
            let array = array_entry(ctx, array_name(&i.array))?.clone();
            // The base address folds into the load's memarg offset. A 2-byte element doubles
            // the index into a byte offset and reads both bytes at once.
            let (index, offset) = split_index_offset(&i.index);
            let mut code = expr(index, ctx)?;
            if array.element_width == 2 {
                code.extend(i32_const(1.0)?);
                code.push(opcode::I32_SHL);
                code.push(opcode::I32_LOAD16_U);
                code.extend(memarg(0.0, f64::from(array.address) + 2.0 * offset)?);
                return Ok(code);
            }
            code.push(opcode::I32_LOAD8_U);
            code.extend(memarg(0.0, f64::from(array.address) + offset)?);
            Ok(code)
        }
        Expr::Record(_) => Err(lower_error(unsupported("record"))),
        Expr::PortRead(_) => Err(lower_error(unsupported("portRead"))),
        Expr::PortWrite(_) => Err(lower_error(unsupported("portWrite"))),
        Expr::NamespaceCall(_) => Err(lower_error(unsupported("namespaceCall"))),
        Expr::NamespaceConst(_) => Err(lower_error(unsupported("namespaceConst"))),
    }
}

/// `splitIndexOffset`: `array[i + 250]` into the part that belongs in the address (the constant)
/// and the index, when the other side is 8-bit and the constant is non-negative.
fn split_index_offset(index: &Expr) -> (&Expr, f64) {
    let Expr::Binop(b) = index else {
        return (index, 0.0);
    };
    if b.operator != "+" {
        return (index, 0.0);
    }
    let const_value = |side: &Expr| match side {
        Expr::Const(c) if c.value >= 0 => Some(c.value as f64),
        _ => None,
    };
    let narrow =
        |side: &Expr| node_type(side).is_some_and(|t| !t.is_empty() && storage_bytes(t) == 1);
    if let Some(value) = const_value(&b.right)
        && narrow(&b.left)
    {
        return (&b.left, value);
    }
    if let Some(value) = const_value(&b.left)
        && narrow(&b.right)
    {
        return (&b.right, value);
    }
    (index, 0.0)
}

/// `arrayEntry`: `name`'s entry in `ctx.arrays`, or a naming error.
fn array_entry<'a>(ctx: &'a Ctx, name: &str) -> Result<&'a ArrayInfo, WasmError> {
    ctx.arrays.get(name).ok_or_else(|| {
        lower_error(format!(
            "'{name}' is not an array this module placed — an array parameter isn't lowered yet, and anything else reaching this is a linker or checker bug"
        ))
    })
}

/// `unsupported`: the message for a kind nothing above handles.
fn unsupported(kind: &str) -> String {
    if kind == "asm" {
        return "'asm' blocks are 6502-specific machine code and are never lowered on the web target"
            .to_string();
    }
    format!("'{kind}' is not lowered yet")
}

/// `scoped`: `body` in a fresh name scope.
fn scoped(body: &[Stmt], ctx: &mut Ctx) -> Code {
    let snapshot = ctx.locals.clone();
    let code = statements(body, ctx);
    ctx.locals = snapshot;
    code
}

/// `loop`: a `while`, or a `for`'s loop half. An outer `block` (the `break` target), a `loop`
/// around the test and body, and an inner `block` around the body (the `continue` target).
fn loop_(test: Option<&Expr>, body: &[Stmt], update: Option<&Stmt>, ctx: &mut Ctx) -> Code {
    ctx.control_stack
        .extend([Control::Break, Control::Plain, Control::Continue]);
    let body_code = scoped(body, ctx)?;
    ctx.control_stack.pop(); // continue
    let update_code = match update {
        Some(u) => statement(u, ctx)?,
        None => Vec::new(),
    };
    ctx.control_stack.pop(); // plain (the loop itself)
    ctx.control_stack.pop(); // break
    let test_code = match test {
        Some(t) => expr(t, ctx)?,
        None => i32_const(1.0)?,
    };
    let mut code = vec![
        opcode::BLOCK,
        block_type::EMPTY,
        opcode::LOOP,
        block_type::EMPTY,
    ];
    code.extend(test_code);
    code.push(opcode::I32_EQZ);
    code.push(opcode::BR_IF);
    code.extend(uleb(1)?);
    code.push(opcode::BLOCK);
    code.push(block_type::EMPTY);
    code.extend(body_code);
    code.push(opcode::END);
    code.extend(update_code);
    code.push(opcode::BR);
    code.extend(uleb(0)?);
    code.push(opcode::END);
    code.push(opcode::END);
    Ok(code)
}

/// `loopDepth`: the relative `br` depth for the nearest enclosing `break` or `continue` target.
fn loop_depth(ctx: &Ctx, target: Control) -> Result<u32, WasmError> {
    for (i, entry) in ctx.control_stack.iter().enumerate().rev() {
        if *entry == target {
            return Ok((ctx.control_stack.len() - 1 - i) as u32);
        }
    }
    let name = if target == Control::Break {
        "break"
    } else {
        "continue"
    };
    Err(lower_error(format!("'{name}' outside a loop")))
}

/// `statement`.
fn statement(node: &Stmt, ctx: &mut Ctx) -> Code {
    match node {
        Stmt::Local(l) => {
            let index = ctx.next_local;
            ctx.next_local += 1;
            ctx.locals.insert(l.name.clone(), index);
            // Always sets, even the implicit zero of a declaration with no initializer: the
            // declaration may be reached again on every iteration of an enclosing loop.
            let mut code = expr(&l.init, ctx)?;
            code.push(opcode::LOCAL_SET);
            code.extend(uleb(index)?);
            Ok(code)
        }
        Stmt::Assign(a) => {
            // A pinned scalar stores at its fixed address instead of a wasm global.
            if let Some(pin) = ctx.pinned.get(a.target.as_str()) {
                let (store, address) = (
                    if pin.width == 2 {
                        opcode::I32_STORE16
                    } else {
                        opcode::I32_STORE8
                    },
                    pin.address,
                );
                let mut code = i32_const(0.0)?;
                code.extend(expr(&a.value, ctx)?);
                code.push(store);
                code.extend(memarg(0.0, f64::from(address))?);
                return Ok(code);
            }
            let b = binding(ctx, &a.target)?;
            let mut code = expr(&a.value, ctx)?;
            code.push(b.set);
            code.extend(uleb(b.index)?);
            Ok(code)
        }
        Stmt::MemoryWrite(m) => {
            // Address, then value, as `store8` wants; `i32.store8` writes only the low byte.
            let mut code = expr(&m.address, ctx)?;
            code.extend(expr(&m.value, ctx)?);
            code.push(opcode::I32_STORE8);
            code.extend(memarg(0.0, 0.0)?);
            Ok(code)
        }
        Stmt::StoreIndex(s) => {
            // The mirror of the `index` read: index (doubled for a 2-byte element), value, store.
            let array = array_entry(ctx, array_name(&s.array))?.clone();
            if !array.mutable {
                return Err(lower_error(format!(
                    "'{}' is a const array — data, not RAM — and the checker should already have refused writing it",
                    array_name(&s.array)
                )));
            }
            let (index, offset) = split_index_offset(&s.index);
            let mut code = expr(index, ctx)?;
            if array.element_width == 2 {
                code.extend(i32_const(1.0)?);
                code.push(opcode::I32_SHL);
                code.extend(expr(&s.value, ctx)?);
                code.push(opcode::I32_STORE16);
                code.extend(memarg(0.0, f64::from(array.address) + 2.0 * offset)?);
                return Ok(code);
            }
            code.extend(expr(&s.value, ctx)?);
            code.push(opcode::I32_STORE8);
            code.extend(memarg(0.0, f64::from(array.address) + offset)?);
            Ok(code)
        }
        Stmt::StringCopy(s) => {
            // Copy the source's length byte (cut to the capacity), then that many characters
            // with `memory.copy`. Two scratch locals hold the source pointer and the length.
            let target = array_entry(ctx, array_name(&s.target))?.clone();
            let capacity = s.capacity as f64;
            let src = ctx.next_local;
            ctx.next_local += 1;
            let len = ctx.next_local;
            ctx.next_local += 1;
            let mut code = Vec::new();
            // src := <source expression>
            code.extend(expr(&s.source, ctx)?);
            code.push(opcode::LOCAL_SET);
            code.extend(uleb(src)?);
            // len := min(load8(src), capacity)
            code.push(opcode::LOCAL_GET);
            code.extend(uleb(src)?);
            code.push(opcode::I32_LOAD8_U);
            code.extend(memarg(0.0, 0.0)?);
            code.push(opcode::LOCAL_SET);
            code.extend(uleb(len)?);
            code.push(opcode::LOCAL_GET);
            code.extend(uleb(len)?);
            code.extend(i32_const(capacity)?);
            code.push(opcode::LOCAL_GET);
            code.extend(uleb(len)?);
            code.extend(i32_const(capacity)?);
            code.push(opcode::I32_LT_U);
            code.push(opcode::SELECT);
            code.push(opcode::LOCAL_SET);
            code.extend(uleb(len)?);
            // target[0] := len
            code.extend(i32_const(f64::from(target.address))?);
            code.push(opcode::LOCAL_GET);
            code.extend(uleb(len)?);
            code.push(opcode::I32_STORE8);
            code.extend(memarg(0.0, 0.0)?);
            // memory.copy(target + 1, src + 1, len)
            code.extend(i32_const(f64::from(target.address) + 1.0)?);
            code.push(opcode::LOCAL_GET);
            code.extend(uleb(src)?);
            code.extend(i32_const(1.0)?);
            code.push(opcode::I32_ADD);
            code.push(opcode::LOCAL_GET);
            code.extend(uleb(len)?);
            code.extend(memory_copy());
            Ok(code)
        }
        Stmt::Block(b) => scoped(&b.body, ctx),
        Stmt::If(i) => {
            let test_code = expr(&i.test, ctx)?;
            ctx.control_stack.push(Control::Plain);
            let then_code = scoped(&i.then, ctx)?;
            let else_code = match &i.r#else {
                Some(body) => Some(scoped(body, ctx)?),
                None => None,
            };
            ctx.control_stack.pop();
            let mut code = test_code;
            code.push(opcode::IF);
            code.push(block_type::EMPTY);
            code.extend(then_code);
            if let Some(else_code) = else_code {
                code.push(opcode::ELSE);
                code.extend(else_code);
            }
            code.push(opcode::END);
            Ok(code)
        }
        Stmt::While(w) => loop_(Some(&w.test), &w.body, None, ctx),
        Stmt::For(f) => {
            // The init's declaration outlives every iteration, so it gets the whole statement's
            // scope, snapshotted once.
            let snapshot = ctx.locals.clone();
            let init = f.init.as_option();
            let mut code = match init {
                Some(init) => statement(init, ctx)?,
                None => Vec::new(),
            };
            let test = f.test.as_option();
            let update = f.update.as_option().map(|u| &**u);
            code.extend(loop_(test, &f.body, update, ctx)?);
            ctx.locals = snapshot;
            Ok(code)
        }
        Stmt::Break(_) => {
            let mut code = vec![opcode::BR];
            code.extend(uleb(loop_depth(ctx, Control::Break)?)?);
            Ok(code)
        }
        Stmt::Continue(_) => {
            let mut code = vec![opcode::BR];
            code.extend(uleb(loop_depth(ctx, Control::Continue)?)?);
            Ok(code)
        }
        Stmt::Return(r) => match &r.value {
            Some(value) => {
                let mut code = expr(value, ctx)?;
                code.push(opcode::RETURN);
                Ok(code)
            }
            None => Ok(vec![opcode::RETURN]),
        },
        Stmt::Call(c) => {
            // A call in statement position leaves its result on the stack; `drop` discards it.
            let mut code = call_site(c, ctx)?;
            if call_target(ctx, &c.name)?.returns_value {
                code.push(opcode::DROP);
            }
            Ok(code)
        }
        Stmt::WaitFrame(_) => {
            // `build()` scans the whole program first, so an unset index here is a `build()` bug.
            let Some(index) = ctx.wait_frame_index else {
                return Err(lower_error(
                    "'waitFrame' reached lowering with no import declared — a build() bug, not a missing lowering rule"
                        .to_string(),
                ));
            };
            let mut code = vec![opcode::CALL];
            code.extend(uleb(index)?);
            Ok(code)
        }
        Stmt::Asm(_) => Err(lower_error(unsupported("asm"))),
        Stmt::MemoryRead(_) => Err(lower_error(unsupported("memoryRead"))),
        Stmt::PortWrite(_) => Err(lower_error(unsupported("portWrite"))),
        Stmt::NamespaceCall(_) => Err(lower_error(unsupported("namespaceCall"))),
        Stmt::PortRead(_) => Err(lower_error(unsupported("portRead"))),
    }
}

/// `statements`.
fn statements(body: &[Stmt], ctx: &mut Ctx) -> Code {
    let mut code = Vec::new();
    for node in body {
        code.extend(statement(node, ctx)?);
    }
    Ok(code)
}

/// A successful `lower`: instruction bytes only (no closing `end`) and the local count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LowerResult {
    pub code: Vec<u8>,
    /// How many `i32` locals the body's own `local` declarations need beyond its parameters.
    pub local_count: u32,
}

/// `LowerFailure`: the message of a `LowerError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LowerFailure {
    pub error: String,
}

/// `{ ok: true, ... } | { ok: false, error }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LowerOutcome {
    Ok(LowerResult),
    Failure(LowerFailure),
}

/// One entry of `LowerOptions.params`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LowerParam {
    pub name: String,
    pub ty: String,
}

/// `LowerOptions`: everything `build()` lays out before a body is lowered.
#[derive(Debug, Clone, Default)]
pub struct LowerOptions {
    pub params: Vec<LowerParam>,
    pub globals: IndexMap<String, u32>,
    pub functions: IndexMap<String, FunctionInfo>,
    pub strings: Vec<u32>,
    pub arrays: IndexMap<String, ArrayInfo>,
    pub pinned: IndexMap<String, PinnedInfo>,
    pub wait_frame_index: Option<u32>,
}

/// `lower`: a function body to wasm instruction bytes.
///
/// # Errors
/// Only an error that is not a `LowerError` (the JS rethrows it).
pub fn lower(body: &[Stmt], options: LowerOptions) -> Result<LowerOutcome, WasmError> {
    let param_count = options.params.len() as u32;
    let locals = options
        .params
        .iter()
        .enumerate()
        .map(|(i, p)| (p.name.clone(), i as u32))
        .collect();
    let mut ctx = Ctx {
        locals,
        next_local: param_count,
        control_stack: Vec::new(),
        globals: options.globals,
        functions: options.functions,
        strings: options.strings,
        arrays: options.arrays,
        pinned: options.pinned,
        wait_frame_index: options.wait_frame_index,
    };
    match statements(body, &mut ctx) {
        Ok(code) => Ok(LowerOutcome::Ok(LowerResult {
            code,
            local_count: ctx.next_local - param_count,
        })),
        Err(WasmError::Lower(error)) => Ok(LowerOutcome::Failure(LowerFailure { error })),
        Err(other) => Err(other),
    }
}
