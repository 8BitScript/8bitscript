//! Port of `media/cursor.mjs:1-92`: the shared cursor over media tokens.
//! A missing token becomes a diagnostic and a dummy so the rest of the file
//! can still be read.

use crate::lexer::{MediaToken, MediaTokenKind};
use diagnostics::{Diagnostic, Severity, codes, diagnostic};

/// `{start, length}`: what JS reads off either a token or the dummy that
/// `spanOf` makes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: u32,
    pub length: u32,
}

/// `expect(...)`: `tok` is the token or the span dummy; `token` is the
/// token itself when one was eaten.
pub struct Expect<'a> {
    pub ok: bool,
    pub tok: Span,
    pub token: Option<&'a MediaToken>,
    pub diagnostics: Vec<Diagnostic>,
}

/// The cursor object `c` (the closures become methods of the same names).
/// `tokens` is the significant view: comments are filtered out.
pub struct Cursor<'a> {
    pub tokens: Vec<&'a MediaToken>,
    pub pos: usize,
    pub text: &'a str,
    text_len: u32,
    pub file: &'a str,
    pub source_kind: &'a str,
    pub syntax: &'static str,
    pub unknown: &'static str,
}

/// `cursor(tokens, text, file, sourceKind)`.
#[must_use]
pub fn cursor<'a>(
    tokens: &'a [MediaToken],
    text: &'a str,
    file: &'a str,
    source_kind: &'a str,
) -> Cursor<'a> {
    let significant = tokens
        .iter()
        .filter(|t| t.kind != MediaTokenKind::Comment)
        .collect();
    let audio = source_kind == ".8ba";
    Cursor {
        tokens: significant,
        pos: 0,
        text,
        text_len: jsnum::utf16_len(text) as u32,
        file,
        source_kind,
        syntax: if audio {
            codes::AUD_SYNTAX
        } else {
            codes::GFX_SYNTAX
        },
        unknown: if audio {
            codes::AUD_UNKNOWN_FIELD
        } else {
            codes::GFX_UNKNOWN_FIELD
        },
    }
}

impl<'a> Cursor<'a> {
    /// `at(n)`.
    #[must_use]
    pub fn at(&self, n: usize) -> Option<&'a MediaToken> {
        self.tokens.get(self.pos + n).copied()
    }

    /// `done()`.
    #[must_use]
    pub fn done(&self) -> bool {
        self.pos >= self.tokens.len()
    }

    /// `spanOf(tok)`.
    fn span_of(&self, tok: Option<&MediaToken>) -> Span {
        match tok {
            Some(t) => Span {
                start: t.start,
                length: t.length,
            },
            None => Span {
                start: self.text_len,
                length: 0,
            },
        }
    }

    /// `report(code, message, tok)`.
    #[must_use]
    pub fn report(
        &self,
        code: &str,
        message: impl Into<String>,
        tok: Option<&MediaToken>,
    ) -> Diagnostic {
        let s = self.span_of(tok);
        diagnostic(code, message, self.file, s.start, s.length, Severity::Error)
    }

    /// `eat(kind, textMatch)`.
    pub fn eat(
        &mut self,
        kind: Option<MediaTokenKind>,
        text_match: Option<&str>,
    ) -> Option<&'a MediaToken> {
        let tok = self.at(0)?;
        if let Some(k) = kind {
            if tok.kind != k {
                return None;
            }
        }
        if let Some(m) = text_match {
            if tok.text != m {
                return None;
            }
        }
        self.pos += 1;
        Some(tok)
    }

    /// `expect(kind, textMatch, what)`.
    pub fn expect(
        &mut self,
        kind: Option<MediaTokenKind>,
        text_match: Option<&str>,
        what: &str,
    ) -> Expect<'a> {
        if let Some(tok) = self.eat(kind, text_match) {
            return Expect {
                ok: true,
                tok: self.span_of(Some(tok)),
                token: Some(tok),
                diagnostics: Vec::new(),
            };
        }
        let at = self.at(0);
        Expect {
            ok: false,
            tok: self.span_of(at),
            token: None,
            diagnostics: vec![self.report(self.syntax, format!("expected {what}"), at)],
        }
    }

    /// `skipTo(texts)`.
    pub fn skip_to(&mut self, texts: &[&str]) {
        while let Some(tok) = self.at(0) {
            if texts.contains(&tok.text.as_str()) {
                break;
            }
            self.pos += 1;
        }
    }
}

/// `parseName(c)` result.
pub struct Name {
    pub name: String,
    pub start: u32,
    pub length: u32,
    pub diagnostics: Vec<Diagnostic>,
}

/// `parseName(c)`.
pub fn parse_name(c: &mut Cursor) -> Name {
    match c.eat(Some(MediaTokenKind::Identifier), None) {
        None => {
            let at = c.at(0);
            Name {
                name: String::new(),
                start: at.map_or(0, |t| t.start),
                length: 0,
                diagnostics: vec![c.report(c.syntax, "expected a name", at)],
            }
        }
        Some(tok) => Name {
            name: tok.text.clone(),
            start: tok.start,
            length: tok.length,
            diagnostics: Vec::new(),
        },
    }
}

/// `parseString(c, what)` result.
pub struct Str {
    pub value: String,
    pub start: u32,
    pub length: u32,
    pub diagnostics: Vec<Diagnostic>,
}

/// `parseString(c, what)`.
pub fn parse_string(c: &mut Cursor, what: &str) -> Str {
    match c.eat(Some(MediaTokenKind::String), None) {
        None => Str {
            value: String::new(),
            start: 0,
            length: 0,
            diagnostics: vec![c.report(c.syntax, format!("expected {what} as a string"), c.at(0))],
        },
        Some(tok) => Str {
            value: tok.string_value().to_string(),
            start: tok.start,
            length: tok.length,
            diagnostics: Vec::new(),
        },
    }
}

/// `parseNumber(c, what)` result.
pub struct Num {
    pub value: f64,
    pub start: u32,
    pub length: u32,
    pub diagnostics: Vec<Diagnostic>,
}

/// `parseNumber(c, what)`.
pub fn parse_number(c: &mut Cursor, what: &str) -> Num {
    match c.eat(Some(MediaTokenKind::Number), None) {
        None => Num {
            value: 0.0,
            start: 0,
            length: 0,
            diagnostics: vec![c.report(c.syntax, format!("expected {what} as a number"), c.at(0))],
        },
        Some(tok) => Num {
            value: tok.number_value(),
            start: tok.start,
            length: tok.length,
            diagnostics: Vec::new(),
        },
    }
}

/// What `parseBlock` needs from a body item: its `diagnostics` (an item
/// keeps them) and whether it is `{skip: true}`.
pub trait BlockItem {
    fn diagnostics(&self) -> &[Diagnostic];
    fn is_skip(&self) -> bool;
}

/// `parseBlock(c, parseBody)` result. `start`/`length` are absent when the
/// opening brace was missing.
pub struct Block<T> {
    pub body: Vec<T>,
    pub diagnostics: Vec<Diagnostic>,
    pub start: Option<u32>,
    pub length: Option<u32>,
}

/// `parseBlock(c, parseBody)`.
pub fn parse_block<'a, T: BlockItem>(
    c: &mut Cursor<'a>,
    mut parse_body: impl FnMut(&mut Cursor<'a>) -> T,
) -> Block<T> {
    let open = c.expect(Some(MediaTokenKind::Punctuation), Some("{"), "'{'");
    let mut diagnostics = open.diagnostics.clone();
    let mut body = Vec::new();
    if !open.ok {
        return Block {
            body,
            diagnostics,
            start: None,
            length: None,
        };
    }
    while c.at(0).is_some_and(|t| t.text != "}") {
        let item = parse_body(c);
        diagnostics.extend(item.diagnostics().iter().cloned());
        if item.is_skip() {
            continue;
        }
        body.push(item);
    }
    let close = c.expect(Some(MediaTokenKind::Punctuation), Some("}"), "'}'");
    diagnostics.extend(close.diagnostics.iter().cloned());
    Block {
        body,
        diagnostics,
        start: Some(open.tok.start),
        length: Some(close.tok.start + close.tok.length - open.tok.start),
    }
}
