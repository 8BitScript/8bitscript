//! Port of mos/lower/index.ts and mos/lower/allocator.ts
//!
//! This file holds `index.ts:1-667` (types, helpers, the `Lowerer` fields,
//! `provenance`, `emit`, `binding`, `expr`, `expr8`) and `:2181-2270`
//! (`jumpsToNextLabel`, `redundantReloads`, `lower`). The wide-value methods
//! live in `wide.rs` and the control-flow methods in `flow.rs`.

pub mod allocator;
pub mod flow;
pub mod wide;

use std::collections::BTreeSet;

use indexmap::IndexMap;
use jsnum::to_int32;
use mos_ir::{Binop, Expr, For, Stmt};
use serde::{Deserialize, Serialize};

use crate::asm::assemble::{Directive, Half, Operand};
use crate::asm::encode::AddressingMode;
use crate::build::Counters;
use crate::provenance::{Provenance, SourceSpan};
use crate::startup::multiply::MultiplyCells;
use crate::types::{resolve_integer_type, storage_bytes};
use allocator::LocalAllocator;

/// A function's calling interface (`FunctionSite`, `index.ts:~108`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionSite {
    pub label: String,
    pub params: Vec<SiteParam>,
    pub return_type: String,
    #[serde(default)]
    pub return_pair: Option<i64>,
}

/// One parameter slot of a [`FunctionSite`]; `width` is 1 or 2.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SiteParam {
    pub address: i64,
    pub width: i64,
}

/// One resolvable name: a zero-page address and its type.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub address: i64,
    #[serde(rename = "type")]
    pub ty: String,
}

/// A function's own parameter, already placed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParamBinding {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub address: i64,
}

/// An array global the data section places.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrayInfo {
    pub element_type: String,
    #[serde(default)]
    pub mutable: Option<bool>,
    #[serde(default)]
    pub length: Option<i64>,
}

/// What a `local` statement did to `symbols`: the binding it shadowed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declared {
    pub name: String,
    pub shadowed: Option<Binding>,
}

/// `LowerOptions` (`index.ts:203-222`); `locals` is owned and mutated.
#[derive(Clone, Debug)]
pub struct LowerOptions {
    pub globals: IndexMap<String, Binding>,
    pub locals: LocalAllocator,
    pub params: Vec<ParamBinding>,
    pub functions: IndexMap<String, FunctionSite>,
    pub arrays: IndexMap<String, ArrayInfo>,
    pub multiply: Option<MultiplyCells>,
    pub return_pair: Option<i64>,
    pub fn_name: Option<String>,
    pub fn_file: Option<String>,
    pub origin_files: IndexMap<String, String>,
}

/// One origin run of the lowered program (`parts` entries).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Part {
    pub origin: Option<String>,
    pub program: Vec<Directive>,
}

/// `{ ok: true, program, parts }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Lowered {
    pub program: Vec<Directive>,
    pub parts: Vec<Part>,
}

/// A statement range `block` hands back: the origin and its slice of `program`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockRange {
    pub origin: Option<String>,
    pub start: usize,
    pub end: usize,
}

/// Where `break` and `continue` jump.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoopLabels {
    pub continue_label: String,
    pub break_label: String,
}

// ---------------------------------------------------------------------------
// Directive builders (`index.ts:253-285`)

#[must_use]
pub fn instr(
    mnemonic: &str,
    mode: AddressingMode,
    value: Option<i64>,
    label: Option<&str>,
) -> Directive {
    let operand = if let Some(name) = label {
        Some(Operand::Label {
            name: name.to_string(),
            byte: None,
            offset: None,
        })
    } else {
        value.map(|value| Operand::Value { value })
    };
    Directive::Instruction {
        mnemonic: mnemonic.to_string(),
        mode,
        operand,
        prov: None,
    }
}

#[must_use]
pub fn lda_imm(value: i64) -> Directive {
    instr("LDA", AddressingMode::Immediate, Some(value), None)
}

#[must_use]
pub fn lda_zp(address: i64) -> Directive {
    instr("LDA", AddressingMode::Zeropage, Some(address), None)
}

#[must_use]
pub fn sta_zp(address: i64) -> Directive {
    instr("STA", AddressingMode::Zeropage, Some(address), None)
}

#[must_use]
pub fn cmp_zp(address: i64) -> Directive {
    instr("CMP", AddressingMode::Zeropage, Some(address), None)
}

#[must_use]
pub fn jmp(label: &str) -> Directive {
    instr("JMP", AddressingMode::Absolute, None, Some(label))
}

#[must_use]
pub fn branch(mnemonic: &str, label: &str) -> Directive {
    instr(mnemonic, AddressingMode::Relative, None, Some(label))
}

#[must_use]
pub fn label(name: &str) -> Directive {
    Directive::Label {
        name: name.to_string(),
        prov: None,
    }
}

#[must_use]
pub fn addr_mode(address: i64) -> AddressingMode {
    if address <= 0xff {
        AddressingMode::Zeropage
    } else {
        AddressingMode::Absolute
    }
}

#[must_use]
pub fn lda_addr(address: i64) -> Directive {
    instr("LDA", addr_mode(address), Some(address), None)
}

#[must_use]
pub fn sta_addr(address: i64) -> Directive {
    instr("STA", addr_mode(address), Some(address), None)
}

fn imm_label(name: &str, half: Half) -> Directive {
    Directive::Instruction {
        mnemonic: "LDA".to_string(),
        mode: AddressingMode::Immediate,
        operand: Some(Operand::Label {
            name: name.to_string(),
            byte: Some(half),
            offset: None,
        }),
        prov: None,
    }
}

#[must_use]
pub fn lda_imm_lo(label_name: &str) -> Directive {
    imm_label(label_name, Half::Lo)
}

#[must_use]
pub fn lda_imm_hi(label_name: &str) -> Directive {
    imm_label(label_name, Half::Hi)
}

/// A label's low or high byte as an immediate, with a constant folded in.
#[must_use]
pub fn imm_byte(name: &str, half: Half, offset: i64) -> Directive {
    Directive::Instruction {
        mnemonic: "LDA".to_string(),
        mode: AddressingMode::Immediate,
        operand: Some(Operand::Label {
            name: name.to_string(),
            byte: Some(half),
            offset: if offset == 0 { None } else { Some(offset) },
        }),
        prov: None,
    }
}

/// `STA base+offset,Y` and friends; the offset is omitted when it is zero.
#[must_use]
pub fn indexed(mnemonic: &str, label: &str, offset: i64) -> Directive {
    Directive::Instruction {
        mnemonic: mnemonic.to_string(),
        mode: AddressingMode::AbsoluteY,
        operand: Some(Operand::Label {
            name: label.to_string(),
            byte: None,
            offset: if offset == 0 { None } else { Some(offset) },
        }),
        prov: None,
    }
}

// ---------------------------------------------------------------------------
// Type checks

/// # Errors
/// The `LowerError` text when `ty` is missing or not 1 byte wide.
pub fn require8_bit(ty: Option<&str>, what: &str) -> Result<(), String> {
    let Some(ty) = ty else {
        return Err(format!(
            "{what}: no type on this IR node — the checker/linker should have set one"
        ));
    };
    let bytes = storage_bytes(Some(ty));
    if bytes != 1 {
        return Err(format!(
            "{what} is '{ty}' ({bytes} bytes): this path only lowers 8-bit values — 16-bit values have their own (parameters, +/-, comparisons, and a computed memoryWrite address; locals, assignment, and return values are still 8-bit only)"
        ));
    }
    Ok(())
}

/// # Errors
/// The `LowerError` text when `ty` is missing or not 2 bytes wide.
pub fn require16_bit(ty: Option<&str>, what: &str) -> Result<(), String> {
    let Some(ty) = ty else {
        return Err(format!(
            "{what}: no type on this IR node — the checker/linker should have set one"
        ));
    };
    let bytes = storage_bytes(Some(ty));
    if bytes != 2 {
        return Err(format!(
            "{what} is '{ty}' ({bytes} bytes): only 16-bit values take this path — mixed-width arithmetic and anything wider than 16 bits isn't lowered yet"
        ));
    }
    Ok(())
}

#[must_use]
pub fn is_signed(ty: &str) -> bool {
    if ty == "bool" {
        return false;
    }
    resolve_integer_type(ty).is_some_and(|t| t.signed)
}

/// How a comparison branches when it is true (`ORDER_BRANCH_IF_TRUE`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BranchPlan {
    Mnemonic(&'static str),
    Double(&'static str, &'static str),
    Either(&'static str, &'static str),
}

#[must_use]
pub fn order_branch_if_true(operator: &str) -> Option<BranchPlan> {
    Some(match operator {
        "==" => BranchPlan::Mnemonic("BEQ"),
        "!=" => BranchPlan::Mnemonic("BNE"),
        ">" => BranchPlan::Mnemonic("BCC"),
        "<=" => BranchPlan::Mnemonic("BCS"),
        "<" => BranchPlan::Double("BEQ", "BCS"),
        ">=" => BranchPlan::Either("BCC", "BEQ"),
        _ => return None,
    })
}

#[must_use]
pub fn negate(operator: &str) -> Option<&'static str> {
    Some(match operator {
        "==" => "!=",
        "!=" => "==",
        "<" => ">=",
        ">=" => "<",
        ">" => "<=",
        "<=" => ">",
        _ => return None,
    })
}

#[must_use]
pub fn mirror(operator: &str) -> Option<&'static str> {
    Some(match operator {
        "==" => "==",
        "!=" => "!=",
        "<" => ">",
        ">" => "<",
        "<=" => ">=",
        ">=" => "<=",
        _ => return None,
    })
}

pub const SETS_FLAGS_FROM_A: [&str; 9] = [
    "LDA", "ADC", "SBC", "AND", "ORA", "EOR", "TXA", "TYA", "PLA",
];

#[must_use]
pub fn is_ordering_operator(operator: &str) -> bool {
    matches!(operator, "<" | ">" | "<=" | ">=")
}

#[must_use]
pub fn is_equality_operator(operator: &str) -> bool {
    matches!(operator, "==" | "!=")
}

#[must_use]
pub fn is_comparison_operator(operator: &str) -> bool {
    is_ordering_operator(operator) || is_equality_operator(operator)
}

/// Restarts label numbering (`resetLabels`); `build()` calls it at the top.
pub fn reset_labels(c: &mut Counters) {
    c.lower = 0;
}

/// `__8bs_<tag>_<n>`, advancing the counter.
pub fn fresh_label(c: &mut Counters, tag: &str) -> String {
    let n = c.lower;
    c.lower += 1;
    format!("__8bs_{tag}_{n}")
}

// ---------------------------------------------------------------------------
// IR accessors (the JS reads `node.kind` and `node.type` off one loose shape)

/// `node.kind`.
#[must_use]
pub fn expr_kind(node: &Expr) -> &'static str {
    match node {
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
    }
}

/// `node.type`, `None` for absent or `null`.
#[must_use]
pub fn expr_type(node: &Expr) -> Option<&str> {
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
        Expr::Record(_) => None,
    }
}

/// JS truthiness of `node.type`: a missing, `null` or empty type is false.
#[must_use]
pub fn has_type(node: &Expr) -> bool {
    expr_type(node).is_some_and(|t| !t.is_empty())
}

/// `node.type !== undefined && node.type !== null && storageBytes(node.type) === bytes`.
#[must_use]
pub fn type_is_bytes(node: &Expr, bytes: i64) -> bool {
    expr_type(node).is_some_and(|t| storage_bytes(Some(t)) == bytes)
}

// ---------------------------------------------------------------------------
// Pure helpers (`index.ts:360-480`)

/// `array[i + 250]` split into the part for the address and the part for Y.
#[must_use]
pub fn split_index_offset(node: Option<&Expr>) -> Option<(&Expr, i64)> {
    let Some(Expr::Binop(b)) = node else {
        return None;
    };
    if b.operator != "+" {
        return None;
    }
    let fits = |side: &Expr| type_is_bytes(side, 1);
    if let Some(v) = const_value(&b.right)
        && v >= 0
        && fits(&b.left)
    {
        return Some((&b.left, v));
    }
    if let Some(v) = const_value(&b.left)
        && v >= 0
        && fits(&b.right)
    {
        return Some((&b.right, v));
    }
    None
}

/// The value of a `const` node.
#[must_use]
pub fn const_value(node: &Expr) -> Option<i64> {
    match node {
        Expr::Const(c) => Some(c.value),
        _ => None,
    }
}

/// `isConstNum(node, value?)`.
#[must_use]
pub fn is_const_num(node: Option<&Expr>, value: Option<i64>) -> bool {
    match node.and_then(const_value) {
        None => false,
        Some(v) => value.is_none_or(|want| want == v),
    }
}

/// `isRefNamed(node, name)`.
#[must_use]
pub fn is_ref_named(node: Option<&Expr>, name: &str) -> bool {
    matches!(node, Some(Expr::Ref(r)) if r.name == name)
}

/// True when evaluating `node` writes nothing (a call, or an unknown kind, is assumed to write).
#[must_use]
pub fn is_pure(node: Option<&Expr>) -> bool {
    let Some(node) = node else {
        return false;
    };
    match node {
        Expr::Const(_) | Expr::Ref(_) | Expr::String(_) => true,
        Expr::Binop(b) => is_pure(Some(&b.left)) && is_pure(Some(&b.right)),
        Expr::Unop(u) => is_pure(Some(&u.argument)),
        Expr::Index(i) => is_pure(Some(&i.index)),
        Expr::StringLength(s) => is_pure(Some(&s.string)),
        Expr::StringByte(s) => is_pure(Some(&s.string)) && is_pure(Some(&s.index)),
        _ => false,
    }
}

/// A `for` that fills memory with one constant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConstFill {
    pub base: i64,
    pub count: i64,
    pub value: i64,
}

/// `matchConstFill`.
#[must_use]
pub fn match_const_fill(node: &Stmt) -> Option<ConstFill> {
    let Stmt::For(For {
        init,
        test,
        update,
        body,
        ..
    }) = node
    else {
        return None;
    };
    let Some(Stmt::Local(init)) = init.as_option().map(|b| &**b) else {
        return None;
    };
    if init.name.is_empty() {
        return None;
    }
    let name = init.name.as_str();
    if !is_const_num(Some(&init.init), Some(0)) {
        return None;
    }
    let Some(Expr::Binop(Binop {
        operator,
        left,
        right,
        ..
    })) = test.as_option()
    else {
        return None;
    };
    if operator != "<" || !is_ref_named(Some(left), name) {
        return None;
    }
    let count = const_value(right)?;
    if count <= 0 || count > 0x10000 {
        return None;
    }
    let Some(Stmt::Assign(update)) = update.as_option().map(|b| &**b) else {
        return None;
    };
    if update.target != name {
        return None;
    }
    let Expr::Binop(inc) = &update.value else {
        return None;
    };
    if inc.operator != "+"
        || !is_ref_named(Some(&inc.left), name)
        || !is_const_num(Some(&inc.right), Some(1))
    {
        return None;
    }
    let [Stmt::MemoryWrite(write)] = body.as_slice() else {
        return None;
    };
    let fill_value = const_value(&write.value)?;
    if !(0..=255).contains(&fill_value) {
        return None;
    }
    let Expr::Binop(address) = &write.address else {
        return None;
    };
    if address.operator != "+" {
        return None;
    }
    let base = if is_const_num(Some(&address.left), None)
        && is_ref_named(Some(&address.right), name)
    {
        const_value(&address.left)
    } else if is_const_num(Some(&address.right), None) && is_ref_named(Some(&address.left), name) {
        const_value(&address.right)
    } else {
        None
    }?;
    if base < 0 || base + count > 0x10000 {
        return None;
    }
    Some(ConstFill {
        base,
        count,
        value: fill_value,
    })
}

// ---------------------------------------------------------------------------
// The lowerer

/// One function's lowering pass (`class Lowerer`).
pub struct Lowerer<'a> {
    pub program: Vec<Directive>,
    pub symbols: IndexMap<String, Binding>,
    /// Names this function's frame binds, with a count (an inner block may rebind one).
    pub frame: IndexMap<String, i64>,
    pub locals: &'a mut LocalAllocator,
    pub functions: &'a IndexMap<String, FunctionSite>,
    pub arrays: &'a IndexMap<String, ArrayInfo>,
    pub multiply: Option<MultiplyCells>,
    pub return_pair: Option<i64>,
    pub loops: Vec<LoopLabels>,
    pub exit_label: String,
    pub fn_name: Option<String>,
    pub fn_file: Option<String>,
    pub origin_files: &'a IndexMap<String, String>,
    pub current_span: Option<SourceSpan>,
    pub current_origin: Option<String>,
    pub counters: &'a mut Counters,
}

/// The `prov` slot of a directive.
fn prov_slot(directive: &mut Directive) -> &mut Option<Provenance> {
    match directive {
        Directive::Label { prov, .. }
        | Directive::Instruction { prov, .. }
        | Directive::Byte { prov, .. }
        | Directive::Equate { prov, .. } => prov,
    }
}

impl<'a> Lowerer<'a> {
    /// The constructor. `exit_label` is taken first, before anything else
    /// reads `options` (F6: a field initializer runs before the body).
    pub fn new(options: &'a mut LowerOptions, counters: &'a mut Counters) -> Self {
        let exit_label = fresh_label(counters, "exit");
        let LowerOptions {
            globals,
            locals,
            params,
            functions,
            arrays,
            multiply,
            return_pair,
            fn_name,
            fn_file,
            origin_files,
        } = options;
        let mut symbols = globals.clone();
        let mut frame = IndexMap::new();
        for p in params.iter() {
            symbols.insert(
                p.name.clone(),
                Binding {
                    address: p.address,
                    ty: p.ty.clone(),
                },
            );
            frame.insert(p.name.clone(), 1);
        }
        Self {
            program: Vec::new(),
            symbols,
            frame,
            locals,
            functions,
            arrays,
            multiply: *multiply,
            return_pair: *return_pair,
            loops: Vec::new(),
            exit_label,
            fn_name: fn_name.clone(),
            fn_file: fn_file.clone(),
            origin_files,
            current_span: None,
            current_origin: None,
            counters,
        }
    }

    /// `freshLabel(tag)` on this pass's counter.
    pub fn fresh_label(&mut self, tag: &str) -> String {
        fresh_label(self.counters, tag)
    }

    /// This pass's current provenance, or `None` when built with no `fnName`.
    #[must_use]
    pub fn provenance(&self) -> Option<Provenance> {
        let function = self.fn_name.clone()?;
        Some(Provenance {
            source: self.current_span.clone(),
            function: Some(function),
            origin: self.current_origin.clone(),
            component: None,
            instance: None,
            generated: None,
        })
    }

    /// Appends directives, stamping each one that has no `prov` yet (F7).
    pub fn emit(&mut self, directives: impl IntoIterator<Item = Directive>) {
        let prov = self.provenance();
        for mut directive in directives {
            if let Some(prov) = &prov {
                let slot = prov_slot(&mut directive);
                if slot.is_none() {
                    *slot = Some(prov.clone());
                }
            }
            self.program.push(directive);
        }
    }

    /// # Errors
    /// The `LowerError` text when `name` resolves to nothing.
    pub fn binding(&self, name: &str) -> Result<Binding, String> {
        self.symbols.get(name).cloned().ok_or_else(|| {
            format!("'{name}' resolves to nothing this backend knows — not a global milestone 5 placed and not a local in scope (a linker or checker bug, not a missing lowering rule)")
        })
    }

    /// An 8-bit value into the accumulator.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn expr(&mut self, node: &Expr) -> Result<(), String> {
        if has_type(node) {
            require8_bit(expr_type(node), &format!("'{}'", expr_kind(node)))?;
        }
        match node {
            Expr::Const(c) => {
                self.emit([lda_imm(i64::from(to_int32(c.value as f64) & 0xff))]);
                Ok(())
            }
            Expr::Ref(r) => {
                let address = self.binding(&r.name)?.address;
                self.emit([lda_addr(address)]);
                Ok(())
            }
            Expr::Binop(_) => self.binop(node),
            Expr::Unop(_) => self.unop(node),
            Expr::Call(call) => self.call_site(call),
            Expr::StringLength(_) => self.string_length(node),
            Expr::StringByte(_) => self.string_byte(node),
            Expr::Index(_) => self.index_read(node),
            Expr::MemoryRead(_) => self.memory_read(node),
            Expr::Cond(cond) => {
                let else_label = self.fresh_label("cond_else");
                let end_label = self.fresh_label("cond_end");
                self.branch_if_false(&cond.test, &else_label)?;
                self.expr(&cond.consequent)?;
                self.emit([jmp(&end_label), label(&else_label)]);
                self.expr(&cond.alternate)?;
                self.emit([label(&end_label)]);
                Ok(())
            }
            _ => Err(format!(
                "no instruction-selection rule yet for the '{}' expression — it lands in a later milestone",
                expr_kind(node)
            )),
        }
    }

    /// An 8-bit value from an expression that may be wider than 8 bits: the
    /// low byte of the wide value.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn expr8(&mut self, node: &Expr) -> Result<(), String> {
        if type_is_bytes(node, 2) {
            if let Expr::Binop(b) = node {
                if b.operator == ">>"
                    && is_const_num(Some(&b.right), None)
                    && has_type(&b.left)
                    && type_is_bytes(&b.left, 2)
                {
                    let amount = const_value(&b.right).unwrap_or(0);
                    if amount >= 16 {
                        self.emit([lda_imm(0)]);
                        return Ok(());
                    }
                    if amount >= 8 {
                        let mark = self.locals.mark();
                        let src = self.expr_to16(&b.left)?;
                        self.emit([lda_zp(src + 1)]);
                        for _ in 8..amount {
                            self.emit([instr("LSR", AddressingMode::Accumulator, None, None)]);
                        }
                        self.locals.release(mark);
                        return Ok(());
                    }
                }
                if is_const_num(Some(&b.right), None)
                    && matches!(b.operator.as_str(), "&" | "|" | "^")
                {
                    let mnemonic = match b.operator.as_str() {
                        "&" => "AND",
                        "|" => "ORA",
                        _ => "EOR",
                    };
                    let value =
                        i64::from(to_int32(const_value(&b.right).unwrap_or(0) as f64) & 0xff);
                    self.expr8(&b.left)?;
                    let identity = if b.operator == "&" {
                        value == 0xff
                    } else {
                        value == 0x00
                    };
                    if !identity {
                        self.emit([instr(
                            mnemonic,
                            AddressingMode::Immediate,
                            Some(value),
                            None,
                        )]);
                    }
                    return Ok(());
                }
            }
            let mark = self.locals.mark();
            let pair = self.expr16(node)?;
            self.emit([lda_zp(pair)]);
            self.locals.release(mark);
            return Ok(());
        }
        self.expr(node)
    }
}

// ---------------------------------------------------------------------------
// Peephole passes and the entry point (`index.ts:2181-2270`)

/// Indices of `JMP`/branch directives that jump to the label right after them.
#[must_use]
pub fn jumps_to_next_label(program: &[Directive]) -> BTreeSet<usize> {
    let mut removed = BTreeSet::new();
    let mut changed = true;
    while changed {
        changed = false;
        for i in 0..program.len() {
            if removed.contains(&i) {
                continue;
            }
            let Directive::Instruction {
                mnemonic,
                mode,
                operand,
                ..
            } = &program[i]
            else {
                continue;
            };
            let is_jmp = mnemonic == "JMP" && *mode == AddressingMode::Absolute;
            if !is_jmp && *mode != AddressingMode::Relative {
                continue;
            }
            let Some(Operand::Label { name: target, .. }) = operand else {
                continue;
            };
            for (j, next) in program.iter().enumerate().skip(i + 1) {
                if removed.contains(&j) {
                    continue;
                }
                let Directive::Label { name, .. } = next else {
                    break;
                };
                if name == target {
                    removed.insert(i);
                    changed = true;
                    break;
                }
            }
        }
    }
    removed
}

/// Marks every `LDA` that provably reloads what the accumulator already holds.
pub fn redundant_reloads(program: &[Directive], removed: &mut BTreeSet<usize>) {
    for i in 0..program.len() {
        if removed.contains(&i) {
            continue;
        }
        let Directive::Instruction {
            mnemonic,
            mode,
            operand,
            ..
        } = &program[i]
        else {
            continue;
        };
        if mnemonic != "LDA"
            || !matches!(mode, AddressingMode::Immediate | AddressingMode::Zeropage)
        {
            continue;
        }
        let mut saw_sta_same = false;
        let mut anchor: Option<&Directive> = None;
        for j in (0..i).rev() {
            if removed.contains(&j) {
                continue;
            }
            // A label is a branch target: another path may arrive with any A.
            let Directive::Instruction {
                mnemonic: pm,
                mode: pmode,
                operand: poperand,
                ..
            } = &program[j]
            else {
                break;
            };
            if pm == "STA" {
                if *mode == AddressingMode::Zeropage
                    && *pmode == AddressingMode::Zeropage
                    && poperand == operand
                {
                    saw_sta_same = true;
                }
                continue;
            }
            anchor = Some(&program[j]);
            break;
        }
        let Some(Directive::Instruction {
            mnemonic: am,
            mode: amode,
            operand: aoperand,
            ..
        }) = anchor
        else {
            continue;
        };
        let flags_from_a =
            *amode == AddressingMode::Accumulator || SETS_FLAGS_FROM_A.contains(&am.as_str());
        if !flags_from_a {
            continue;
        }
        if (am == "LDA" && amode == mode && aoperand == operand) || saw_sta_same {
            removed.insert(i);
        }
    }
}

/// Lowers one function's body to a 6502 program.
///
/// # Errors
/// The `LowerError`/`ZpBudgetError` text (JS `{ ok: false, error }`).
pub fn lower(
    body: &[Stmt],
    options: &mut LowerOptions,
    c: &mut Counters,
) -> Result<Lowered, String> {
    let mut lowerer = Lowerer::new(options, c);
    let ranges = lowerer.block(body)?;
    Ok(finish(lowerer, ranges))
}

/// Closes the program with the exit label, runs the two peephole passes and
/// slices the per-origin parts.
fn finish(mut lowerer: Lowerer<'_>, ranges: Vec<BlockRange>) -> Lowered {
    let exit = lowerer.exit_label.clone();
    lowerer.emit([label(&exit)]);
    let mut removed = jumps_to_next_label(&lowerer.program);
    redundant_reloads(&lowerer.program, &mut removed);
    let program = lowerer
        .program
        .iter()
        .enumerate()
        .filter(|(i, _)| !removed.contains(i))
        .map(|(_, d)| d.clone())
        .collect();
    let parts = ranges
        .into_iter()
        .map(|BlockRange { origin, start, end }| Part {
            origin,
            program: lowerer.program[start..end]
                .iter()
                .enumerate()
                .filter(|(offset, _)| !removed.contains(&(start + offset)))
                .map(|(_, d)| d.clone())
                .collect(),
        })
        .collect();
    Lowered { program, parts }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mos_ir::{Const, Ref, Unop};

    fn konst(value: i64, ty: Option<&str>) -> Expr {
        Expr::Const(Const {
            value,
            ty: ty.map(str::to_string),
        })
    }

    fn reference(name: &str, ty: Option<&str>) -> Expr {
        Expr::Ref(Ref {
            name: name.to_string(),
            ty: ty.map_or(jsnum::Nullable::Absent, |t| {
                jsnum::Nullable::Value(t.to_string())
            }),
            start: None,
            length: None,
        })
    }

    fn binop(op: &str, left: Expr, right: Expr, ty: &str) -> Expr {
        Expr::Binop(mos_ir::Binop {
            operator: op.to_string(),
            left: Box::new(left),
            right: Box::new(right),
            ty: Some(ty.to_string()),
        })
    }

    fn options(fn_name: Option<&str>) -> LowerOptions {
        LowerOptions {
            globals: IndexMap::from([(
                "g".to_string(),
                Binding {
                    address: 0x10,
                    ty: "utinyint".into(),
                },
            )]),
            locals: LocalAllocator::new(0x80, 0x90, &[]),
            params: vec![ParamBinding {
                name: "p".into(),
                ty: "utinyint".into(),
                address: 0x20,
            }],
            functions: IndexMap::new(),
            arrays: IndexMap::new(),
            multiply: None,
            return_pair: None,
            fn_name: fn_name.map(str::to_string),
            fn_file: None,
            origin_files: IndexMap::new(),
        }
    }

    #[test]
    fn labels_count_and_reset() {
        let mut c = Counters::default();
        assert_eq!(fresh_label(&mut c, "a"), "__8bs_a_0");
        assert_eq!(fresh_label(&mut c, "b"), "__8bs_b_1");
        reset_labels(&mut c);
        assert_eq!(c.lower, 0);
    }

    #[test]
    fn builders_make_the_expected_directives() {
        assert_eq!(lda_addr(0xff), lda_zp(0xff));
        assert_eq!(
            sta_addr(0x100),
            instr("STA", AddressingMode::Absolute, Some(0x100), None)
        );
        assert_eq!(
            jmp("x"),
            instr("JMP", AddressingMode::Absolute, None, Some("x"))
        );
        assert_eq!(
            branch("BNE", "x"),
            instr("BNE", AddressingMode::Relative, None, Some("x"))
        );
        assert_eq!(
            cmp_zp(3),
            instr("CMP", AddressingMode::Zeropage, Some(3), None)
        );
        assert_eq!(
            sta_zp(3),
            instr("STA", AddressingMode::Zeropage, Some(3), None)
        );
        assert_eq!(
            lda_imm(1),
            instr("LDA", AddressingMode::Immediate, Some(1), None)
        );
        assert_eq!(
            instr("RTS", AddressingMode::Implied, None, None),
            Directive::Instruction {
                mnemonic: "RTS".into(),
                mode: AddressingMode::Implied,
                operand: None,
                prov: None
            }
        );
        let hi = lda_imm_hi("L");
        assert!(matches!(
            hi,
            Directive::Instruction {
                operand: Some(Operand::Label {
                    byte: Some(Half::Hi),
                    ..
                }),
                ..
            }
        ));
        assert!(matches!(
            lda_imm_lo("L"),
            Directive::Instruction {
                operand: Some(Operand::Label {
                    byte: Some(Half::Lo),
                    ..
                }),
                ..
            }
        ));
        assert!(matches!(
            imm_byte("L", Half::Lo, 0),
            Directive::Instruction {
                operand: Some(Operand::Label { offset: None, .. }),
                ..
            }
        ));
        assert!(matches!(
            imm_byte("L", Half::Lo, 5),
            Directive::Instruction {
                operand: Some(Operand::Label {
                    offset: Some(5),
                    ..
                }),
                ..
            }
        ));
        assert!(matches!(
            indexed("STA", "L", 0),
            Directive::Instruction {
                mode: AddressingMode::AbsoluteY,
                operand: Some(Operand::Label { offset: None, .. }),
                ..
            }
        ));
        assert!(matches!(
            indexed("STA", "L", 2),
            Directive::Instruction {
                operand: Some(Operand::Label {
                    offset: Some(2),
                    ..
                }),
                ..
            }
        ));
    }

    #[test]
    fn width_checks_name_the_type() {
        assert!(require8_bit(Some("utinyint"), "x").is_ok());
        assert!(
            require8_bit(None, "x")
                .unwrap_err()
                .starts_with("x: no type")
        );
        assert!(
            require8_bit(Some("usmallint"), "x")
                .unwrap_err()
                .contains("(2 bytes)")
        );
        assert!(require16_bit(Some("usmallint"), "x").is_ok());
        assert!(
            require16_bit(None, "x")
                .unwrap_err()
                .starts_with("x: no type")
        );
        assert!(
            require16_bit(Some("bool"), "x")
                .unwrap_err()
                .contains("(1 bytes)")
        );
        assert!(!is_signed("bool"));
        assert!(is_signed("tinyint"));
        assert!(!is_signed("utinyint"));
        assert!(!is_signed("nonsense"));
    }

    #[test]
    fn operator_tables() {
        for op in ["==", "!=", "<", ">", "<=", ">="] {
            assert!(order_branch_if_true(op).is_some());
            assert_eq!(negate(negate(op).unwrap()), Some(op));
            assert_eq!(mirror(mirror(op).unwrap()), Some(op));
            assert!(is_comparison_operator(op));
        }
        assert_eq!(
            order_branch_if_true("<"),
            Some(BranchPlan::Double("BEQ", "BCS"))
        );
        assert_eq!(
            order_branch_if_true(">="),
            Some(BranchPlan::Either("BCC", "BEQ"))
        );
        assert_eq!(
            order_branch_if_true("=="),
            Some(BranchPlan::Mnemonic("BEQ"))
        );
        assert_eq!(order_branch_if_true("+"), None);
        assert_eq!(negate("+"), None);
        assert_eq!(mirror("+"), None);
        assert!(is_ordering_operator("<") && !is_ordering_operator("=="));
        assert!(is_equality_operator("!=") && !is_equality_operator("<"));
        assert!(!is_comparison_operator("+"));
    }

    #[test]
    fn expression_accessors() {
        let c = konst(1, None);
        assert_eq!(expr_kind(&c), "const");
        assert_eq!(expr_type(&c), None);
        assert!(!has_type(&c));
        assert!(has_type(&konst(1, Some("utinyint"))));
        assert!(!has_type(&konst(1, Some(""))));
        assert!(type_is_bytes(&konst(1, Some("usmallint")), 2));
        let u = Expr::Unop(Unop {
            operator: "-".into(),
            argument: Box::new(c),
            ty: Some("tinyint".into()),
        });
        assert_eq!((expr_kind(&u), expr_type(&u)), ("unop", Some("tinyint")));
    }

    #[test]
    fn index_offsets_split_off_a_constant() {
        let i = reference("i", Some("utinyint"));
        let sum = binop("+", i.clone(), konst(250, None), "utinyint");
        let (idx, off) = split_index_offset(Some(&sum)).unwrap();
        assert_eq!((idx, off), (&i, 250));
        let flipped = binop("+", konst(3, None), i.clone(), "utinyint");
        assert_eq!(split_index_offset(Some(&flipped)).unwrap().1, 3);
        let wide = binop(
            "+",
            reference("w", Some("usmallint")),
            konst(3, None),
            "usmallint",
        );
        assert!(split_index_offset(Some(&wide)).is_none());
        let negative = binop("+", i.clone(), konst(-1, None), "utinyint");
        assert!(split_index_offset(Some(&negative)).is_none());
        let negative_left = binop("+", konst(-1, None), i.clone(), "utinyint");
        assert!(split_index_offset(Some(&negative_left)).is_none());
        assert!(
            split_index_offset(Some(&binop("-", i.clone(), konst(1, None), "utinyint"))).is_none()
        );
        assert!(split_index_offset(Some(&i)).is_none());
        assert!(split_index_offset(None).is_none());
    }

    #[test]
    fn predicates_over_nodes() {
        assert!(is_const_num(Some(&konst(5, None)), None));
        assert!(is_const_num(Some(&konst(5, None)), Some(5)));
        assert!(!is_const_num(Some(&konst(5, None)), Some(6)));
        assert!(!is_const_num(Some(&reference("a", None)), None));
        assert!(!is_const_num(None, None));
        assert!(is_ref_named(Some(&reference("a", None)), "a"));
        assert!(!is_ref_named(Some(&reference("a", None)), "b"));
        assert!(!is_ref_named(None, "a"));
        let pure = binop("+", reference("a", None), konst(1, None), "utinyint");
        assert!(is_pure(Some(&pure)));
        assert!(!is_pure(None));
        let call = Expr::Call(mos_ir::Call {
            name: "f".into(),
            args: vec![],
            ty: jsnum::Nullable::Absent,
            start: None,
            length: None,
            instance: None,
        });
        assert!(!is_pure(Some(&call)));
        assert!(!is_pure(Some(&binop(
            "+",
            call,
            konst(1, None),
            "utinyint"
        ))));
        let un = Expr::Unop(Unop {
            operator: "!".into(),
            argument: Box::new(reference("a", None)),
            ty: Some("bool".into()),
        });
        assert!(is_pure(Some(&un)));
    }

    fn fill_loop(count: i64, value: i64, base: i64) -> Stmt {
        let lt = |n: i64| binop("<", reference("i", None), konst(n, None), "bool");
        Stmt::For(mos_ir::For {
            init: jsnum::Nullable::Value(Box::new(Stmt::Local(mos_ir::Local {
                name: "i".into(),
                ty: "utinyint".into(),
                init: konst(0, None),
                inlined: None,
                start: None,
                length: None,
            }))),
            test: jsnum::Nullable::Value(lt(count)),
            update: jsnum::Nullable::Value(Box::new(Stmt::Assign(mos_ir::Assign {
                target: "i".into(),
                value: binop("+", reference("i", None), konst(1, None), "utinyint"),
                start: None,
                length: None,
            }))),
            body: vec![Stmt::MemoryWrite(mos_ir::MemoryWrite {
                address: binop("+", konst(base, None), reference("i", None), "usmallint"),
                value: konst(value, None),
                start: 0,
                length: 0,
            })],
            unroll: None,
            start: None,
            length: None,
        })
    }

    #[test]
    fn const_fill_loops_are_recognised() {
        assert_eq!(
            match_const_fill(&fill_loop(40, 32, 0x400)),
            Some(ConstFill {
                base: 0x400,
                count: 40,
                value: 32
            })
        );
        assert!(match_const_fill(&fill_loop(0, 32, 0x400)).is_none());
        assert!(match_const_fill(&fill_loop(0x10001, 32, 0x400)).is_none());
        assert!(match_const_fill(&fill_loop(40, 256, 0x400)).is_none());
        assert!(match_const_fill(&fill_loop(40, 32, 0xffff)).is_none());
        assert!(
            match_const_fill(&Stmt::Break(mos_ir::Break {
                start: 0,
                length: 0
            }))
            .is_none()
        );
        // Operands swapped in the address: `i + base`.
        let mut swapped = fill_loop(4, 1, 0x400);
        if let Stmt::For(f) = &mut swapped
            && let Stmt::MemoryWrite(w) = &mut f.body[0]
        {
            w.address = binop("+", reference("i", None), konst(0x400, None), "usmallint");
        }
        assert_eq!(match_const_fill(&swapped).unwrap().base, 0x400);
        // Not a `+` address.
        if let Stmt::For(f) = &mut swapped
            && let Stmt::MemoryWrite(w) = &mut f.body[0]
        {
            w.address = konst(0x400, None);
        }
        assert!(match_const_fill(&swapped).is_none());
    }

    #[test]
    fn expr_lowers_consts_refs_and_refuses_the_rest() {
        let mut opts = options(None);
        let mut c = Counters::default();
        let mut l = Lowerer::new(&mut opts, &mut c);
        assert_eq!(l.exit_label, "__8bs_exit_0");
        l.expr(&konst(0x1ff, Some("utinyint"))).unwrap();
        l.expr(&reference("g", None)).unwrap();
        l.expr(&reference("p", None)).unwrap();
        assert_eq!(l.program, vec![lda_imm(0xff), lda_zp(0x10), lda_zp(0x20)]);
        assert!(
            l.expr(&reference("nope", None))
                .unwrap_err()
                .contains("resolves to nothing")
        );
        assert!(
            l.expr(&konst(1, Some("usmallint")))
                .unwrap_err()
                .contains("only lowers 8-bit")
        );
        let record = Expr::Record(mos_ir::Record {
            fields: vec![],
            start: 0,
            length: 0,
        });
        assert!(l.expr(&record).unwrap_err().contains("'record' expression"));
        // Delegated kinds reach the stubs of the other files.
        let un = Expr::Unop(Unop {
            operator: "!".into(),
            argument: Box::new(konst(1, None)),
            ty: Some("bool".into()),
        });
        assert_eq!(l.expr(&un), Ok(()));
        assert_eq!(
            l.expr(&binop("+", konst(1, None), konst(2, None), "utinyint")),
            Ok(())
        );
    }

    #[test]
    fn expr_delegates_each_kind() {
        let mut opts = options(None);
        let mut c = Counters::default();
        let mut l = Lowerer::new(&mut opts, &mut c);
        let sl = Expr::StringLength(mos_ir::StringLength {
            string: Box::new(konst(0, None)),
            ty: "utinyint".into(),
            start: None,
            length: None,
        });
        assert_eq!(l.expr(&sl), Ok(()));
        let sb = Expr::StringByte(mos_ir::StringByte {
            string: Box::new(konst(0, None)),
            index: Box::new(konst(0, None)),
            ty: "utinyint".into(),
        });
        assert_eq!(l.expr(&sb), Ok(()));
        let ix = Expr::Index(mos_ir::Index {
            array: Box::new(reference("a", None)),
            index: Box::new(konst(0, None)),
            element_type: Some("utinyint".into()),
            ty: Some("utinyint".into()),
        });
        assert!(
            l.expr(&ix)
                .unwrap_err()
                .starts_with("'a' resolves to no array this backend placed")
        );
        let mr = Expr::MemoryRead(mos_ir::MemoryRead {
            address: Box::new(konst(0, None)),
            ty: "utinyint".into(),
            start: 0,
            length: 0,
        });
        assert_eq!(l.expr(&mr), Ok(()));
        let call = Expr::Call(mos_ir::Call {
            name: "f".into(),
            args: vec![],
            ty: jsnum::Nullable::Absent,
            start: None,
            length: None,
            instance: None,
        });
        assert!(
            l.expr(&call)
                .unwrap_err()
                .starts_with("call to 'f' resolves to nothing")
        );
        let cond = Expr::Cond(mos_ir::Cond {
            test: Box::new(konst(1, None)),
            consequent: Box::new(konst(1, None)),
            alternate: Box::new(konst(2, None)),
            ty: jsnum::Nullable::Absent,
        });
        assert_eq!(l.expr(&cond), Ok(()));
        // The two labels were taken in order.
        assert_eq!(l.counters.lower, 3);
    }

    #[test]
    fn expr8_handles_narrow_values_and_wide_bitwise_with_a_constant() {
        let mut opts = options(None);
        let mut c = Counters::default();
        let mut l = Lowerer::new(&mut opts, &mut c);
        l.expr8(&konst(7, Some("utinyint"))).unwrap();
        assert_eq!(l.program, vec![lda_imm(7)]);
        // `wide >> 16` is zero; the allocator is untouched.
        let wide = reference("w", Some("usmallint"));
        l.expr8(&binop(">>", wide.clone(), konst(16, None), "usmallint"))
            .unwrap();
        assert_eq!(l.program.last(), Some(&lda_imm(0)));
        // `wide >> 9` goes through exprTo16 and refuses the unbound name.
        let unbound = |r: Result<(), String>| {
            assert!(r.unwrap_err().starts_with("'w' resolves to nothing"));
        };
        unbound(l.expr8(&binop(">>", wide.clone(), konst(9, None), "usmallint")));
        // `wide & 0xff00` masks the low byte of the left side.
        unbound(l.expr8(&binop("&", wide.clone(), konst(0xff00, None), "usmallint")));
        // Anything else: the wide value is evaluated and its low byte loaded.
        unbound(l.expr8(&wide));
    }

    #[test]
    fn expr8_bitwise_identity_masks_emit_nothing() {
        let mut opts = options(None);
        let mut c = Counters::default();
        let mut l = Lowerer::new(&mut opts, &mut c);
        let narrow_left = konst(5, Some("utinyint"));
        // `(5 & 0x1ff)` typed wide: mask 0xff is the identity for `&`.
        let node = Expr::Binop(mos_ir::Binop {
            operator: "&".into(),
            left: Box::new(narrow_left.clone()),
            right: Box::new(konst(0x1ff, None)),
            ty: Some("usmallint".into()),
        });
        l.expr8(&node).unwrap();
        assert_eq!(l.program, vec![lda_imm(5)]);
        let or = Expr::Binop(mos_ir::Binop {
            operator: "|".into(),
            left: Box::new(narrow_left.clone()),
            right: Box::new(konst(0x0f, None)),
            ty: Some("usmallint".into()),
        });
        l.expr8(&or).unwrap();
        assert_eq!(
            l.program[1..],
            [
                lda_imm(5),
                instr("ORA", AddressingMode::Immediate, Some(0x0f), None)
            ]
        );
        let xor = Expr::Binop(mos_ir::Binop {
            operator: "^".into(),
            left: Box::new(narrow_left),
            right: Box::new(konst(0x100, None)),
            ty: Some("usmallint".into()),
        });
        l.expr8(&xor).unwrap();
        assert_eq!(l.program.len(), 4);
    }

    #[test]
    fn emit_stamps_provenance_only_where_missing() {
        let mut opts = options(Some("main"));
        let mut c = Counters::default();
        let mut l = Lowerer::new(&mut opts, &mut c);
        l.current_origin = Some("callee".into());
        let preset = Provenance {
            source: None,
            function: Some("other".into()),
            origin: None,
            component: None,
            instance: None,
            generated: None,
        };
        let mut stamped = lda_imm(1);
        *prov_slot(&mut stamped) = Some(preset.clone());
        let byte = Directive::Byte {
            values: vec![1],
            prov: None,
        };
        let eq = Directive::Equate {
            name: "n".into(),
            value: 1,
            prov: None,
        };
        l.emit([stamped, label("L"), byte, eq]);
        let provs: Vec<_> = l
            .program
            .iter()
            .map(|d| prov_slot(&mut d.clone()).clone().unwrap())
            .collect();
        assert_eq!(provs[0], preset);
        for p in &provs[1..] {
            assert_eq!(p.function.as_deref(), Some("main"));
            assert_eq!(p.origin.as_deref(), Some("callee"));
        }
        // No fnName: nothing is stamped.
        let mut plain = options(None);
        let mut c2 = Counters::default();
        let mut l2 = Lowerer::new(&mut plain, &mut c2);
        l2.emit([lda_imm(1)]);
        assert!(prov_slot(&mut l2.program[0]).is_none());
    }

    #[test]
    fn jumps_to_the_next_label_are_removed_to_a_fixed_point() {
        let program = vec![
            branch("BEQ", "a"),
            jmp("a"),
            label("b"),
            label("a"),
            jmp("b"),
            lda_imm(1),
            jmp("far"),
            lda_imm(2),
            label("far"),
        ];
        let removed = jumps_to_next_label(&program);
        // BEQ a and JMP a hit label a; JMP b targets a label that is behind it.
        assert_eq!(removed.into_iter().collect::<Vec<_>>(), vec![0, 1]);
        // An operand-less or value-operand jump is skipped, and a non-label stops the scan.
        let odd = vec![
            instr("JMP", AddressingMode::Absolute, Some(0x1000), None),
            Directive::Byte {
                values: vec![1],
                prov: None,
            },
            label("x"),
        ];
        assert!(jumps_to_next_label(&odd).is_empty());
        let skip_removed = vec![jmp("x"), jmp("x"), label("x")];
        assert_eq!(jumps_to_next_label(&skip_removed).len(), 2);
        assert!(
            jumps_to_next_label(&[instr("RTS", AddressingMode::Implied, None, None)]).is_empty()
        );
    }

    #[test]
    fn redundant_reloads_follow_the_anchor_rules() {
        // LDA #1 ; STA 5 ; LDA #1 -> the second reload goes.
        let p = vec![lda_imm(1), sta_zp(5), lda_imm(1)];
        let mut removed = BTreeSet::new();
        redundant_reloads(&p, &mut removed);
        assert_eq!(removed.into_iter().collect::<Vec<_>>(), vec![2]);
        // STA to the very address reloaded, anchored by a flags-from-A op.
        let p = vec![
            instr("ADC", AddressingMode::Immediate, Some(1), None),
            sta_zp(5),
            lda_zp(5),
        ];
        let mut removed = BTreeSet::new();
        redundant_reloads(&p, &mut removed);
        assert_eq!(removed.into_iter().collect::<Vec<_>>(), vec![2]);
        // The anchor `LDA` of another operand does not qualify; a label stops the scan.
        let p = vec![lda_imm(2), lda_imm(1), label("L"), lda_imm(1)];
        let mut removed = BTreeSet::new();
        redundant_reloads(&p, &mut removed);
        assert!(removed.is_empty());
        // An anchor that does not set flags from A (TAX) blocks it.
        let p = vec![
            instr("TAX", AddressingMode::Implied, None, None),
            lda_imm(1),
        ];
        let mut removed = BTreeSet::new();
        redundant_reloads(&p, &mut removed);
        assert!(removed.is_empty());
        // The accumulator-mode anchor qualifies only with a matching STA.
        let p = vec![
            instr("LSR", AddressingMode::Accumulator, None, None),
            sta_zp(5),
            lda_zp(5),
        ];
        let mut removed = BTreeSet::new();
        redundant_reloads(&p, &mut removed);
        assert_eq!(removed.len(), 1);
        // Absolute loads never qualify (a hardware read has a side effect), and
        // already-removed entries are skipped on both scans.
        let p = vec![lda_imm(1), lda_addr(0x1000), lda_addr(0x1000), lda_imm(1)];
        let mut removed = BTreeSet::from([1]);
        redundant_reloads(&p, &mut removed);
        assert!(!removed.contains(&3));
        let mut pre = BTreeSet::from([3]);
        redundant_reloads(&p, &mut pre);
        assert_eq!(pre.len(), 1);
        // No anchor at all.
        let mut removed = BTreeSet::new();
        redundant_reloads(&[lda_imm(1)], &mut removed);
        assert!(removed.is_empty());
    }

    #[test]
    fn finish_closes_filters_and_slices() {
        let mut opts = options(Some("main"));
        let mut c = Counters::default();
        let mut l = Lowerer::new(&mut opts, &mut c);
        l.emit([
            lda_imm(1),
            sta_zp(5),
            lda_imm(1),
            jmp("next"),
            label("next"),
        ]);
        let ranges = vec![
            BlockRange {
                origin: None,
                start: 0,
                end: 3,
            },
            BlockRange {
                origin: Some("callee".into()),
                start: 3,
                end: 5,
            },
        ];
        let out = finish(l, ranges);
        // The JMP to the next label and the redundant reload are gone; the exit label is last.
        let names: Vec<_> = out
            .program
            .iter()
            .map(|d| match d {
                Directive::Label { name, .. } => name.clone(),
                Directive::Instruction { mnemonic, .. } => mnemonic.clone(),
                _ => String::new(),
            })
            .collect();
        assert_eq!(names, ["LDA", "STA", "next", "__8bs_exit_0"]);
        assert_eq!(out.parts.len(), 2);
        assert_eq!(out.parts[0].program.len(), 2);
        assert_eq!(out.parts[1].origin.as_deref(), Some("callee"));
        assert_eq!(out.parts[1].program.len(), 1);
    }

    #[test]
    fn lower_counts_one_label_for_an_empty_body() {
        let mut opts = options(Some("main"));
        let mut c = Counters::default();
        assert!(lower(&[], &mut opts, &mut c).is_ok());
        assert_eq!(c.lower, 1);
    }
}
