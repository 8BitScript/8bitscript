//! Expressions (`parser/index.mjs:761-1100`, syntax spec 6 `Expr`) with the
//! new-syntax checks E6-E12.

use syntax::{Node, NodeKind, Token, TokenKind};
use lexer::Options;

use crate::types::{integer_node, number_node};
use crate::{Parser, ident_name, node_end, strip_quotes, tok_end};

const ASSIGNMENT_OPERATORS: [&str; 11] = [
    "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=",
];

const COMPARISONS: [&str; 6] = ["==", "!=", "<", ">", "<=", ">="];

/// Binary operator precedence, unchanged from the old syntax
/// (`parser/index.mjs:20-32`).
fn precedence(token: &Token) -> Option<u8> {
    if token.kind != TokenKind::Operator {
        return None;
    }
    Some(match token.text.as_str() {
        "||" => 1,
        "&&" => 2,
        "|" => 3,
        "^" => 4,
        "&" => 5,
        "==" | "!=" => 6,
        "<" | ">" | "<=" | ">=" => 7,
        "<<" | ">>" => 8,
        "+" | "-" => 9,
        "*" | "/" | "%" => 10,
        _ => return None,
    })
}

impl Parser<'_> {
    pub(crate) fn parse_expression(&mut self) -> Option<Node> {
        if !self.enter() {
            return None;
        }
        if self.expr_depth == 0 {
            self.links = 0;
        }
        self.expr_depth += 1;
        let result = self.parse_assignment();
        self.expr_depth -= 1;
        self.leave();
        result
    }

    /// An expression where a `{` opens a block, not a record.
    pub(crate) fn parse_expression_no_brace(&mut self) -> Option<Node> {
        let saved = std::mem::replace(&mut self.no_brace, true);
        let result = self.parse_expression();
        self.no_brace = saved;
        result
    }

    /// Run `f` with braces allowed again (inside parentheses, brackets and
    /// call arguments).
    pub(crate) fn with_braces<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> T {
        let saved = std::mem::replace(&mut self.no_brace, false);
        let result = f(self);
        self.no_brace = saved;
        result
    }

    fn parse_assignment(&mut self) -> Option<Node> {
        if self.at_kw("if") {
            return self.parse_if_expression();
        }
        let left = self.parse_conditional()?;
        let operator = self
            .peek()
            .filter(|t| {
                t.kind == TokenKind::Operator && ASSIGNMENT_OPERATORS.contains(&t.text.as_str())
            })
            .cloned();
        let Some(token) = operator else {
            return Some(left);
        };
        self.next();
        // Right-associative: `a = b = c` is `a = (b = c)`.
        let right = self.parse_expression();
        let end = right.as_ref().map_or_else(|| tok_end(&token), node_end);
        Some(Node::new(
            left.start,
            end,
            NodeKind::AssignmentExpression {
                operator: token.text,
                left: Box::new(left),
                right: right.map(Box::new),
            },
        ))
    }

    /// `if c { a } else { b }` in expression position: a
    /// `ConditionalExpression` (syntax spec 2).
    fn parse_if_expression(&mut self) -> Option<Node> {
        let start = self.next()?.start;
        let test = self.parse_expression_no_brace();
        let (consequent, _) = self.parse_braced_expression();
        let mut alternate = None;
        let mut end = self.prev_end();
        if self.at_kw("else") {
            self.next();
            if self.at_kw("if") {
                if self.enter() {
                    alternate = self.parse_if_expression();
                    self.leave();
                }
                if let Some(alt) = &alternate {
                    end = node_end(alt);
                }
            } else {
                let (expr, close) = self.parse_braced_expression();
                alternate = expr;
                end = close.unwrap_or(end);
            }
        } else {
            self.error_found("'else'");
        }
        let test = test?;
        Some(Node::new(
            start,
            end.max(node_end(&test)),
            NodeKind::ConditionalExpression {
                test: Box::new(test),
                consequent: consequent.map(Box::new),
                alternate: alternate.map(Box::new),
            },
        ))
    }

    /// `{ expr }`: the expression and the end of the closing brace.
    fn parse_braced_expression(&mut self) -> (Option<Node>, Option<u32>) {
        if !self.at("{") {
            self.error_found("'{'");
            return (None, None);
        }
        self.next();
        let expr = self.with_braces(Self::parse_expression);
        let close = self.expect("}");
        (expr, close.map(|t| tok_end(&t)))
    }

    /// `c ? a : b`: the lexer reported the `?` (E2); the parse recovers as
    /// the old syntax did (`parser/index.mjs:830-842`).
    fn parse_conditional(&mut self) -> Option<Node> {
        let start = self.peek().map_or(0, |t| t.start);
        let expr = self.parse_binary(0)?;
        if !self.at("?") {
            return Some(expr);
        }
        self.next();
        let consequent = self.parse_expression();
        self.expect(":");
        let alternate = if self.enter() {
            let alt = self.parse_conditional();
            self.leave();
            alt
        } else {
            None
        };
        let end = alternate
            .as_ref()
            .map_or_else(|| node_end(&expr), node_end);
        Some(Node::new(
            start,
            end,
            NodeKind::ConditionalExpression {
                test: Box::new(expr),
                consequent: consequent.map(Box::new),
                alternate: alternate.map(Box::new),
            },
        ))
    }

    /// Precedence climbing over the table above.
    pub(crate) fn parse_binary(&mut self, min: u8) -> Option<Node> {
        let mut left = self.parse_unary()?;
        loop {
            if self.at_kw("as") {
                self.reject_as();
                continue;
            }
            let Some(token) = self.peek().cloned() else {
                return Some(left);
            };
            let Some(level) = precedence(&token) else {
                return Some(left);
            };
            if level < min {
                return Some(left);
            }
            self.next();
            if !self.link() {
                return Some(left);
            }
            let Some(right) = self.parse_binary(level + 1) else {
                return Some(left);
            };
            self.check_operands(&token, &left, &right);
            left = Node::new(
                left.start,
                node_end(&right),
                NodeKind::BinaryExpression {
                    operator: token.text,
                    left: Box::new(left),
                    right: Box::new(right),
                },
            );
        }
    }

    /// E6: `x as T` outside `use`. The cast is dropped.
    fn reject_as(&mut self) {
        if let Some(token) = self.next() {
            self.error_on("write 'u8(x)' to convert a value", &token);
        }
        self.parse_type();
    }

    fn unparenthesized_comparison(&self, node: &Node) -> Option<String> {
        match &node.kind {
            NodeKind::BinaryExpression { operator, .. }
                if COMPARISONS.contains(&operator.as_str())
                    && !self.parens.contains(&(node.start, node.length)) =>
            {
                Some(operator.clone())
            }
            _ => None,
        }
    }

    /// E9 and E10: the two precedence traps of the old table.
    fn check_operands(&mut self, operator: &Token, left: &Node, right: &Node) {
        let left_cmp = self.unparenthesized_comparison(left);
        if matches!(operator.text.as_str(), "&" | "|" | "^") {
            if let Some(cmp) = left_cmp.or_else(|| self.unparenthesized_comparison(right)) {
                let message = format!(
                    "add parentheses: in 8BitScript '{}' binds looser than '{cmp}'",
                    operator.text
                );
                self.error_on(message, operator);
            }
        } else if COMPARISONS.contains(&operator.text.as_str()) && left_cmp.is_some() {
            self.error_on("add parentheses: comparisons do not chain", operator);
        }
    }

    fn parse_unary(&mut self) -> Option<Node> {
        if !self.enter() {
            return None;
        }
        let result = self.unary_inner();
        self.leave();
        result
    }

    fn unary_inner(&mut self) -> Option<Node> {
        let Some(token) = self.peek().cloned() else {
            return self.parse_postfix();
        };
        if token.kind == TokenKind::Operator {
            match token.text.as_str() {
                "!" | "~" | "-" | "+" => {
                    self.next();
                    let argument = self.parse_unary()?;
                    return Some(Node::new(
                        token.start,
                        node_end(&argument),
                        NodeKind::UnaryExpression {
                            operator: token.text,
                            argument: Box::new(argument),
                        },
                    ));
                }
                // Reported by the lexer (E1); recover as a prefix update.
                "++" | "--" => {
                    self.next();
                    let argument = self.parse_unary()?;
                    return Some(Node::new(
                        token.start,
                        node_end(&argument),
                        NodeKind::UpdateExpression {
                            operator: token.text,
                            argument: Box::new(argument),
                            prefix: true,
                        },
                    ));
                }
                // E7: no references. The operator is dropped.
                "&" | "*" => {
                    self.next();
                    self.error_on(
                        "8BitScript has no references; use memory::read and memory::write",
                        &token,
                    );
                    return self.parse_unary();
                }
                _ => {}
            }
        }
        self.parse_postfix()
    }

    fn parse_postfix(&mut self) -> Option<Node> {
        let mut expression = self.parse_primary()?;
        loop {
            let Some(token) = self.peek().cloned() else {
                return Some(expression);
            };
            if token.kind == TokenKind::Punctuation || token.kind == TokenKind::Operator {
                match token.text.as_str() {
                    "." | "::" => {
                        if !self.link() {
                            return Some(expression);
                        }
                        self.next();
                        let Some(property) = self.expect_identifier("a property name") else {
                            return Some(expression);
                        };
                        expression = Node::new(
                            expression.start,
                            node_end(&property),
                            NodeKind::MemberExpression {
                                object: Box::new(expression),
                                property: Box::new(property),
                            },
                        );
                        continue;
                    }
                    "[" => {
                        if !self.link() {
                            return Some(expression);
                        }
                        self.next();
                        let index = self.with_braces(Self::parse_expression);
                        let close = self.expect("]");
                        let end = close.map_or_else(|| node_end(&expression), |t| tok_end(&t));
                        expression = Node::new(
                            expression.start,
                            end,
                            NodeKind::IndexExpression {
                                object: Box::new(expression),
                                index: index.map(Box::new),
                            },
                        );
                        continue;
                    }
                    "(" => {
                        if !self.link() {
                            return Some(expression);
                        }
                        self.next();
                        let args = self.with_braces(Self::parse_arguments);
                        let close = self.expect(")");
                        let end = close.map_or_else(|| node_end(&expression), |t| tok_end(&t));
                        expression = Node::new(
                            expression.start,
                            end,
                            NodeKind::CallExpression {
                                callee: Box::new(expression),
                                args,
                            },
                        );
                        continue;
                    }
                    // Reported by the lexer (E1); recover as a postfix update.
                    "++" | "--" => {
                        if !self.link() {
                            return Some(expression);
                        }
                        self.next();
                        expression = Node::new(
                            expression.start,
                            tok_end(&token),
                            NodeKind::UpdateExpression {
                                operator: token.text,
                                argument: Box::new(expression),
                                prefix: false,
                            },
                        );
                        continue;
                    }
                    _ => {}
                }
            }
            return Some(expression);
        }
    }

    /// `expr {, expr} [,]` up to (not including) the closing `)`.
    fn parse_arguments(&mut self) -> Vec<Node> {
        let mut args = Vec::new();
        while !self.at_end() && !self.at(")") {
            let Some(argument) = self.parse_expression() else {
                break;
            };
            args.push(argument);
            if !self.eat(",") {
                break;
            }
        }
        args
    }

    fn parse_primary(&mut self) -> Option<Node> {
        let Some(token) = self.peek().cloned() else {
            self.error_here("expected an expression, found end of file");
            return None;
        };
        let end = tok_end(&token);
        match token.kind {
            TokenKind::Number => {
                self.next();
                Some(number_node(&token))
            }
            TokenKind::String => {
                self.next();
                Some(Node::new(
                    token.start,
                    end,
                    NodeKind::StringLiteral {
                        value: strip_quotes(&token.text),
                        // Already reported by the lexer; the checker leaves its text alone.
                        unterminated: (token.unterminated == Some(true)).then_some(true),
                    },
                ))
            }
            TokenKind::Template => {
                self.next();
                Some(self.parse_template(&token))
            }
            // A type name in expression position is a plain identifier.
            TokenKind::Identifier | TokenKind::Type => {
                self.next();
                Some(Node::new(
                    token.start,
                    end,
                    NodeKind::Identifier {
                        name: ident_name(&token.text),
                        compile_time: None,
                        imported: None,
                    },
                ))
            }
            // `#frames`: an identifier the compiler evaluates.
            TokenKind::CompileTime => {
                self.next();
                Some(Node::new(
                    token.start,
                    end,
                    NodeKind::Identifier {
                        name: token.text.strip_prefix('#').unwrap_or(&token.text).to_string(),
                        compile_time: Some(true),
                        imported: None,
                    },
                ))
            }
            // E12: a test macro is a call to a name with its `!`.
            TokenKind::Macro => {
                self.next();
                self.error_on("tests come with '8bs test'", &token);
                Some(Node::new(
                    token.start,
                    end,
                    NodeKind::Identifier {
                        name: token.text.clone(),
                        compile_time: None,
                        imported: None,
                    },
                ))
            }
            TokenKind::Keyword => self.parse_keyword_primary(&token),
            TokenKind::Punctuation => self.parse_punctuation_primary(&token),
            _ => {
                let message = format!("expected an expression, found '{}'", token.text);
                self.error_on(message, &token);
                None
            }
        }
    }

    fn parse_keyword_primary(&mut self, token: &Token) -> Option<Node> {
        let end = tok_end(token);
        match token.text.as_str() {
            "true" | "false" => {
                self.next();
                Some(Node::new(
                    token.start,
                    end,
                    NodeKind::BooleanLiteral {
                        value: token.text == "true",
                    },
                ))
            }
            // E11: `match` is a statement. Parsed for its own diagnostics.
            "match" => {
                self.parse_match(true);
                None
            }
            // E4: drop `crate::` and read the path that follows.
            "crate" => {
                self.next();
                self.error_on(
                    "'crate::' paths are not supported; use 'self::' or 'super::'",
                    token,
                );
                self.eat("::");
                self.parse_primary()
            }
            word => {
                if let Some(message) = crate::stmt::reserved_message(word) {
                    // E3 in expression position: one token, no value.
                    self.next();
                    self.error_on(message, token);
                    return None;
                }
                let message = format!("expected an expression, found '{}'", token.text);
                self.error_on(message, token);
                None
            }
        }
    }

    fn parse_punctuation_primary(&mut self, token: &Token) -> Option<Node> {
        let end = tok_end(token);
        match token.text.as_str() {
            "(" => {
                self.next();
                let inner = self.with_braces(Self::parse_expression);
                self.expect(")");
                if let Some(node) = &inner {
                    self.parens.insert((node.start, node.length));
                }
                inner
            }
            // `{ key: v }`: a compile-time record, never in a no-brace header.
            "{" if !self.no_brace => {
                self.next();
                let properties = self.with_braces(Self::parse_record_properties);
                let close = self.expect("}");
                let literal_end = close.map_or_else(
                    || properties.last().map_or(end, node_end),
                    |t| tok_end(&t),
                );
                Some(Node::new(
                    token.start,
                    literal_end,
                    NodeKind::RecordLiteral { properties },
                ))
            }
            "[" => {
                self.next();
                let elements = self.with_braces(Self::parse_elements);
                let close = self.expect("]");
                let literal_end = close.map_or_else(
                    || elements.last().map_or(end, node_end),
                    |t| tok_end(&t),
                );
                Some(Node::new(
                    token.start,
                    literal_end,
                    NodeKind::ArrayLiteral { elements },
                ))
            }
            _ => {
                let message = format!("expected an expression, found '{}'", token.text);
                self.error_on(message, token);
                None
            }
        }
    }

    fn parse_record_properties(&mut self) -> Vec<Node> {
        let mut properties = Vec::new();
        while !self.at_end() && !self.at("}") {
            let Some(key) = self.expect_identifier("a field name") else {
                break;
            };
            self.expect(":");
            let Some(value) = self.parse_expression() else {
                break;
            };
            let key_name = match &key.kind {
                NodeKind::Identifier { name, .. } => name.clone(),
                _ => String::new(),
            };
            properties.push(Node::new(
                key.start,
                node_end(&value),
                NodeKind::RecordProperty {
                    key: key_name,
                    value: Box::new(value),
                },
            ));
            if !self.eat(",") {
                break;
            }
        }
        properties
    }

    /// `[a, b, c]`; E8 answers `[x; n]`.
    fn parse_elements(&mut self) -> Vec<Node> {
        let mut elements = Vec::new();
        while !self.at_end() && !self.at("]") {
            let Some(element) = self.parse_expression() else {
                break;
            };
            elements.push(element);
            if self.at(";") {
                if let Some(semi) = self.next() {
                    self.error_on(
                        "an array literal lists its elements: [a, b, c]",
                        &semi,
                    );
                }
                self.parse_expression();
                break;
            }
            if !self.eat(",") {
                break;
            }
        }
        elements
    }

    /// `` `TICK ${ticks % 10:1}` ``: the lexer handed over one token with
    /// the spans of its text runs and `${...}` fields; each field's source
    /// is re-lexed (its offsets shifted back into the file, so a diagnostic
    /// inside a field lands on the right characters) and parsed as an
    /// ordinary expression followed by an optional `:width`.
    fn parse_template(&mut self, token: &Token) -> Node {
        let mut parts = Vec::new();
        for part in token.parts.clone().unwrap_or_default() {
            let (Some(source_start), Some(source_end)) = (part.source_start, part.source_end)
            else {
                parts.push(Node::new(
                    part.start,
                    part.end,
                    NodeKind::TemplateText {
                        value: self.slice16(part.start, part.end),
                    },
                ));
                continue;
            };
            if let Some(field) = self.parse_template_field(part.start, part.end, source_start, source_end) {
                parts.push(field);
            }
        }
        Node::new(token.start, tok_end(token), NodeKind::TemplateLiteral { parts })
    }

    fn parse_template_field(
        &mut self,
        start: u32,
        end: u32,
        source_start: u32,
        source_end: u32,
    ) -> Option<Node> {
        let source = self.slice16(source_start, source_end);
        let mut lexed = lexer::tokenize(&source, self.file, &Options::default());
        for t in &mut lexed.tokens {
            t.start += source_start;
            for p in t.parts.iter_mut().flatten() {
                p.start += source_start;
                p.end += source_start;
                p.source_start = p.source_start.map(|s| s + source_start);
                p.source_end = p.source_end.map(|s| s + source_start);
            }
        }
        for d in &mut lexed.diagnostics {
            d.start += source_start;
        }
        if !self.too_deep {
            self.diagnostics.append(&mut lexed.diagnostics);
        }
        let mut inner = Parser::new(lexed.tokens, self.units, self.file);
        inner.nest = self.nest;
        inner.eof = source_end;
        let expression = inner.parse_expression();
        let mut width = None;
        if expression.is_some() && inner.eat(":") {
            if inner
                .peek()
                .is_some_and(|t| t.kind == TokenKind::Number && t.is_decimal != Some(true))
            {
                width = inner.next().map(|t| integer_node(&t));
            } else {
                inner.error_found("a field width after ':'");
                // reported once; don't also flag the rest as junk
                inner.pos = inner.tokens.len();
            }
        }
        if expression.is_some() && !inner.at_end() {
            let message = format!(
                "unexpected {} in template field",
                inner.peek().map_or_else(
                    || "end of file".to_string(),
                    |t| format!("'{}'", t.text)
                )
            );
            inner.error_here(message);
        }
        let too_deep = inner.too_deep;
        if !self.too_deep {
            self.diagnostics.append(&mut inner.diagnostics);
        }
        self.too_deep |= too_deep;
        let expression = expression?;
        Some(Node::new(
            start,
            end,
            NodeKind::TemplateField {
                expression: Box::new(expression),
                width: width.map(Box::new),
            },
        ))
    }
}
