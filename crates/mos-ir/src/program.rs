//! The top level of `backend-input.json` and the program-wide tables.

use indexmap::IndexMap;
use jsnum::Nullable;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::expr::Expr;
use crate::stmt::Stmt;

/// The `dump('backend-input', ...)` value of `mos/index.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackendInput {
    pub machine: String,
    pub hardware: Hardware,
    /// May be fractional: the one float of the IR (rulebook R2.1).
    pub frame_rate: f64,
    pub report: bool,
    pub debug: bool,
    pub remarks: bool,
    pub entry: String,
    pub functions: Vec<Function>,
    pub globals: Vec<Global>,
    pub opt_remarks: Vec<Remark>,
    pub strings: Vec<IrString>,
    /// Tokenized paths (`<toolchain>/...`, `<project>/...`).
    pub native_sources: Vec<String>,
    pub chr_patches: Vec<ChrPatch>,
    /// Function name to tokenized path (`mos/index.ts` `originFiles`).
    pub origin_files: IndexMap<String, String>,
    pub frame_hook: FrameHook,
}

/// The resolved hardware (`packages/cli/src/hardware.mjs`), every field the
/// resolver returns. The backend reads `build` and `facts`; the rest rides along.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hardware {
    pub build: HardwareBuild,
    pub build_values: Vec<String>,
    /// Facts are free-form (`audio.voices` is a number, `audio.pcm` a bool, ...).
    pub facts: IndexMap<String, Value>,
    pub label: String,
    pub load: IndexMap<String, Value>,
    pub machine: String,
    pub options: IndexMap<String, Value>,
    pub profile: Option<String>,
    /// Emulator name to its argument list.
    pub run: IndexMap<String, Vec<String>>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HardwareBuild {
    pub defsym: IndexMap<String, i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameHook {
    pub name: Option<String>,
    pub used: bool,
}

/// `ir.strings`: the text and its bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IrString {
    pub text: String,
    pub bytes: Vec<u8>,
}

/// NES CHR-ROM tile patch (`ir.chrPatches`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChrPatch {
    pub tile: i64,
    pub bytes: Vec<u8>,
}

/// One optimizer remark: a diagnostic of severity `remark`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Remark {
    pub code: String,
    pub message: String,
    pub file: String,
    pub start: i64,
    pub length: i64,
    pub severity: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Function {
    pub name: String,
    pub exported: bool,
    /// Absent on functions the linker synthesizes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<bool>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub owner: Nullable<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_bind: Option<bool>,
    pub params: Vec<Param>,
    pub return_type: String,
    pub body: Vec<Stmt>,
    pub start: i64,
    pub length: i64,
    pub file: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Param {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Expr>,
    /// Array parameters only (refused by the backend; carried so the shape round-trips).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<i64>,
}

/// A global's initial value: a scalar, or a const array's elements. Module lowering also
/// leaves a pending expression (`ref`, `namespaceConst`) for the linker to resolve, as the
/// whole initializer or as some array elements.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum GlobalInit {
    Scalar(i64),
    Array(Vec<i64>),
    Pending(Box<Expr>),
    Elements(Vec<ArrayElement>),
}

/// One element of a module-level array initializer: a value, or a pending expression.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ArrayElement {
    Value(i64),
    Pending(Expr),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Global {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub volatile: bool,
    pub address: Option<i64>,
    pub init: Option<GlobalInit>,
    pub exported: bool,
    pub start: i64,
    pub length: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub array: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constant: Option<bool>,
    /// A `string<N>` buffer's capacity N (`ir/index.mjs`, next to `array: N + 1`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub string_capacity: Option<i64>,
}
