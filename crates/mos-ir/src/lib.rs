//! Types for `backend-input.json`: what the 6502 backend reads (spec section 5).
//!
//! The JS side is `packages/compiler/src/mos/index.ts` (the `dump` call right
//! after `optimizeReachable`) and the IR shapes of `ir/index.mjs`,
//! `mos/lower/index.ts` and `mos/zp/index.ts`. Every struct refuses unknown
//! fields, and every integer is an `i64` that refuses a fractional value, so a
//! shape this crate does not know is an error and never a silent skip.
//!
//! [`parse`] and [`to_canonical`] are inverses on the canonical dump text
//! (spec section 2.3): sorted keys, two-space indent, JS number text.

mod expr;
mod linked;
mod program;
mod stmt;
pub mod walk;

pub use expr::{
    Binop, Call, Cond, Const, Expr, Index, MemoryRead, NamespaceCall, NamespaceConst, PortRead,
    Record, RecordField, Ref, StringByte, StringLength, StringLiteral, Unop,
};
pub use linked::{
    Instance, LinkedProgram, Memory, parse_linked, roundtrip_linked, to_canonical_linked,
};
pub use program::{
    ArrayElement, BackendInput, ChrPatch, FrameHook, Function, Global, GlobalInit, Hardware,
    HardwareBuild, IrString, Param, Remark, StateField,
};
pub use stmt::{
    Asm, Assign, Block, Break, Continue, For, If, Local, MemoryWrite, PortWrite, Return, Stmt,
    StoreIndex, StringCopy, WaitFrame, While,
};

use serde::Serialize;

/// Reads a `backend-input.json` text.
///
/// # Errors
/// Returns the parser's message (with line and column) for malformed JSON, an
/// unknown field, an unknown node kind, a missing field or a wrong value type.
pub fn parse(text: &str) -> Result<BackendInput, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

/// Writes the canonical dump text for `input`: `JSON.stringify(sortKeys(v), null, 2) + "\n"`.
///
/// # Errors
/// Returns the serializer's message when a value cannot be represented.
pub fn to_canonical(input: &BackendInput) -> Result<String, String> {
    let value = input
        .serialize(serde_json::value::Serializer)
        .map_err(|e| e.to_string())?;
    Ok(oracle::canonical_json(&value))
}

/// Parses `text`, writes it back and compares the bytes.
///
/// # Errors
/// Returns a one-line description: the parse error, or the first line where
/// the re-serialized text differs.
pub fn roundtrip(text: &str) -> Result<(), String> {
    let input = parse(text)?;
    let again = to_canonical(&input)?;
    same_text(text, &again)
}

/// `Ok` when the texts are equal; otherwise the first differing line.
pub(crate) fn same_text(text: &str, again: &str) -> Result<(), String> {
    if again == text {
        return Ok(());
    }
    let (mut a, mut b) = (text.lines(), again.lines());
    let mut line = 0;
    loop {
        line += 1;
        let (x, y) = (a.next(), b.next());
        if x != y {
            let show = |s: Option<&str>| s.map_or("<end>".to_string(), |s| s.trim().to_string());
            return Err(format!(
                "bytes differ at line {line}: dump={} rewritten={}",
                show(x),
                show(y)
            ));
        }
        if x.is_none() {
            return Err("bytes differ in the final newline".to_string());
        }
    }
}
