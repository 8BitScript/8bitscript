//! Tokens (`lexer/index.mjs:22-48, 226-227`). Spans are UTF-16 (R6.1).

use serde::{Deserialize, Serialize};

/// `TokenKind` strings (`lexer/index.mjs:22-48`); the JS string is the
/// serialized form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TokenKind {
    #[serde(rename = "comment")]
    Comment,
    #[serde(rename = "string")]
    String,
    #[serde(rename = "template")]
    Template,
    #[serde(rename = "number")]
    Number,
    #[serde(rename = "identifier")]
    Identifier,
    #[serde(rename = "keyword")]
    Keyword,
    #[serde(rename = "type")]
    Type,
    #[serde(rename = "decorator")]
    Decorator,
    #[serde(rename = "compileTime")]
    CompileTime,
    #[serde(rename = "asm")]
    AsmBlock,
    #[serde(rename = "punctuation")]
    Punctuation,
    #[serde(rename = "operator")]
    Operator,
    #[serde(rename = "bxTagOpen")]
    BxTagOpen,
    #[serde(rename = "bxTagEnd")]
    BxTagEnd,
    #[serde(rename = "bxSelfClose")]
    BxSelfClose,
    #[serde(rename = "bxClosingTagOpen")]
    BxClosingTagOpen,
    #[serde(rename = "bxText")]
    BxText,
}

/// `kind` of a template part (`lexer/index.mjs:324-348`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PartKind {
    Text,
    Field,
}

/// A template token part `{kind, start, end, sourceStart?, sourceEnd?}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePart {
    pub kind: PartKind,
    pub start: u32,
    pub end: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_start: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_end: Option<u32>,
}

/// A token `{kind, start, length, text, ...extra}` (`lexer/index.mjs:226-227`).
/// Every extra is optional and never null (R3.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub kind: TokenKind,
    pub start: u32,
    pub length: u32,
    pub text: String,
    /// String tokens that ran to the end of the line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unterminated: Option<bool>,
    /// Template tokens: the text runs and `${}` fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<TemplatePart>>,
    /// Number tokens: the parsed value (`parseInt`/`parseFloat`, so an f64).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radix: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_decimal: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numerator: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denominator: Option<f64>,
    /// `)` tokens that close a control header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_header: Option<bool>,
}
