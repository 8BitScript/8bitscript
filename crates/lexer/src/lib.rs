//! The lexer for the new `.8bs` syntax (port spec P3-03; syntax spec 5).
//!
//! Ported from `lexer/index.mjs` with the new token set: raw identifiers,
//! `@scope` after `use`, test macros, `::`/`->`/`=>`/`..`/`..=`, `#[` and no
//! `'` strings. It never panics and never fails: half-typed source is the
//! normal input, so every problem is a [`Diagnostic`] and scanning goes on.
//! Every span is a UTF-16 code-unit offset (rulebook R6.1).

mod scan;

use diagnostics::Diagnostic;
use serde::Serialize;
use syntax::{SourceKind, Token, TokenKind};

/// Keywords of `.8bs` and `.8bx` (syntax spec 5 `keyword`).
pub const KEYWORDS: [&str; 24] = [
    "as", "asm6502", "break", "const", "continue", "crate", "else", "false", "fn", "for", "if",
    "in", "let", "loop", "match", "mod", "mut", "pub", "return", "self", "super", "true", "use",
    "while",
];

/// Reserved words (syntax spec 5 `reserved`): keyword tokens the parser
/// answers with E3.
pub const RESERVED_WORDS: [&str; 6] = ["enum", "impl", "struct", "trait", "static", "type"];

/// Keywords of `.8bx` only: ordinary identifiers in `.8bs`.
pub const BX_KEYWORDS: [&str; 2] = ["component", "state"];

/// The macro names that lex as one `macro` token with their `!`.
pub const MACRO_NAMES: [&str; 4] = ["assert", "assert_eq", "assert_ne", "panic"];

/// Type names: the integer spellings (`types/index.mjs:92`) plus the
/// built-in constructors (`lexer/index.mjs:64-67`).
pub const TYPE_NAMES: [&str; 22] = [
    "tinyint",
    "utinyint",
    "smallint",
    "usmallint",
    "mediumint",
    "umediumint",
    "int",
    "uint",
    "i8",
    "u8",
    "i16",
    "u16",
    "i24",
    "u24",
    "i32",
    "u32",
    "bool",
    "void",
    "string",
    "ptr",
    "array",
    "volatile",
];

/// Lexer options (`options.sourceKind` in the JS). Only `.8bx` changes
/// anything: the tag modes and the `component`/`state` keywords.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Options {
    pub source_kind: Option<SourceKind>,
}

/// What `tokenize` returns: `{tokens, diagnostics}` as in the JS dump.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Lexed {
    pub tokens: Vec<Token>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Tokenize a source file. Never fails; see the module docs.
#[must_use]
pub fn tokenize(text: &str, file: &str, options: &Options) -> Lexed {
    scan::Lexer::new(text, file, options.source_kind == Some(SourceKind::Bx)).run()
}

/// Tokens that leave a value in place, so a following `<` is a comparison
/// (in `.8bx`, not a tag) (`isOperandToken`, `lexer/index.mjs:100`).
/// The caller must already have skipped comments. The `controlHeader`
/// special case is gone: braces are required, so a `)` never ends a header
/// that an element can follow, and `++` no longer lexes as an operand.
#[must_use]
pub fn is_operand_token(tok: Option<&Token>) -> bool {
    let Some(tok) = tok else { return false };
    match tok.kind {
        TokenKind::Identifier
        | TokenKind::Number
        | TokenKind::String
        | TokenKind::Template
        | TokenKind::Type => true,
        TokenKind::Keyword => tok.text == "true" || tok.text == "false",
        TokenKind::Punctuation => tok.text == ")" || tok.text == "]",
        _ => false,
    }
}
