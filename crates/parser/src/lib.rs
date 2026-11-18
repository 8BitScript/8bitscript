//! The parser for the new `.8bs` syntax (port spec P3-04 and P3-05; syntax
//! spec 2, 3, 6 and 7.1).
//!
//! Ported from `parser/index.mjs` with the new grammar. The structure,
//! messages and spans follow the JS parser: `expect` and `describe` build
//! `expected 'x', found 'y'`, `synchronize` turns one mistake into one
//! diagnostic, and a parenthesized expression is its inner node. New-syntax
//! sugar (`loop`, `match`, range `for`, `if` expressions, `use` paths)
//! becomes existing node kinds with the span of the source it stands for
//! (R6.3, R6.4). The parser never panics and always terminates: half-typed
//! source is the normal input (R6.5).
//!
//! The lexer already reports `++`, `--`, `?` and `'` strings (E1, E2, E5);
//! the parser recovers from them without reporting them again. The `.8bx`
//! tag grammar is P3-06.

mod expr;
mod matching;
mod stmt;
mod types;

use std::collections::HashSet;

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use serde::Serialize;
use syntax::{Node, NodeKind, Token, TokenKind, number_nodes, utf16_len};

/// What `parse` returns: `{ast, diagnostics}` as in the JS dump. The
/// diagnostics are the parser's own; the lexer's are separate.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Parsed {
    pub ast: Node,
    pub diagnostics: Vec<Diagnostic>,
}

/// Deepest nesting of statements, expressions and types before the parser
/// gives up on a file with one diagnostic. Keeps recursion bounded.
const MAX_NEST: u32 = 256;

/// Longest chain of operators, calls or indexes inside one expression, so a
/// tree's height stays bounded too.
const MAX_LINKS: u32 = 1500;

/// Parse a token stream. Never fails; see the crate docs.
#[must_use]
pub fn parse(tokens: &[Token], text: &str, file: &str) -> Parsed {
    let units: Vec<u16> = text.encode_utf16().collect();
    let kept: Vec<Token> = tokens
        .iter()
        .filter(|t| t.kind != TokenKind::Comment)
        .cloned()
        .collect();
    let mut parser = Parser::new(kept, &units, file);
    let body = parser.parse_program();
    let mut ast = Node::new(0, utf16_len(text), NodeKind::Program { body });
    number_nodes(&mut ast);
    Parsed {
        ast,
        diagnostics: parser.diagnostics,
    }
}

pub(crate) struct Parser<'a> {
    pub(crate) tokens: Vec<Token>,
    /// The source as UTF-16 code units, for template text (R6.1).
    pub(crate) units: &'a [u16],
    pub(crate) file: &'a str,
    pub(crate) pos: usize,
    pub(crate) diagnostics: Vec<Diagnostic>,
    /// In an `if`/`while`/`for` header a `{` opens the block, not a record.
    pub(crate) no_brace: bool,
    /// `(start, length)` of every expression that was written in parentheses,
    /// for E9 and E10 (a parenthesized expression is its inner node).
    pub(crate) parens: HashSet<(u32, u32)>,
    pub(crate) nest: u32,
    pub(crate) too_deep: bool,
    pub(crate) links: u32,
    pub(crate) expr_depth: u32,
    /// Where an end-of-file error lands when there is no token at all.
    pub(crate) eof: u32,
}

pub(crate) fn tok_end(t: &Token) -> u32 {
    t.start.saturating_add(t.length)
}

pub(crate) fn node_end(n: &Node) -> u32 {
    n.start.saturating_add(n.length)
}

fn is_op(t: &Token, text: &str) -> bool {
    matches!(t.kind, TokenKind::Punctuation | TokenKind::Operator) && t.text == text
}

/// Keywords that can begin a statement, used to resynchronise after an
/// error (syntax spec 6; mirror of `parser/index.mjs:36-40`).
const STATEMENT_START: [&str; 14] = [
    "use", "fn", "mod", "let", "const", "if", "while", "loop", "for", "match", "return", "break",
    "continue", "asm6502",
];

impl<'a> Parser<'a> {
    pub(crate) fn new(tokens: Vec<Token>, units: &'a [u16], file: &'a str) -> Self {
        let tokens = tokens
            .into_iter()
            .filter(|t| t.kind != TokenKind::Comment)
            .collect();
        Self {
            tokens,
            units,
            file,
            pos: 0,
            diagnostics: Vec::new(),
            no_brace: false,
            parens: HashSet::new(),
            nest: 0,
            too_deep: false,
            links: 0,
            expr_depth: 0,
            eof: 0,
        }
    }

    // ---- token access ----------------------------------------------------

    pub(crate) fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    pub(crate) fn peek_n(&self, n: usize) -> Option<&Token> {
        self.tokens.get(self.pos.saturating_add(n))
    }

    pub(crate) fn at_end(&self) -> bool {
        self.pos >= self.tokens.len()
    }

    /// Offset just past the last token.
    pub(crate) fn end_offset(&self) -> u32 {
        self.tokens.last().map_or(self.eof, tok_end)
    }

    /// End of the token just consumed.
    pub(crate) fn prev_end(&self) -> u32 {
        self.pos
            .checked_sub(1)
            .and_then(|i| self.tokens.get(i))
            .map_or(0, tok_end)
    }

    pub(crate) fn next(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.pos).cloned();
        if token.is_some() {
            self.pos += 1;
        }
        token
    }

    pub(crate) fn at(&self, text: &str) -> bool {
        self.peek().is_some_and(|t| is_op(t, text))
    }

    pub(crate) fn at_n(&self, n: usize, text: &str) -> bool {
        self.peek_n(n).is_some_and(|t| is_op(t, text))
    }

    pub(crate) fn at_kw(&self, word: &str) -> bool {
        self.peek()
            .is_some_and(|t| t.kind == TokenKind::Keyword && t.text == word)
    }

    pub(crate) fn eat(&mut self, text: &str) -> bool {
        if self.at(text) {
            self.pos += 1;
            return true;
        }
        false
    }

    fn describe(token: Option<&Token>) -> String {
        token.map_or_else(|| "end of file".to_string(), |t| format!("'{}'", t.text))
    }

    // ---- diagnostics -----------------------------------------------------

    pub(crate) fn error_at(&mut self, message: impl Into<String>, start: u32, length: u32) {
        if self.too_deep {
            return;
        }
        self.diagnostics.push(diagnostic(
            codes::SYNTAX_ERROR,
            message,
            self.file,
            start,
            length,
            Severity::Error,
        ));
    }

    /// An error on the next token, or at the end of the file.
    pub(crate) fn error_here(&mut self, message: impl Into<String>) {
        let (start, length) = self
            .peek()
            .map_or((self.end_offset(), 0), |t| (t.start, t.length));
        self.error_at(message, start, length);
    }

    pub(crate) fn error_on(&mut self, message: impl Into<String>, token: &Token) {
        self.error_at(message, token.start, token.length);
    }

    /// `expected <what>, found <next token>`.
    pub(crate) fn error_found(&mut self, what: &str) {
        let message = format!("expected {what}, found {}", Self::describe(self.peek()));
        self.error_here(message);
    }

    /// Consume `text` or record what was found instead.
    pub(crate) fn expect(&mut self, text: &str) -> Option<Token> {
        if self.at(text) {
            return self.next();
        }
        self.error_found(&format!("'{text}'"));
        None
    }

    pub(crate) fn expect_identifier(&mut self, what: &str) -> Option<Node> {
        if self.peek().is_some_and(|t| t.kind == TokenKind::Identifier) {
            let token = self.next()?;
            return Some(ident_node(&token));
        }
        self.error_found(what);
        None
    }

    pub(crate) fn unexpected(&mut self) {
        let message = format!("unexpected {}", Self::describe(self.peek()));
        self.error_here(message);
        self.next();
    }

    /// Skip forward until something that can plausibly start a new
    /// statement: stops after `;` or `}`, or before a statement keyword.
    pub(crate) fn synchronize(&mut self) {
        while let Some(token) = self.next() {
            if token.text == ";" || token.text == "}" {
                return;
            }
            if let Some(ahead) = self.peek() {
                let starts = ahead.kind == TokenKind::Keyword
                    && (STATEMENT_START.contains(&ahead.text.as_str()) || ahead.text == "pub");
                if starts || is_op(ahead, "#[") {
                    return;
                }
            }
        }
    }

    // ---- limits ----------------------------------------------------------

    /// Report that the file is too deep or too long once, then stop
    /// reporting and unwind.
    pub(crate) fn trip(&mut self, message: &str) {
        if !self.too_deep {
            self.error_here(message);
            self.too_deep = true;
        }
    }

    pub(crate) fn enter(&mut self) -> bool {
        if self.too_deep {
            return false;
        }
        if self.nest >= MAX_NEST {
            self.trip("this is nested too deeply to parse");
            return false;
        }
        self.nest += 1;
        true
    }

    pub(crate) fn leave(&mut self) {
        self.nest = self.nest.saturating_sub(1);
    }

    /// Count one link of an operator, call or index chain.
    pub(crate) fn link(&mut self) -> bool {
        if self.too_deep {
            return false;
        }
        self.links += 1;
        if self.links > MAX_LINKS {
            self.trip("this expression is too long to parse");
            return false;
        }
        true
    }

    // ---- text ------------------------------------------------------------

    /// `text.slice(start, end)` in UTF-16 code units.
    pub(crate) fn slice16(&self, start: u32, end: u32) -> String {
        self.units
            .get(start as usize..end as usize)
            .map(String::from_utf16_lossy)
            .unwrap_or_default()
    }

    // ---- program ---------------------------------------------------------

    fn parse_program(&mut self) -> Vec<Node> {
        let mut body = Vec::new();
        while !self.at_end() {
            let before = self.pos;
            if let Some(statement) = self.parse_statement(false) {
                body.push(statement);
            }
            // Guarantee forward progress: a rule that consumed nothing would spin.
            if self.pos == before {
                self.unexpected();
            }
        }
        body
    }
}

/// An `Identifier` node for an identifier token; `r#loop` is named `loop`.
pub(crate) fn ident_node(token: &Token) -> Node {
    Node::new(
        token.start,
        tok_end(token),
        NodeKind::Identifier {
            name: ident_name(&token.text),
            compile_time: None,
            imported: None,
        },
    )
}

pub(crate) fn ident_name(text: &str) -> String {
    text.strip_prefix("r#").unwrap_or(text).to_string()
}

/// `slice(1, -1)` of a string token's text.
pub(crate) fn strip_quotes(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    match chars.len() {
        0..=2 => String::new(),
        n => chars
            .get(1..n - 1)
            .map(|c| c.iter().collect())
            .unwrap_or_default(),
    }
}
