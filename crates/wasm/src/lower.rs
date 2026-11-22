//! Port of `packages/compiler/src/wasm/lower.ts:1-230`: the lowering context and its helpers.
//!
//! `IrExpr` and `IrStatement` are `mos_ir::{Expr, Stmt}`; `LowerError` is `WasmError::Lower`.
//! `binop` and everything after it belong to a later unit.

use indexmap::IndexMap;
use mos_ir::Expr;
use sema::types::resolve_integer_type;

use crate::WasmError;
use crate::encode::{opcode, signed_leb128};

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
