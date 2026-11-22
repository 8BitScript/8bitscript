//! Port of `packages/compiler/src/wasm/encode.ts` (all of it).
//!
//! Low-level WebAssembly binary format encoding: LEB128 varints and section framing.

use crate::WasmError;

/// A wasm value type, as its one-byte encoding.
pub mod val_type {
    pub const I32: u8 = 0x7f;
    pub const I64: u8 = 0x7e;
    pub const F32: u8 = 0x7d;
    pub const F64: u8 = 0x7c;
}

/// Section ids, in the order the binary format requires them to appear.
pub mod section_id {
    pub const TYPE: u8 = 1;
    pub const IMPORT: u8 = 2;
    pub const FUNCTION: u8 = 3;
    pub const TABLE: u8 = 4;
    pub const MEMORY: u8 = 5;
    pub const GLOBAL: u8 = 6;
    pub const EXPORT: u8 = 7;
    pub const START: u8 = 8;
    pub const ELEMENT: u8 = 9;
    pub const CODE: u8 = 10;
    pub const DATA: u8 = 11;
}

/// The kind byte an export (or import) entry names what it refers to as.
pub mod external_kind {
    pub const FUNC: u8 = 0x00;
    pub const TABLE: u8 = 0x01;
    pub const MEMORY: u8 = 0x02;
    pub const GLOBAL: u8 = 0x03;
}

/// A function type's own tag byte, ahead of its param/result vectors.
const FUNC_TYPE_TAG: u8 = 0x60;

/// A block/loop/if's own result shape.
pub mod block_type {
    pub const EMPTY: u8 = 0x40;
    pub const I32: u8 = 0x7f;
}

/// Instruction opcodes.
pub mod opcode {
    pub const UNREACHABLE: u8 = 0x00;
    pub const END: u8 = 0x0b;
    pub const BLOCK: u8 = 0x02;
    pub const LOOP: u8 = 0x03;
    pub const IF: u8 = 0x04;
    pub const ELSE: u8 = 0x05;
    pub const BR: u8 = 0x0c;
    pub const BR_IF: u8 = 0x0d;
    pub const RETURN: u8 = 0x0f;
    pub const CALL: u8 = 0x10;
    pub const DROP: u8 = 0x1a;
    pub const LOCAL_GET: u8 = 0x20;
    pub const LOCAL_SET: u8 = 0x21;
    pub const I32_CONST: u8 = 0x41;
    pub const I32_EQZ: u8 = 0x45;
    pub const I32_EQ: u8 = 0x46;
    pub const I32_NE: u8 = 0x47;
    pub const I32_LT_S: u8 = 0x48;
    pub const I32_LT_U: u8 = 0x49;
    pub const I32_GT_S: u8 = 0x4a;
    pub const I32_GT_U: u8 = 0x4b;
    pub const I32_LE_S: u8 = 0x4c;
    pub const I32_LE_U: u8 = 0x4d;
    pub const I32_GE_S: u8 = 0x4e;
    pub const I32_GE_U: u8 = 0x4f;
    pub const I32_ADD: u8 = 0x6a;
    pub const I32_SUB: u8 = 0x6b;
    pub const I32_MUL: u8 = 0x6c;
    pub const I32_DIV_U: u8 = 0x6e;
    pub const I32_REM_U: u8 = 0x70;
    pub const I32_AND: u8 = 0x71;
    pub const I32_OR: u8 = 0x72;
    pub const I32_XOR: u8 = 0x73;
    pub const I32_SHL: u8 = 0x74;
    pub const I32_SHR_U: u8 = 0x76;
    pub const I32_LOAD8_U: u8 = 0x2d;
    pub const I32_LOAD16_U: u8 = 0x2f;
    pub const I32_STORE8: u8 = 0x3a;
    pub const I32_STORE16: u8 = 0x3b;
    pub const SELECT: u8 = 0x1b;
    pub const GLOBAL_GET: u8 = 0x23;
    pub const GLOBAL_SET: u8 = 0x24;
}

/// A global's mutability flag.
pub mod mutability {
    pub const CONST: u8 = 0x00;
    pub const VAR: u8 = 0x01;
}

/// `Number.isInteger`.
fn is_integer(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0
}

/// The body of `unsignedLEB128` after its check: ordinary f64 arithmetic, as in JS.
fn leb_f64(value: f64) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut v = value;
    loop {
        // `v % 128` is in [0, 128) here, so the cast is exact (and -0 becomes 0, as in a Uint8Array).
        let mut byte = (v % 128.0) as u8;
        v = (v / 128.0).floor();
        if v != 0.0 {
            byte |= 0x80;
        }
        bytes.push(byte);
        if v == 0.0 {
            break;
        }
    }
    bytes
}

/// `value` as an unsigned LEB128 byte sequence.
///
/// # Errors
/// `RangeError` text when `value` is not a non-negative integer.
pub fn unsigned_leb128(value: f64) -> Result<Vec<u8>, WasmError> {
    if !is_integer(value) || value < 0.0 {
        return Err(WasmError::Range(format!(
            "unsignedLEB128: {} is not a non-negative integer",
            jsnum::number_to_string(value)
        )));
    }
    Ok(leb_f64(value))
}

/// `value` as a signed LEB128 byte sequence.
///
/// # Errors
/// `RangeError` text when `value` is not an integer.
pub fn signed_leb128(value: f64) -> Result<Vec<u8>, WasmError> {
    if !is_integer(value) {
        return Err(WasmError::Range(format!(
            "signedLEB128: {} is not an integer",
            jsnum::number_to_string(value)
        )));
    }
    let mut bytes = Vec::new();
    let mut v = jsnum::to_int32(value);
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if (v == 0 && (byte & 0x40) == 0) || (v == -1 && (byte & 0x40) != 0) {
            bytes.push(byte);
            break;
        }
        byte |= 0x80;
        bytes.push(byte);
    }
    Ok(bytes)
}

/// A count (unsigned LEB128) followed by every item's own bytes, concatenated.
#[must_use]
pub fn vector(items: &[Vec<u8>]) -> Vec<u8> {
    let mut out = leb_f64(items.len() as f64);
    for item in items {
        out.extend_from_slice(item);
    }
    out
}

/// A wasm `name`: its UTF-8 byte length (unsigned LEB128), then the bytes themselves.
#[must_use]
pub fn encode_name(name: &str) -> Vec<u8> {
    let bytes = name.as_bytes();
    let mut out = leb_f64(bytes.len() as f64);
    out.extend_from_slice(bytes);
    out
}

/// `memory.copy`: the 0xFC prefix, sub-opcode 10, then the two memory indices.
#[must_use]
pub fn memory_copy() -> Vec<u8> {
    let mut out = vec![0xfc];
    out.extend(leb_f64(10.0));
    out.extend([0x00, 0x00]);
    out
}

/// A load/store instruction's own immediate: alignment, then a constant byte offset.
///
/// # Errors
/// Either operand is not a non-negative integer.
pub fn memarg(align: f64, offset: f64) -> Result<Vec<u8>, WasmError> {
    let mut out = unsigned_leb128(align)?;
    out.extend(unsigned_leb128(offset)?);
    Ok(out)
}

/// One data-section entry: an active segment against memory 0 at a constant offset.
///
/// # Errors
/// `offset` is not an integer.
pub fn active_data_segment(offset: f64, bytes: &[u8]) -> Result<Vec<u8>, WasmError> {
    let mut out = vec![0x00, opcode::I32_CONST];
    out.extend(signed_leb128(offset)?);
    out.push(opcode::END);
    out.extend(leb_f64(bytes.len() as f64));
    out.extend_from_slice(bytes);
    Ok(out)
}

/// One function type: the tag, the param vector, the result vector.
#[must_use]
pub fn func_type(params: &[u8], results: &[u8]) -> Vec<u8> {
    let each = |types: &[u8]| types.iter().map(|t| vec![*t]).collect::<Vec<_>>();
    let mut out = vec![FUNC_TYPE_TAG];
    out.extend(vector(&each(params)));
    out.extend(vector(&each(results)));
    out
}

/// One import-section entry for a function import.
///
/// # Errors
/// `type_index` is not a non-negative integer.
pub fn import_func(
    module_name: &str,
    field_name: &str,
    type_index: f64,
) -> Result<Vec<u8>, WasmError> {
    let mut out = encode_name(module_name);
    out.extend(encode_name(field_name));
    out.push(external_kind::FUNC);
    out.extend(unsigned_leb128(type_index)?);
    Ok(out)
}

/// `limits`: a memory or table's size, with the flag byte recording `max` and `shared`.
///
/// # Errors
/// `shared` without a `max`, or an operand that is not a non-negative integer.
pub fn limits(min: f64, max: Option<f64>, shared: Option<bool>) -> Result<Vec<u8>, WasmError> {
    let shared = shared == Some(true);
    let Some(max) = max else {
        if shared {
            return Err(WasmError::Range(
                "limits: a shared memory needs a declared max — the binary format has no shared+unbounded combination"
                    .to_string(),
            ));
        }
        let mut out = vec![0x00];
        out.extend(unsigned_leb128(min)?);
        return Ok(out);
    };
    let mut out = vec![if shared { 0x03 } else { 0x01 }];
    out.extend(unsigned_leb128(min)?);
    out.extend(unsigned_leb128(max)?);
    Ok(out)
}

/// One section: its id byte, the encoded byte length of `content`, then `content` itself.
#[must_use]
pub fn section(id: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![id];
    out.extend(leb_f64(content.len() as f64));
    out.extend_from_slice(content);
    out
}

/// The 8-byte module header every `.wasm` file starts with: magic number, then version 1.
pub const MODULE_HEADER: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/// The header and every given section, in the order given.
#[must_use]
pub fn assemble_module(sections: &[Vec<u8>]) -> Vec<u8> {
    let mut out = MODULE_HEADER.to_vec();
    for s in sections {
        out.extend_from_slice(s);
    }
    out
}
