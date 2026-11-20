//! Port of packages/compiler/src/resolver/index.mjs:1-451 (findUse, findImports, pathFormSpecifiers, withPathForm)

use indexmap::IndexSet;
use serde::{Deserialize, Serialize};
use syntax::{Token, TokenKind};

use crate::variants::Options;

/// The four token fields the scan reads. Tokens from other lexers carry other extras (a string
/// `value`), so the scan keeps its own view instead of `syntax::Token`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ScanToken {
    pub kind: TokenKind,
    pub start: u32,
    pub length: u32,
    pub text: String,
}

impl From<&Token> for ScanToken {
    fn from(t: &Token) -> Self {
        ScanToken {
            kind: t.kind,
            start: t.start,
            length: t.length,
            text: t.text.clone(),
        }
    }
}

/// One import the scan found: `{ specifier, start, length, pathForm? }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Import {
    pub specifier: String,
    pub start: u32,
    pub length: u32,
    /// Set for a path-form `use`, whose extension is searched for.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub path_form: bool,
}

fn is_word(tok: Option<&&ScanToken>, word: &str) -> bool {
    tok.is_some_and(|t| t.kind == TokenKind::Keyword && t.text == word)
}

fn stem(tok: &ScanToken) -> &str {
    tok.text.strip_prefix("r#").unwrap_or(&tok.text)
}

fn text_is(tok: Option<&&ScanToken>, text: &str) -> bool {
    tok.is_some_and(|t| t.text == text)
}

/// A string token's body, `None` when it is unterminated (shorter than two characters or no closing quote).
fn unquote(raw: &str) -> Option<&str> {
    let quote = raw.chars().next()?;
    if raw.chars().count() < 2 || !raw.ends_with(quote) {
        return None;
    }
    Some(&raw[quote.len_utf8()..raw.len() - quote.len_utf8()])
}

/// The module a `use` run names, as the specifier the resolver takes (`findUse`).
fn find_use(t: &[&ScanToken], i: usize) -> Option<Import> {
    let mut j = i + 1;
    let head = *t.get(j)?;
    if head.kind == TokenKind::String {
        if !text_is(t.get(j + 1), "::") {
            return None;
        }
        let specifier = unquote(&head.text)?;
        return Some(Import {
            specifier: specifier.to_string(),
            start: head.start,
            length: head.length,
            path_form: false,
        });
    }
    // `crate::` is E4 in the parser; the path after it still names a module.
    if head.kind == TokenKind::Keyword && head.text == "crate" && text_is(t.get(j + 1), "::") {
        j += 2;
    }
    let first = t.get(j).copied();
    let word = if is_word(first.as_ref(), "self") {
        ".".to_string()
    } else if is_word(first.as_ref(), "super") {
        "..".to_string()
    } else if let Some(f) = first
        && (f.kind == TokenKind::Scope || f.kind == TokenKind::Identifier)
    {
        stem(f).to_string()
    } else {
        return None;
    };
    let first = first?;
    let mut all_super = word == "..";
    let mut segments: Vec<(String, &ScanToken)> = vec![(word, first)];
    j += 1;
    while text_is(t.get(j), "::") && !text_is(t.get(j + 1), "{") {
        let next = t.get(j + 1);
        if all_super && is_word(next, "super") {
            segments.push(("..".to_string(), next.copied()?));
        } else if let Some(n) = next
            && n.kind == TokenKind::Identifier
        {
            all_super = false;
            segments.push((stem(n).to_string(), n));
        } else if is_word(next, "super") || is_word(next, "self") {
            return None;
        } else {
            break;
        }
        j += 2;
    }
    let braced = text_is(t.get(j), "::") && text_is(t.get(j + 1), "{");
    if !braced {
        if segments.len() < 2 {
            return None;
        }
        segments.pop();
    }
    if segments.iter().all(|(w, _)| w == "." || w == "..") {
        return None;
    }
    let last = segments.last()?.1;
    let specifier: Vec<&str> = segments.iter().map(|(w, _)| w.as_str()).collect();
    Some(Import {
        specifier: specifier.join("/"),
        path_form: true,
        start: first.start,
        length: last.start + last.length - first.start,
    })
}

/// `options` with `pathForm` set when the import is a path-form `use`.
#[must_use]
pub fn with_path_form(options: &Options, path_form: bool) -> Options {
    let mut out = options.clone();
    if path_form {
        out.path_form = true;
    }
    out
}

/// The specifiers `tokens` import with a path-form `use`.
#[must_use]
pub fn path_form_specifiers(tokens: &[ScanToken]) -> IndexSet<String> {
    find_imports(tokens)
        .into_iter()
        .filter(|i| i.path_form)
        .map(|i| i.specifier)
        .collect()
}

/// Every `import ... from "specifier"`, bare `import "specifier"`, and `use` run (see `find_use`).
#[must_use]
pub fn find_imports(tokens: &[ScanToken]) -> Vec<Import> {
    let t: Vec<&ScanToken> = tokens
        .iter()
        .filter(|tok| tok.kind != TokenKind::Comment)
        .collect();
    const STOP: [&str; 6] = ["let", "const", "function", "export", "import", "return"];
    let mut found = Vec::new();

    for i in 0..t.len() {
        if t[i].kind == TokenKind::Keyword && t[i].text == "use" {
            if let Some(used) = find_use(&t, i) {
                found.push(used);
            }
            continue;
        }
        if t[i].kind != TokenKind::Keyword || t[i].text != "import" {
            continue;
        }
        for j in i + 1..t.len() {
            let tok = t[j];
            if tok.text == ";" {
                break;
            }
            if tok.kind == TokenKind::Keyword && STOP.contains(&tok.text.as_str()) {
                break;
            }
            if tok.kind == TokenKind::String {
                let direct = j == i + 1;
                let via_from = t[i + 1..j].iter().any(|x| x.text == "from");
                if (direct || via_from)
                    && let Some(specifier) = unquote(&tok.text)
                {
                    found.push(Import {
                        specifier: specifier.to_string(),
                        start: tok.start,
                        length: tok.length,
                        path_form: false,
                    });
                }
                break;
            }
        }
    }
    found
}
