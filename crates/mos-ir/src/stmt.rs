//! Statement nodes (`ir/index.mjs`, `mos/lower/index.ts` `IrStatement`).

use jsnum::Nullable;
use serde::{Deserialize, Serialize};

use crate::expr::{Call, Expr, MemoryRead, NamespaceCall};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Stmt {
    Asm(Asm),
    Assign(Assign),
    Block(Block),
    Break(Break),
    /// A bare call statement is the same node as a call expression.
    Call(Call),
    Continue(Continue),
    For(For),
    If(If),
    Local(Local),
    /// A discarded `memory.read(...)`: the same node as the expression.
    MemoryRead(MemoryRead),
    MemoryWrite(MemoryWrite),
    Return(Return),
    StoreIndex(StoreIndex),
    WaitFrame(WaitFrame),
    While(While),
    // Shapes in the TS that no corpus build has produced yet (rulebook R3).
    PortWrite(PortWrite),
    StringCopy(StringCopy),
    NamespaceCall(NamespaceCall),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asm {
    pub text: String,
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assign {
    pub target: String,
    pub value: Expr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<i64>,
}

/// A nested block; `origin` names the callee an inlined block came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
    pub body: Vec<Stmt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Break {
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Continue {
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaitFrame {
    pub start: i64,
    pub length: i64,
}

/// `init` and `update` are statements (a `local` or an `assign`); `test` an expression.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct For {
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub init: Nullable<Box<Stmt>>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub test: Nullable<Expr>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub update: Nullable<Box<Stmt>>,
    pub body: Vec<Stmt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unroll: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct If {
    pub test: Expr,
    pub then: Vec<Stmt>,
    /// `null` when there is no else arm.
    pub r#else: Option<Vec<Stmt>>,
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Local {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub init: Expr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inlined: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryWrite {
    pub address: Expr,
    pub value: Expr,
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Return {
    /// `null` for a bare `return`.
    pub value: Option<Expr>,
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreIndex {
    pub array: Expr,
    pub index: Expr,
    pub value: Expr,
    pub element_type: String,
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct While {
    pub test: Expr,
    pub body: Vec<Stmt>,
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortWrite {
    pub port: Expr,
    pub value: Expr,
    pub start: i64,
    pub length: i64,
}

/// `buffer = string`: `target` is a `ref` to the `string<capacity>` buffer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StringCopy {
    pub target: Expr,
    pub source: Expr,
    pub capacity: i64,
    pub start: i64,
    pub length: i64,
}
