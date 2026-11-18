//! Expression nodes (`ir/index.mjs`, `mos/lower/index.ts` `IrExpr`).

use jsnum::Nullable;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Expr {
    Binop(Binop),
    Call(Call),
    Const(Const),
    Index(Index),
    MemoryRead(MemoryRead),
    Ref(Ref),
    String(StringLiteral),
    StringByte(StringByte),
    StringLength(StringLength),
    Unop(Unop),
    // Shapes in the TS that no corpus build has produced yet (rulebook R3).
    Cond(Cond),
    PortRead(PortRead),
    NamespaceCall(NamespaceCall),
    NamespaceConst(NamespaceConst),
    Record(Record),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binop {
    pub operator: String,
    pub left: Box<Expr>,
    pub right: Box<Expr>,
    #[serde(rename = "type")]
    pub ty: String,
}

/// A call, as an expression or (the same node) as a statement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Call {
    pub name: String,
    pub args: Vec<Expr>,
    #[serde(rename = "type", default, skip_serializing_if = "Nullable::is_absent")]
    pub ty: Nullable<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<i64>,
    /// An element's instance tag, when the elaborator gave the call one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Const {
    pub value: i64,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub ty: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Index {
    pub array: Box<Expr>,
    pub index: Box<Expr>,
    pub element_type: String,
    #[serde(rename = "type")]
    pub ty: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryRead {
    pub address: Box<Expr>,
    #[serde(rename = "type")]
    pub ty: String,
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ref {
    pub name: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub ty: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<i64>,
}

/// A string literal: `index` is the slot in `strings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StringLiteral {
    pub index: i64,
    #[serde(rename = "type")]
    pub ty: Option<String>,
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StringByte {
    pub string: Box<Expr>,
    pub index: Box<Expr>,
    #[serde(rename = "type")]
    pub ty: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StringLength {
    pub string: Box<Expr>,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Unop {
    pub operator: String,
    pub argument: Box<Expr>,
    #[serde(rename = "type")]
    pub ty: String,
}

/// `test ? consequent : alternate` (`ir/index.mjs` ConditionalExpression).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cond {
    pub test: Box<Expr>,
    pub consequent: Box<Expr>,
    pub alternate: Box<Expr>,
    #[serde(rename = "type", default, skip_serializing_if = "Nullable::is_absent")]
    pub ty: Nullable<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortRead {
    pub port: Box<Expr>,
    #[serde(rename = "type")]
    pub ty: String,
    pub start: i64,
    pub length: i64,
}

/// `namespace.member(args)`, resolved by the linker before a backend sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamespaceCall {
    pub namespace: String,
    pub member: String,
    pub args: Vec<Expr>,
    #[serde(rename = "type", default, skip_serializing_if = "Nullable::is_absent")]
    pub ty: Nullable<String>,
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamespaceConst {
    pub namespace: String,
    pub member: String,
    #[serde(rename = "type", default, skip_serializing_if = "Nullable::is_absent")]
    pub ty: Nullable<String>,
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub fields: Vec<RecordField>,
    pub start: i64,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordField {
    pub name: String,
    pub value: Expr,
    pub start: i64,
    pub length: i64,
}
