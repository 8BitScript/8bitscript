//! Types (`parser/index.mjs:716-759`, syntax spec 6 `Type`).

use syntax::{Node, NodeKind, Token, TokenKind};

use crate::{Parser, ident_name, tok_end};

impl Parser<'_> {
    /// `u8`, `ptr<u8>`, `[u8; 16]`, `volatile<u8>`.
    pub(crate) fn parse_type(&mut self) -> Option<Node> {
        if !self.enter() {
            return None;
        }
        let result = self.type_inner();
        self.leave();
        result
    }

    fn type_inner(&mut self) -> Option<Node> {
        if self.at("[") {
            return self.parse_array_type();
        }
        let named = self
            .peek()
            .is_some_and(|t| matches!(t.kind, TokenKind::Type | TokenKind::Identifier));
        if !named {
            self.error_found("a type");
            return None;
        }
        let token = self.next()?;
        let mut end = tok_end(&token);
        let mut type_arguments = Vec::new();

        if self.at("<") {
            self.next();
            while !self.at_end() && !self.at_close_angle() {
                match self.type_argument() {
                    Some(arg) => type_arguments.push(arg),
                    None => break,
                }
                if !self.eat(",") {
                    break;
                }
            }
            if let Some(close) = self.expect_close_angle() {
                end = close;
            }
        }
        Some(Node::new(
            token.start,
            end,
            NodeKind::TypeReference {
                name: ident_name(&token.text),
                type_arguments,
            },
        ))
    }

    /// `[T; n]`: `TypeReference{name:'array', typeArguments:[T, n]}`.
    fn parse_array_type(&mut self) -> Option<Node> {
        let open = self.next()?;
        let element = self.parse_type();
        self.expect(";");
        let length = self.type_argument();
        let close = self.expect("]");
        let end = close.map_or_else(|| self.prev_end(), |t| tok_end(&t));
        let type_arguments = element.into_iter().chain(length).collect();
        Some(Node::new(
            open.start,
            end,
            NodeKind::TypeReference {
                name: "array".to_string(),
                type_arguments,
            },
        ))
    }

    /// An array length is a value, not a type: `array<u8, 16>`. A decimal
    /// literal is never a valid length and falls through to `parse_type`,
    /// which reports a plain "expected a type".
    fn type_argument(&mut self) -> Option<Node> {
        let integer = self
            .peek()
            .is_some_and(|t| t.kind == TokenKind::Number && t.is_decimal != Some(true));
        if integer {
            let token = self.next()?;
            return Some(integer_node(&token));
        }
        self.parse_type()
    }

    fn at_close_angle(&self) -> bool {
        self.at(">") || self.at(">>") || self.at(">=") || self.at(">>=")
    }

    /// Consume one `>`. A `>>` that closes two lists (or the `>` of `>=`,
    /// `>>=`) is split in place: the first character is consumed and the
    /// rest stays as the next token. Returns the end offset of the `>`.
    fn expect_close_angle(&mut self) -> Option<u32> {
        if self.at(">") {
            return self.next().map(|t| tok_end(&t));
        }
        if self.at_close_angle()
            && let Some(token) = self.tokens.get_mut(self.pos)
        {
            let end = token.start.saturating_add(1);
            token.text.remove(0);
            token.start = end;
            token.length = token.length.saturating_sub(1);
            return Some(end);
        }
        self.error_found("'>'");
        None
    }
}

/// An `IntegerLiteral` for a non-decimal number token.
pub(crate) fn integer_node(token: &Token) -> Node {
    Node::new(
        token.start,
        tok_end(token),
        NodeKind::IntegerLiteral {
            value: token.value.unwrap_or(0.0),
            raw: token.text.clone(),
            radix: token.radix.unwrap_or(10),
        },
    )
}

/// A `DecimalLiteral` or `IntegerLiteral` for a number token.
pub(crate) fn number_node(token: &Token) -> Node {
    if token.is_decimal == Some(true) {
        return Node::new(
            token.start,
            tok_end(token),
            NodeKind::DecimalLiteral {
                numerator: token.numerator.unwrap_or(0.0),
                denominator: token.denominator.unwrap_or(1.0),
                raw: token.text.clone(),
            },
        );
    }
    integer_node(token)
}
