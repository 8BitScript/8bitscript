//! Port of `media/lexer.mjs:1-119`: the scanner for `.8bg` and `.8ba`.
//! It never fails: half-typed media is the normal input. Every position is
//! a UTF-16 code-unit offset (R6.1), so the scan runs over code units.

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use serde::Serialize;

/// `MediaTokenKind`, serialized as the JS strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaTokenKind {
    Comment,
    String,
    Number,
    Identifier,
    Punctuation,
}

/// The `extra` key of a token: a string token's text, a number token's value.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum TokenValue {
    Number(f64),
    Text(String),
}

/// `{kind, text, start, length, ...extra}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MediaToken {
    pub kind: MediaTokenKind,
    pub text: String,
    pub start: u32,
    pub length: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<TokenValue>,
}

impl MediaToken {
    /// `tok.value` of a string token.
    #[must_use]
    pub fn string_value(&self) -> &str {
        match &self.value {
            Some(TokenValue::Text(s)) => s,
            _ => "",
        }
    }

    /// `tok.value` of a number token.
    #[must_use]
    pub fn number_value(&self) -> f64 {
        match &self.value {
            Some(TokenValue::Number(n)) => *n,
            _ => 0.0,
        }
    }
}

fn unexpected_code(source_kind: &str) -> &'static str {
    if source_kind == ".8ba" {
        codes::AUD_UNEXPECTED_CHARACTER
    } else {
        codes::GFX_UNEXPECTED_CHARACTER
    }
}

fn unterminated_code(source_kind: &str) -> &'static str {
    if source_kind == ".8ba" {
        codes::AUD_UNTERMINATED_STRING
    } else {
        codes::GFX_UNTERMINATED_STRING
    }
}

fn text_of(units: &[u16], start: usize, end: usize) -> String {
    String::from_utf16_lossy(&units[start..end])
}

fn is_ident_start(c: u16) -> bool {
    (u16::from(b'A')..=u16::from(b'Z')).contains(&c)
        || (u16::from(b'a')..=u16::from(b'z')).contains(&c)
        || c == u16::from(b'_')
}

fn is_digit(c: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'9')).contains(&c)
}

/// `raw.replace(/\\(["'\\])/g, '$1')`.
fn unescape(units: &[u16]) -> String {
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let c = units[i];
        if c == u16::from(b'\\')
            && i + 1 < units.len()
            && matches!(units[i + 1], 0x22 | 0x27 | 0x5c)
        {
            out.push(units[i + 1]);
            i += 2;
        } else {
            out.push(c);
            i += 1;
        }
    }
    String::from_utf16_lossy(&out)
}

/// `tokenizeMedia(text, file, { sourceKind })`; `source_kind` defaults to
/// `.8bg` in JS, pass it explicitly here.
///
/// A lone surrogate half cannot sit in a Rust `String`: in the message of an
/// "unexpected" diagnostic for a character outside the BMP it becomes U+FFFD.
#[must_use]
pub fn tokenize_media(
    text: &str,
    file: &str,
    source_kind: &str,
) -> (Vec<MediaToken>, Vec<Diagnostic>) {
    let units: Vec<u16> = text.encode_utf16().collect();
    let len = units.len();
    let mut tokens: Vec<MediaToken> = Vec::new();
    let mut diags: Vec<Diagnostic> = Vec::new();
    let mut i = 0usize;

    let at = |n: usize| -> Option<u16> { units.get(n).copied() };
    let mut push = |kind: MediaTokenKind, start: usize, end: usize, value: Option<TokenValue>| {
        tokens.push(MediaToken {
            kind,
            text: text_of(&units, start, end),
            start: start as u32,
            length: (end - start) as u32,
            value,
        });
    };

    while i < len {
        let c = units[i];
        if c == 0x20 || c == 0x09 || c == 0x0d || c == 0x0a {
            i += 1;
            continue;
        }
        if c == u16::from(b'/') && at(i + 1) == Some(u16::from(b'/')) {
            let start = i;
            i += 2;
            while i < len && units[i] != 0x0a {
                i += 1;
            }
            push(MediaTokenKind::Comment, start, i, None);
            continue;
        }
        if c == u16::from(b'/') && at(i + 1) == Some(u16::from(b'*')) {
            let start = i;
            i += 2;
            while i < len && !(units[i] == u16::from(b'*') && at(i + 1) == Some(u16::from(b'/'))) {
                i += 1;
            }
            if i < len {
                i += 2;
            }
            push(MediaTokenKind::Comment, start, i, None);
            continue;
        }
        if c == u16::from(b'"') || c == u16::from(b'\'') {
            let quote = c;
            let start = i;
            i += 1;
            while i < len && units[i] != quote && units[i] != 0x0a {
                if units[i] == u16::from(b'\\') && i + 1 < len {
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if i < len && units[i] == quote {
                i += 1;
                let raw = unescape(&units[start + 1..i - 1]);
                push(
                    MediaTokenKind::String,
                    start,
                    i,
                    Some(TokenValue::Text(raw)),
                );
            } else {
                diags.push(diagnostic(
                    unterminated_code(source_kind),
                    "unterminated string",
                    file,
                    start as u32,
                    (i - start) as u32,
                    Severity::Error,
                ));
                let raw = text_of(&units, start + 1, i);
                push(
                    MediaTokenKind::String,
                    start,
                    i,
                    Some(TokenValue::Text(raw)),
                );
            }
            continue;
        }
        if is_digit(c) {
            let start = i;
            while i < len && is_digit(units[i]) {
                i += 1;
            }
            let value = text_of(&units, start, i).parse::<f64>().unwrap_or(f64::NAN);
            push(
                MediaTokenKind::Number,
                start,
                i,
                Some(TokenValue::Number(value)),
            );
            continue;
        }
        if is_ident_start(c) {
            let start = i;
            i += 1;
            while i < len && (is_ident_start(units[i]) || is_digit(units[i])) {
                i += 1;
            }
            push(MediaTokenKind::Identifier, start, i, None);
            continue;
        }
        if matches!(c, 0x7b | 0x7d | 0x28 | 0x29 | 0x2c | 0x3b | 0x78 | 0x3d) {
            push(MediaTokenKind::Punctuation, i, i + 1, None);
            i += 1;
            continue;
        }
        let shown = char::from_u32(u32::from(c)).unwrap_or('\u{fffd}');
        diags.push(diagnostic(
            unexpected_code(source_kind),
            format!("unexpected '{shown}'"),
            file,
            i as u32,
            1,
            Severity::Error,
        ));
        i += 1;
    }

    (tokens, diags)
}
