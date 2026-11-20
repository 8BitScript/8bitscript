//! `.8bx` elements (port spec P3-06; syntax spec 2.1). Ported from
//! `parser/index.mjs:244-435` and `:50-53`.
//!
//! Token-driven, over the lexer's tag, children and expression modes: every
//! span is a token's, so a diagnostic inside `{...}` points into the file.
//! The parser never fails on a half-typed tag; each step records what it
//! found and moves on. The tag grammar is unchanged by the new syntax.

use diagnostics::{Severity, codes, diagnostic};
use syntax::{Node, NodeKind, Token, TokenKind};

use crate::{Parser, node_end, tok_end};

/// Raw text between tags, the way spec 35 reads it: each line trimmed, blank
/// lines dropped, the rest joined with one space. Empty when nothing is
/// left; the caller makes no node of that (`normalizeBxText`,
/// `parser/index.mjs:50`). The trim is JS `String.prototype.trim`: the
/// characters `char::is_whitespace` strips, except U+0085 (NEL), which JS
/// keeps, plus the byte order mark.
#[must_use]
pub fn normalize_bx_text(raw: &str) -> String {
    raw.split('\n')
        .map(js_trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn js_trim(line: &str) -> &str {
    line.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// A dotted name and the span of its tokens (`parseBxName`).
struct BxName {
    name: String,
    start: u32,
    end: u32,
}

/// What `{ expression }` parsed to: the expression (none for an empty
/// field) and the span of the braces.
struct Braces {
    expression: Option<Node>,
    start: u32,
    end: u32,
}

/// The children of an element and the offset just past its closing tag.
struct Children {
    nodes: Vec<Node>,
    end: u32,
}

impl Parser<'_> {
    fn at_kind(&self, kind: TokenKind) -> bool {
        self.peek().is_some_and(|t| t.kind == kind)
    }

    /// The JS `at`: the token's text alone decides, whatever its kind.
    pub(crate) fn at_text(&self, text: &str) -> bool {
        self.peek().is_some_and(|t| t.text == text)
    }

    /// An error on `token`, or a zero-length one at the end of the file.
    /// Like `error_at`, it is muted once the shared nesting bound trips
    /// (`MAX_NEST`); the JS (`bxError`) has no such bound.
    fn bx_error(&mut self, message: impl Into<String>, token: Option<&Token>) {
        if self.too_deep {
            return;
        }
        let (start, length) = token.map_or((self.end_offset(), 0), |t| (t.start, t.length));
        self.diagnostics.push(diagnostic(
            codes::BX_SYNTAX,
            message,
            self.file,
            start,
            length,
            Severity::Error,
        ));
    }

    /// `bx_error` on the next token.
    fn bx_error_here(&mut self, message: impl Into<String>) {
        let token = self.peek().cloned();
        self.bx_error(message, token.as_ref());
    }

    /// `Foo` or `Foo.Bar` (spec 25): the dotted name as one string.
    fn parse_bx_name(&mut self, what: &str) -> Option<BxName> {
        let first = self.peek().cloned();
        let Some(first) = first.filter(|t| t.kind == TokenKind::Identifier) else {
            let found = Self::describe(self.peek());
            let token = self.peek().cloned();
            self.bx_error(format!("expected {what}, found {found}"), token.as_ref());
            return None;
        };
        self.next();
        let mut name = first.text.clone();
        let mut end = tok_end(&first);
        while self.at(".")
            && self
                .peek_n(1)
                .is_some_and(|t| t.kind == TokenKind::Identifier)
        {
            self.next();
            let Some(part) = self.next() else { break };
            name.push('.');
            name.push_str(&part.text);
            end = tok_end(&part);
        }
        Some(BxName {
            name,
            start: first.start,
            end,
        })
    }

    /// `{ expression }` in a tag or between tags. `{}` and `{ /* ... */ }`
    /// (the comment is already gone from the token stream) are an empty
    /// field: a child comment, which elaboration drops.
    fn parse_bx_braces(&mut self) -> Option<Braces> {
        let open = self.next()?; // `{`
        let mut expression = None;
        if !self.at_text("}") {
            expression = self.parse_expression();
        }
        let close = self.peek().cloned();
        if self.at_text("}") {
            self.next();
        } else {
            let found = Self::describe(close.as_ref());
            self.bx_error(
                format!("expected '}}' to close the expression, found {found}"),
                close.as_ref(),
            );
        }
        let end = match &close {
            Some(c) if c.text == "}" => tok_end(c),
            _ => expression.as_ref().map_or_else(|| tok_end(&open), node_end),
        };
        Some(Braces {
            expression,
            start: open.start,
            end,
        })
    }

    /// One element or fragment, from its `BxTagOpen` to its `/>` or closing
    /// tag. Text children are normalized here, once (spec 35).
    ///
    /// The shared nesting bound (`MAX_NEST`) applies here (R6.5); the JS has
    /// no limit, and past it the tag is skipped so the loop in
    /// `parse_bx_children` still makes progress.
    pub(crate) fn parse_bx_element(&mut self) -> Option<Node> {
        if !self.enter() {
            self.next();
            self.recover_bx_tag();
            return None;
        }
        let node = self.bx_element_inner();
        self.leave();
        node
    }

    fn bx_element_inner(&mut self) -> Option<Node> {
        let open = self.next()?; // BxTagOpen
        let start = open.start;

        // Fragment: `<>` ... `</>`.
        if self.at_kind(TokenKind::BxTagEnd) {
            self.next();
            let children = self.parse_bx_children(None);
            return Some(Node::new(
                start,
                children.end,
                NodeKind::BxFragment {
                    children: children.nodes,
                },
            ));
        }

        let Some(named) = self.parse_bx_name("a component name after <") else {
            self.recover_bx_tag();
            return None;
        };
        let name = named.name;

        let mut attributes: Vec<Node> = Vec::new();
        loop {
            let Some(t) = self.peek().cloned() else {
                self.bx_error_here(format!("unterminated <{name}>: expected '>' or '/>'"));
                let end = self.end_offset();
                return Some(Node::new(
                    start,
                    end,
                    NodeKind::BxElement {
                        name,
                        attributes,
                        children: Vec::new(),
                        self_closing: true,
                    },
                ));
            };
            if t.kind == TokenKind::BxSelfClose {
                self.next();
                return Some(Node::new(
                    start,
                    tok_end(&t),
                    NodeKind::BxElement {
                        name,
                        attributes,
                        children: Vec::new(),
                        self_closing: true,
                    },
                ));
            }
            if t.kind == TokenKind::BxTagEnd {
                self.next();
                let children = self.parse_bx_children(Some(&name));
                return Some(Node::new(
                    start,
                    children.end,
                    NodeKind::BxElement {
                        name,
                        attributes,
                        children: children.nodes,
                        self_closing: false,
                    },
                ));
            }
            if t.text == "{" {
                if let Some(spread) = self.parse_bx_braces() {
                    attributes.push(Node::new(
                        spread.start,
                        spread.end,
                        NodeKind::BxSpreadAttribute {
                            expression: spread.expression.map(Box::new),
                        },
                    ));
                }
                continue;
            }
            if t.kind == TokenKind::Identifier {
                self.next();
                attributes.push(self.parse_bx_attribute(&t));
                continue;
            }
            // The lexer reports a stray character in a tag; whatever token
            // came of it is skipped so the tag can still close.
            self.bx_error(
                format!("unexpected {} in <{name}>", Self::describe(Some(&t))),
                Some(&t),
            );
            self.next();
        }
    }

    /// An attribute whose name token `t` was just consumed: `name`,
    /// `name="text"` or `name={expression}`.
    fn parse_bx_attribute(&mut self, t: &Token) -> Node {
        let mut end = tok_end(t);
        let value = if self.at_text("=") {
            self.next();
            let v = self.peek().cloned();
            match v {
                Some(v) if v.text == "{" => {
                    let braces = self.parse_bx_braces();
                    braces.and_then(|b| {
                        end = b.end;
                        b.expression
                    })
                }
                Some(v) if v.kind == TokenKind::String => {
                    self.next();
                    end = tok_end(&v);
                    // A string attribute is an ordinary string literal (spec 18).
                    Some(Node::new(
                        v.start,
                        end,
                        NodeKind::StringLiteral {
                            value: bx_string_value(&v),
                            unterminated: None,
                            raw: None,
                        },
                    ))
                }
                other => {
                    self.bx_error(
                        format!(
                            "expected a string or {{expression}} after {}=, found {}",
                            t.text,
                            Self::describe(other.as_ref())
                        ),
                        other.as_ref(),
                    );
                    None
                }
            }
        } else {
            // A bare attribute is `true` (spec 31).
            Some(Node::new(
                t.start,
                end,
                NodeKind::BooleanLiteral {
                    value: true,
                    raw: None,
                },
            ))
        };
        Node::new(
            t.start,
            end,
            NodeKind::BxAttribute {
                name: t.text.clone(),
                value: value.map(Box::new),
            },
        )
    }

    /// The children of an element (or fragment when `name` is none), up to
    /// and including its closing tag.
    fn parse_bx_children(&mut self, name: Option<&str>) -> Children {
        let mut nodes: Vec<Node> = Vec::new();
        loop {
            let Some(t) = self.peek().cloned() else {
                let message = name.map_or_else(
                    || "unclosed fragment: expected </>".to_string(),
                    |n| format!("unclosed element <{n}>: expected </{n}>"),
                );
                self.bx_error(message, None);
                return Children {
                    nodes,
                    end: self.end_offset(),
                };
            };
            match t.kind {
                TokenKind::BxClosingTagOpen => {
                    self.next();
                    let end = self.parse_bx_closing(name, &t);
                    return Children { nodes, end };
                }
                TokenKind::BxTagOpen => {
                    if let Some(child) = self.parse_bx_element() {
                        nodes.push(child);
                    }
                    continue;
                }
                TokenKind::BxText => {
                    self.next();
                    let value = normalize_bx_text(&t.text);
                    if !value.is_empty() {
                        nodes.push(Node::new(
                            t.start,
                            tok_end(&t),
                            NodeKind::BxText {
                                value,
                                raw: t.text.clone(),
                            },
                        ));
                    }
                    continue;
                }
                _ => {}
            }
            if t.text == "{" {
                if let Some(braces) = self.parse_bx_braces() {
                    nodes.push(Node::new(
                        braces.start,
                        braces.end,
                        NodeKind::BxExpressionChild {
                            expression: braces.expression.map(Box::new),
                        },
                    ));
                }
                continue;
            }
            // Something the lexer's children mode never produces; skip it
            // rather than spin.
            self.bx_error(
                format!("unexpected {} between tags", Self::describe(Some(&t))),
                Some(&t),
            );
            self.next();
        }
    }

    /// The rest of a closing tag after its `</` token `t`: the name (or
    /// nothing, for a fragment) and the `>`. Returns the offset just past it.
    fn parse_bx_closing(&mut self, name: Option<&str>, t: &Token) -> u32 {
        let close_start = t.start;
        let mut end = tok_end(t);
        match name {
            None => {
                if !self.at_kind(TokenKind::BxTagEnd) {
                    let found = Self::describe(self.peek());
                    self.bx_error_here(format!(
                        "expected </> to close the fragment, found {found}"
                    ));
                }
            }
            Some(expected) => {
                let closing = if self.at_kind(TokenKind::Identifier) {
                    self.parse_bx_name("a closing tag name")
                } else {
                    None
                };
                match closing {
                    None => {
                        let found = Self::describe(self.peek());
                        self.bx_error_here(format!("expected </{expected}>, found {found}"));
                    }
                    Some(closing) if closing.name != expected => {
                        self.diagnostics.push(diagnostic(
                            codes::BX_SYNTAX,
                            format!("expected </{expected}>, found </{}>", closing.name),
                            self.file,
                            closing.start,
                            closing.end.saturating_sub(closing.start),
                            Severity::Error,
                        ));
                    }
                    Some(_) => {}
                }
            }
        }
        if self.at_kind(TokenKind::BxTagEnd) {
            if let Some(gt) = self.next() {
                end = tok_end(&gt);
            }
        } else {
            let found = self.peek().cloned();
            self.bx_error(
                format!("expected '>' after </{}", name.unwrap_or("")),
                found.as_ref(),
            );
            end = close_start.saturating_add(t.length);
        }
        end
    }

    /// After a tag that could not be named: skip to its end so parsing
    /// resumes after it.
    fn recover_bx_tag(&mut self) {
        while let Some(t) = self.next() {
            if t.kind == TokenKind::BxSelfClose || t.kind == TokenKind::BxTagEnd {
                return;
            }
        }
    }
}

/// `v.text.slice(1, v.unterminated ? undefined : -1)`.
fn bx_string_value(v: &Token) -> String {
    let chars: Vec<char> = v.text.chars().collect();
    let stop = if v.unterminated == Some(true) {
        chars.len()
    } else {
        chars.len().saturating_sub(1)
    };
    chars
        .get(1..stop.max(1))
        .map(|c| c.iter().collect())
        .unwrap_or_default()
}
