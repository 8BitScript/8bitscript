//! The scanner: a port of `tokenize` and its `scan*` closures
//! (`lexer/index.mjs:196-650`) as methods on one cursor. The cursor `i` is a
//! byte index; every stored span goes through `u16s` so it is UTF-16 (R6.1).

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use syntax::{PartKind, TemplatePart, Token, TokenKind};

use crate::{
    BX_KEYWORDS, KEYWORDS, Lexed, MACRO_NAMES, RESERVED_WORDS, TYPE_NAMES, is_operand_token,
};

/// Operators, longest first, matched by maximal munch against this list only
/// (`lexer/index.mjs:70-76`). `++`, `--` and `?` are lexed so the parser's
/// recovery has a token; each carries its E1/E2 diagnostic.
const OPERATORS: [&str; 39] = [
    "<<=", ">>=", "..=", "::", "->", "=>", "..", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>",
    "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "+", "-", "*", "/", "%", "&", "|",
    "^", "~", "!", "<", ">", "=", "?",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum ModeKind {
    Tag,
    Children,
    Expr,
}

/// One `.8bx` mode frame (`lexer/index.mjs:203-206`).
struct Mode {
    kind: ModeKind,
    offset: usize,
    closing: bool,
    depth: usize,
}

struct Bracket {
    ch: u8,
    offset: usize,
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

fn is_ident_part(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn is_scope_char(c: u8) -> bool {
    is_ident_part(c) || c == b'-'
}

fn is_digit_for(radix: u32, c: u8) -> bool {
    c == b'_'
        || match radix {
            2 => matches!(c, b'0' | b'1'),
            16 => c.is_ascii_hexdigit(),
            _ => c.is_ascii_digit(),
        }
}

fn closing_partner(c: u8) -> u8 {
    match c {
        b')' => b'(',
        b']' => b'[',
        _ => b'{',
    }
}

/// `Number.parseInt(digits, radix)` for digits already checked against the
/// radix: exact while it fits 128 bits, then an f64 accumulation.
fn parse_int(digits: &str, radix: u32) -> f64 {
    if radix == 10 {
        return digits.parse::<f64>().unwrap_or(f64::NAN);
    }
    let mut exact: u128 = 0;
    let mut approx = 0.0_f64;
    let mut overflow = false;
    for d in digits.chars().filter_map(|c| c.to_digit(radix)) {
        if overflow {
            approx = approx * f64::from(radix) + f64::from(d);
        } else if let Some(v) = exact
            .checked_mul(u128::from(radix))
            .and_then(|v| v.checked_add(u128::from(d)))
        {
            exact = v;
        } else {
            overflow = true;
            approx = exact as f64 * f64::from(radix) + f64::from(d);
        }
    }
    if overflow { approx } else { exact as f64 }
}

/// `Number.parseFloat` of a number token's source: the longest
/// `digits[.digits]` prefix, so an `_` ends it (`1_0.5` reads as 1).
fn parse_float_prefix(slice: &str) -> f64 {
    let b = slice.as_bytes();
    let mut end = 0;
    while b.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    if b.get(end) == Some(&b'.') && b.get(end + 1).is_some_and(u8::is_ascii_digit) {
        end += 1;
        while b.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
    }
    slice
        .get(..end)
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(f64::NAN)
}

pub(crate) struct Lexer<'a> {
    text: &'a str,
    bytes: &'a [u8],
    file: &'a str,
    bx: bool,
    /// UTF-16 offset of every byte index (continuation bytes repeat their
    /// character's offset); one entry past the end.
    u16s: Vec<u32>,
    i: usize,
    tokens: Vec<Token>,
    diagnostics: Vec<Diagnostic>,
    brackets: Vec<Bracket>,
    modes: Vec<Mode>,
}

impl<'a> Lexer<'a> {
    pub(crate) fn new(text: &'a str, file: &'a str, bx: bool) -> Self {
        let mut u16s = Vec::with_capacity(text.len() + 1);
        let mut cur: u32 = 0;
        for ch in text.chars() {
            for _ in 0..ch.len_utf8() {
                u16s.push(cur);
            }
            cur = cur.saturating_add(ch.len_utf16() as u32);
        }
        u16s.push(cur);
        Self {
            text,
            bytes: text.as_bytes(),
            file,
            bx,
            u16s,
            i: 0,
            tokens: Vec::new(),
            diagnostics: Vec::new(),
            brackets: Vec::new(),
            modes: Vec::new(),
        }
    }

    // ---- cursor helpers ------------------------------------------------

    fn at(&self, k: usize) -> u8 {
        self.bytes.get(k).copied().unwrap_or(0)
    }

    fn len(&self) -> usize {
        self.bytes.len()
    }

    /// UTF-16 offset of a byte index.
    fn u(&self, k: usize) -> u32 {
        self.u16s
            .get(k)
            .or_else(|| self.u16s.last())
            .copied()
            .unwrap_or(0)
    }

    fn slice(&self, start: usize, end: usize) -> &'a str {
        self.text.get(start..end).unwrap_or("")
    }

    /// Byte length of the character at `k` (1 when `k` is not a boundary).
    fn char_len(&self, k: usize) -> usize {
        self.text
            .get(k..)
            .and_then(|s| s.chars().next())
            .map_or(1, char::len_utf8)
    }

    fn starts_with(&self, k: usize, pat: &str) -> bool {
        self.bytes
            .get(k..)
            .is_some_and(|rest| rest.starts_with(pat.as_bytes()))
    }

    fn mode(&self) -> Option<ModeKind> {
        self.modes.last().map(|m| m.kind)
    }

    fn push(&mut self, kind: TokenKind, start: usize, end: usize) {
        self.push_with(kind, start, end, |_| {});
    }

    fn push_with(
        &mut self,
        kind: TokenKind,
        start: usize,
        end: usize,
        extra: impl FnOnce(&mut Token),
    ) {
        let (s, e) = (self.u(start), self.u(end));
        let mut token = Token {
            kind,
            start: s,
            length: e.saturating_sub(s),
            text: self.slice(start, end).to_string(),
            unterminated: None,
            parts: None,
            value: None,
            radix: None,
            is_decimal: None,
            numerator: None,
            denominator: None,
            control_header: None,
        };
        extra(&mut token);
        self.tokens.push(token);
    }

    fn report(&mut self, code: &str, message: String, start: usize, end: usize) {
        let (s, e) = (self.u(start), self.u(end));
        self.diagnostics.push(diagnostic(
            code,
            message,
            self.file,
            s,
            e.saturating_sub(s),
            Severity::Error,
        ));
    }

    /// Previous non-comment token (`lastSignificant`).
    fn last_significant(&self) -> Option<&Token> {
        self.tokens
            .iter()
            .rev()
            .find(|t| t.kind != TokenKind::Comment)
    }

    // ---- main loop -----------------------------------------------------

    pub(crate) fn run(mut self) -> Lexed {
        while self.i < self.len() {
            let c = self.at(self.i);
            // Raw text keeps its whitespace; every other mode skips it.
            if self.mode() == Some(ModeKind::Children) {
                self.scan_children();
            } else if matches!(c, b' ' | b'\t' | b'\r' | b'\n') {
                self.i += 1;
            } else if self.mode() == Some(ModeKind::Tag) {
                self.scan_in_tag();
            } else if self.starts_tag() {
                self.scan_tag_open();
            } else if !(self.dispatch(c) || self.scan_operator() || self.scan_punctuation(c)) {
                self.unexpected_character();
            }
        }
        let open: Vec<(u8, usize)> = self.brackets.iter().map(|b| (b.ch, b.offset)).collect();
        for (ch, offset) in open {
            self.report(
                codes::UNCLOSED_BRACKET,
                format!("unclosed '{}'", char::from(ch)),
                offset,
                offset + 1,
            );
        }
        // A tag or a run of children still open at the end: one diagnostic
        // per frame, at the `<` that opened it.
        let frames: Vec<(ModeKind, usize)> =
            self.modes.iter().map(|m| (m.kind, m.offset)).collect();
        for (kind, offset) in frames {
            if kind == ModeKind::Expr {
                continue; // its `{` is in `brackets` already
            }
            let message = if kind == ModeKind::Tag {
                "unterminated tag"
            } else {
                "unclosed element"
            };
            self.report(codes::BX_SYNTAX, message.to_string(), offset, offset + 1);
        }
        Lexed {
            tokens: self.tokens,
            diagnostics: self.diagnostics,
        }
    }

    /// What starts at `c`, first match wins (`DISPATCH`, `lexer/index.mjs:632`).
    fn dispatch(&mut self, c: u8) -> bool {
        let n = self.at(self.i + 1);
        match c {
            b'/' if n == b'/' => self.scan_line_comment(),
            b'/' if n == b'*' => self.scan_block_comment(),
            b'"' | b'\'' => self.scan_string(c, false),
            b'`' => self.scan_template(),
            b'0'..=b'9' => self.scan_number(),
            b'$' if n.is_ascii_hexdigit() => self.scan_number(),
            b'#' if n == b'[' => self.scan_attribute_open(2),
            b'#' if n == b'!' && self.at(self.i + 2) == b'[' => self.scan_attribute_open(3),
            b'#' if is_ident_start(n) => self.scan_sigil_word(),
            b'@' if is_scope_char(n) && self.after_use() => self.scan_scope(),
            b'r' if n == b'#' && is_ident_start(self.at(self.i + 2)) => self.scan_raw_identifier(),
            _ if is_ident_start(c) => self.scan_identifier(),
            b'(' | b'[' | b'{' => self.scan_open_bracket(),
            b')' | b']' | b'}' => self.scan_close_bracket(),
            _ => return false,
        }
        true
    }

    fn unexpected_character(&mut self) {
        let start = self.i;
        let ch = self.text.get(start..).and_then(|s| s.chars().next());
        let width = ch.map_or(1, char::len_utf8);
        let shown = ch.map_or_else(|| "?".to_string(), String::from);
        self.report(
            codes::UNEXPECTED_CHARACTER,
            format!("unexpected character '{shown}'"),
            start,
            start + width,
        );
        self.i += width;
    }

    fn after_use(&self) -> bool {
        self.last_significant()
            .is_some_and(|t| t.kind == TokenKind::Keyword && t.text == "use")
    }

    // ---- comments ------------------------------------------------------

    fn scan_line_comment(&mut self) {
        let start = self.i;
        while self.i < self.len() && self.at(self.i) != b'\n' {
            self.i += 1;
        }
        self.push(TokenKind::Comment, start, self.i);
    }

    fn scan_block_comment(&mut self) {
        let start = self.i;
        self.i += 2;
        while self.i < self.len() && !(self.at(self.i) == b'*' && self.at(self.i + 1) == b'/') {
            self.i += 1;
        }
        if self.i >= self.len() {
            let end = self.len();
            self.report(
                codes::UNTERMINATED_BLOCK_COMMENT,
                "unterminated block comment".to_string(),
                start,
                end,
            );
            self.push(TokenKind::Comment, start, end);
            self.i = end;
            return;
        }
        self.i += 2;
        self.push(TokenKind::Comment, start, self.i);
    }

    // ---- strings and templates -----------------------------------------

    /// A source newline always ends a string or template, even after `\`.
    fn skip_string_escape(&mut self) -> bool {
        if self.at(self.i) == b'\\' && self.i + 1 < self.len() && self.at(self.i + 1) != b'\n' {
            self.i += 1 + self.char_len(self.i + 1);
            return true;
        }
        false
    }

    /// Skips one quoted run starting at `j`, stopping at the closing quote, a
    /// newline or the end (`skipQuoted`, `lexer/index.mjs:120`).
    fn skip_quoted(&self, j: usize) -> usize {
        let quote = self.at(j);
        let mut k = j + 1;
        while k < self.len() && self.at(k) != b'\n' {
            if self.at(k) == b'\\' && k + 1 < self.len() && self.at(k + 1) != b'\n' {
                k += 1 + self.char_len(k + 1);
                continue;
            }
            if self.at(k) == quote {
                k += 1;
                break;
            }
            k += 1;
        }
        k
    }

    /// `"` strings. A `'` run is E5 outside a `.8bx` tag (`in_tag`): it is
    /// still one `string` token, so the parser does not cascade.
    fn scan_string(&mut self, quote: u8, in_tag: bool) {
        let start = self.i;
        self.i += 1;
        let mut closed = false;
        while self.i < self.len() {
            if self.skip_string_escape() {
                continue;
            }
            let c = self.at(self.i);
            if c == quote {
                self.i += 1;
                closed = true;
                break;
            }
            if c == b'\n' {
                break;
            }
            self.i += 1;
        }
        let end = self.i;
        if quote == b'\'' && !in_tag {
            self.report(
                codes::SYNTAX_ERROR,
                "8BitScript has no char type; write \"A\" for text or 65 for a number".to_string(),
                start,
                end,
            );
        } else if !closed {
            self.report(
                codes::UNTERMINATED_STRING,
                "unterminated string literal".to_string(),
                start,
                end,
            );
        }
        self.push_with(TokenKind::String, start, end, |t| {
            if !closed {
                t.unterminated = Some(true);
            }
        });
    }

    /// The inside of one `${ ... }` field. Only `"` quotes hide braces, as
    /// the field holds new syntax. Returns the unmatched depth.
    fn scan_template_field(&mut self) -> usize {
        let mut depth = 1;
        while self.i < self.len() && self.at(self.i) != b'\n' {
            match self.at(self.i) {
                b'"' => {
                    self.i = self.skip_quoted(self.i);
                    continue;
                }
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            self.i += 1;
        }
        depth
    }

    fn flush_text(&self, parts: &mut Vec<TemplatePart>, text_start: usize, end: usize) {
        if end > text_start {
            parts.push(TemplatePart {
                kind: PartKind::Text,
                start: self.u(text_start),
                end: self.u(end),
                source_start: None,
                source_end: None,
            });
        }
    }

    fn scan_template(&mut self) {
        let start = self.i;
        self.i += 1;
        let mut parts = Vec::new();
        let mut text_start = self.i;
        let mut closed = false;
        while self.i < self.len() {
            if self.skip_string_escape() {
                continue;
            }
            let c = self.at(self.i);
            if c == b'`' {
                self.flush_text(&mut parts, text_start, self.i);
                self.i += 1;
                closed = true;
                break;
            }
            if c == b'\n' {
                break;
            }
            if c == b'$' && self.at(self.i + 1) == b'{' {
                self.flush_text(&mut parts, text_start, self.i);
                let field_start = self.i;
                self.i += 2;
                let source_start = self.i;
                let depth = self.scan_template_field();
                if depth != 0 {
                    self.report(
                        codes::UNTERMINATED_STRING,
                        "unterminated '${' field in template string".to_string(),
                        field_start,
                        self.i,
                    );
                    // Recorded anyway: a field being typed has no `}` yet.
                    parts.push(self.field_part(field_start, self.i, source_start, self.i));
                    closed = true; // one diagnostic, not this plus "unterminated template"
                    break;
                }
                parts.push(self.field_part(field_start, self.i + 1, source_start, self.i));
                self.i += 1;
                text_start = self.i;
                continue;
            }
            self.i += 1;
        }
        if !closed {
            self.report(
                codes::UNTERMINATED_STRING,
                "unterminated template string".to_string(),
                start,
                self.i,
            );
        }
        self.push_with(TokenKind::Template, start, self.i, |t| {
            t.parts = Some(parts)
        });
    }

    fn field_part(
        &self,
        start: usize,
        end: usize,
        source_start: usize,
        source_end: usize,
    ) -> TemplatePart {
        TemplatePart {
            kind: PartKind::Field,
            start: self.u(start),
            end: self.u(end),
            source_start: Some(self.u(source_start)),
            source_end: Some(self.u(source_end)),
        }
    }

    // ---- numbers -------------------------------------------------------

    /// `$FF`, `0xFF`, `0b1010`, decimals and `1.5`. `%` never starts a
    /// number in the new syntax: it is only modulo.
    fn scan_number(&mut self) {
        let c = self.at(self.i);
        let start = self.i;
        let mut radix: u32 = 10;
        if c == b'$' {
            radix = 16;
            self.i += 1;
        } else if c == b'0' && matches!(self.at(self.i + 1), b'x' | b'X') {
            radix = 16;
            self.i += 2;
        } else if c == b'0' && matches!(self.at(self.i + 1), b'b' | b'B') {
            radix = 2;
            self.i += 2;
        }
        let digits_start = self.i;
        while self.i < self.len() && is_digit_for(radix, self.at(self.i)) {
            self.i += 1;
        }
        let digits = self.slice(digits_start, self.i).replace('_', "");
        if digits.is_empty() {
            let shown = self.slice(start, self.i);
            self.report(
                codes::INVALID_NUMBER,
                format!("invalid number literal '{shown}'"),
                start,
                self.i,
            );
            self.push_with(TokenKind::Number, start, self.i, |t| {
                t.value = Some(0.0);
                t.radix = Some(radix);
            });
            return;
        }
        // A decimal fraction needs a digit after the `.`: a bare `1.` stays
        // `1` then `.`, and `0..5` is a range.
        if radix == 10 && self.at(self.i) == b'.' && self.at(self.i + 1).is_ascii_digit() {
            self.i += 1;
            let frac_start = self.i;
            while self.i < self.len() && is_digit_for(radix, self.at(self.i)) {
                self.i += 1;
            }
            let frac = self.slice(frac_start, self.i).replace('_', "");
            let value = parse_float_prefix(self.slice(start, self.i));
            let numerator = parse_int(&format!("{digits}{frac}"), 10);
            let denominator = 10.0_f64.powf(frac.len() as f64);
            self.push_with(TokenKind::Number, start, self.i, |t| {
                t.value = Some(value);
                t.radix = Some(radix);
                t.is_decimal = Some(true);
                t.numerator = Some(numerator);
                t.denominator = Some(denominator);
            });
            return;
        }
        let value = parse_int(&digits, radix);
        self.push_with(TokenKind::Number, start, self.i, |t| {
            t.value = Some(value);
            t.radix = Some(radix);
        });
    }

    // ---- sigils, words, asm --------------------------------------------

    /// `#frames`: one token, no space between the `#` and the name.
    fn scan_sigil_word(&mut self) {
        let start = self.i;
        self.i += 1;
        while is_ident_part(self.at(self.i)) {
            self.i += 1;
        }
        self.push(TokenKind::CompileTime, start, self.i);
    }

    /// `#[` (and `#![`, so the parser can answer E18) is one punctuation
    /// token that opens a `[` bracket.
    fn scan_attribute_open(&mut self, width: usize) {
        self.brackets.push(Bracket {
            ch: b'[',
            offset: self.i + width - 1,
        });
        self.push(TokenKind::Punctuation, self.i, self.i + width);
        self.i += width;
    }

    /// `@scope` right after `use`.
    fn scan_scope(&mut self) {
        let start = self.i;
        self.i += 1;
        while is_scope_char(self.at(self.i)) {
            self.i += 1;
        }
        self.push(TokenKind::Scope, start, self.i);
    }

    /// `r#name`: always an identifier; the parser strips the `r#`.
    fn scan_raw_identifier(&mut self) {
        let start = self.i;
        self.i += 2;
        while is_ident_part(self.at(self.i)) {
            self.i += 1;
        }
        self.push(TokenKind::Identifier, start, self.i);
    }

    fn scan_identifier(&mut self) {
        let start = self.i;
        while is_ident_part(self.at(self.i)) {
            self.i += 1;
        }
        let word = self.slice(start, self.i);
        if word == "_" {
            self.push(TokenKind::Punctuation, start, self.i);
            return;
        }
        // `assert!(`, but not `assert != x` written without a space.
        if self.at(self.i) == b'!' && self.at(self.i + 1) != b'=' && MACRO_NAMES.contains(&word) {
            self.i += 1;
            self.push(TokenKind::Macro, start, self.i);
            return;
        }
        // `component` and `state` are keywords in `.8bx` only.
        let kind = if KEYWORDS.contains(&word)
            || RESERVED_WORDS.contains(&word)
            || (self.bx && BX_KEYWORDS.contains(&word))
        {
            TokenKind::Keyword
        } else if TYPE_NAMES.contains(&word) {
            TokenKind::Type
        } else {
            TokenKind::Identifier
        };
        self.push(kind, start, self.i);
        if word == "asm6502" {
            self.scan_asm_block_if_present();
        }
    }

    /// End of an `asm6502 { ... }` body. `{` and `}` inside `;` comments or
    /// quotes (either kind: 6502 assembly has `'A'`) do not count.
    fn scan_asm_block(&self, open_brace: usize) -> (usize, i64) {
        let mut j = open_brace;
        let mut depth: i64 = 0;
        while j < self.len() {
            match self.at(j) {
                b';' => {
                    while j < self.len() && self.at(j) != b'\n' {
                        j += 1;
                    }
                }
                b'"' | b'\'' => j = self.skip_quoted(j),
                b'{' => {
                    depth += 1;
                    j += 1;
                }
                b'}' => {
                    depth -= 1;
                    j += 1;
                    if depth == 0 {
                        return (j, 0);
                    }
                }
                _ => j += 1,
            }
        }
        (j, depth)
    }

    fn scan_asm_block_if_present(&mut self) {
        let mut j = self.i;
        while matches!(self.at(j), b' ' | b'\t' | b'\r' | b'\n') {
            j += 1;
        }
        if self.at(j) != b'{' {
            return;
        }
        let (end, depth) = self.scan_asm_block(j);
        if depth != 0 {
            self.report(
                codes::UNTERMINATED_ASM_BLOCK,
                "unterminated asm6502 block".to_string(),
                j,
                self.len(),
            );
        }
        self.push(TokenKind::AsmBlock, j, end);
        self.i = end;
    }

    // ---- brackets, operators, punctuation --------------------------------

    fn scan_open_bracket(&mut self) {
        self.brackets.push(Bracket {
            ch: self.at(self.i),
            offset: self.i,
        });
        self.push(TokenKind::Punctuation, self.i, self.i + 1);
        self.i += 1;
    }

    fn scan_close_bracket(&mut self) {
        let c = self.at(self.i);
        let top = self.brackets.pop();
        if top.as_ref().is_none_or(|t| t.ch != closing_partner(c)) {
            self.report(
                codes::UNMATCHED_BRACKET,
                format!("unmatched '{}'", char::from(c)),
                self.i,
                self.i + 1,
            );
            if let Some(top) = top {
                self.brackets.push(top);
            }
        }
        self.push(TokenKind::Punctuation, self.i, self.i + 1);
        self.i += 1;
        // The `}` that closes an attribute or child expression returns to
        // the tag or children it sits in.
        if c == b'}'
            && self.mode() == Some(ModeKind::Expr)
            && self
                .modes
                .last()
                .is_some_and(|m| m.depth == self.brackets.len())
        {
            self.modes.pop();
        }
    }

    /// Maximal munch against `OPERATORS` only.
    fn scan_operator(&mut self) -> bool {
        let start = self.i;
        let Some(op) = OPERATORS.iter().find(|op| self.starts_with(start, op)) else {
            return false;
        };
        let end = start + op.len();
        let message = match *op {
            "++" => Some("8BitScript has no '++'; write 'x += 1'"),
            "--" => Some("8BitScript has no '--'; write 'x -= 1'"),
            "?" => Some("write 'if c { a } else { b }' for a choice between two values"),
            _ => None,
        };
        if let Some(message) = message {
            self.report(codes::SYNTAX_ERROR, message.to_string(), start, end);
        }
        self.push(TokenKind::Operator, start, end);
        self.i = end;
        true
    }

    fn scan_punctuation(&mut self, c: u8) -> bool {
        if !matches!(c, b',' | b';' | b':' | b'.') {
            return false;
        }
        self.push(TokenKind::Punctuation, self.i, self.i + 1);
        self.i += 1;
        true
    }

    // ---- 8BX -----------------------------------------------------------

    /// `<` opens a tag when the grammar is on, what follows could start one,
    /// and no value sits before it (`startsTag`).
    fn starts_tag(&self) -> bool {
        if !self.bx || self.at(self.i) != b'<' {
            return false;
        }
        let next = self.at(self.i + 1);
        if next == b'<' || next == b'=' {
            return false;
        }
        if !(is_ident_start(next) || next == b'>' || next == b'/') {
            return false;
        }
        !is_operand_token(self.last_significant())
    }

    fn scan_tag_open(&mut self) {
        let closing = self.at(self.i + 1) == b'/';
        let start = self.i;
        let width = if closing { 2 } else { 1 };
        let kind = if closing {
            TokenKind::BxClosingTagOpen
        } else {
            TokenKind::BxTagOpen
        };
        self.push(kind, start, start + width);
        self.i += width;
        self.modes.push(Mode {
            kind: ModeKind::Tag,
            offset: start,
            closing,
            depth: 0,
        });
    }

    /// Opens `{ ... }` in a tag or in children: an `expr` frame.
    fn open_expression(&mut self) {
        self.brackets.push(Bracket {
            ch: b'{',
            offset: self.i,
        });
        self.push(TokenKind::Punctuation, self.i, self.i + 1);
        self.i += 1;
        self.modes.push(Mode {
            kind: ModeKind::Expr,
            offset: self.i - 1,
            closing: false,
            depth: self.brackets.len() - 1,
        });
    }

    /// Inside `<Name a="x" b={expr} ...`: a name, `=`, a string, `{`, `/>`,
    /// `>`. Anything else is reported once and skipped.
    fn scan_in_tag(&mut self) {
        let c = self.at(self.i);
        if c == b'/' && self.at(self.i + 1) == b'>' {
            self.push(TokenKind::BxSelfClose, self.i, self.i + 2);
            self.i += 2;
            self.modes.pop();
        } else if c == b'>' {
            let frame = self.modes.pop();
            self.push(TokenKind::BxTagEnd, self.i, self.i + 1);
            self.i += 1;
            // An opening tag's `>` starts its children; a closing tag's ends them.
            if let Some(frame) = frame {
                if !frame.closing {
                    self.modes.push(Mode {
                        kind: ModeKind::Children,
                        offset: frame.offset,
                        closing: false,
                        depth: 0,
                    });
                } else if self.mode() == Some(ModeKind::Children) {
                    self.modes.pop();
                }
            }
        } else if c == b'{' {
            self.open_expression();
        } else if c == b'"' || c == b'\'' {
            self.scan_string(c, true);
        } else if c == b'=' {
            self.push(TokenKind::Operator, self.i, self.i + 1);
            self.i += 1;
        } else if c == b'.' {
            self.push(TokenKind::Punctuation, self.i, self.i + 1);
            self.i += 1;
        } else if is_ident_start(c) {
            let start = self.i;
            while is_ident_part(self.at(self.i)) {
                self.i += 1;
            }
            self.push(TokenKind::Identifier, start, self.i);
        } else {
            let start = self.i;
            let ch = self.text.get(start..).and_then(|s| s.chars().next());
            let width = ch.map_or(1, char::len_utf8);
            let shown = ch.map_or_else(|| "?".to_string(), String::from);
            self.report(
                codes::BX_SYNTAX,
                format!("unexpected '{shown}' inside a tag"),
                start,
                start + width,
            );
            self.i += width;
        }
    }

    fn tag_starts_at(&self, k: usize) -> bool {
        let n = self.at(k + 1);
        self.at(k) == b'<' && (n == b'/' || is_ident_start(n) || n == b'>')
    }

    /// Between tags: raw text as one token up to the next `<` or `{`.
    fn scan_children(&mut self) {
        let c = self.at(self.i);
        if c == b'<' && self.tag_starts_at(self.i) {
            self.scan_tag_open();
            return;
        }
        if c == b'{' {
            self.open_expression();
            return;
        }
        let start = self.i;
        self.i += 1;
        while self.i < self.len() && self.at(self.i) != b'{' && !self.tag_starts_at(self.i) {
            self.i += 1;
        }
        self.push(TokenKind::BxText, start, self.i);
    }
}
