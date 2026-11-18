//! `match` (syntax spec 3): a statement that lowers to an `IfStatement`
//! chain inside the parser (R6.4). A node made for sugar takes the span of
//! the source it stands for; the copied subject keeps its own span (R6.3).

use syntax::{Node, NodeKind, TokenKind};

use crate::types::integer_node;
use crate::{Parser, ident_node, node_end, tok_end};

/// A pattern value or range, before lowering.
enum Pattern {
    Value(Node),
    Range(Node, Node),
}

struct Arm {
    start: u32,
    patterns: Vec<Pattern>,
    /// `(start, length)` of a `_` pattern.
    wildcard: Option<(u32, u32)>,
    body: Node,
}

impl Parser<'_> {
    /// `match S { arms }`. `in_expression` is E11: the match is parsed for
    /// its own diagnostics and dropped.
    pub(crate) fn parse_match(&mut self, in_expression: bool) -> Option<Node> {
        let keyword = self.next()?;
        if in_expression {
            self.error_on("'match' is a statement; assign inside each arm", &keyword);
        }
        let subject = self.parse_match_subject();
        if !self.at("{") {
            if subject.is_some() {
                self.error_found("'{'");
            }
            return None;
        }
        self.next();

        let mut arms: Vec<Arm> = Vec::new();
        let mut bad = subject.is_none() || in_expression;
        let mut wildcard: Option<(u32, u32)> = None;
        let mut wildcard_reported = false;
        while !self.at_end() && !self.at("}") {
            let before = self.pos;
            if let Some(span) = wildcard
                && !wildcard_reported
                && self.peek().is_some()
            {
                // E14: an arm follows a `_` arm.
                self.error_at("'_' must be the last arm", span.0, span.1);
                wildcard_reported = true;
                bad = true;
            }
            match self.parse_arm() {
                Some(arm) => {
                    if wildcard.is_none() {
                        wildcard = arm.wildcard;
                    }
                    arms.push(arm);
                }
                None => bad = true,
            }
            if self.pos == before {
                self.unexpected();
                bad = true;
            }
        }
        let close = self.expect("}");
        let end = close.map_or_else(|| self.prev_end(), |t| tok_end(&t));
        if arms.is_empty() && !bad {
            // E15
            self.error_on("a match needs at least one arm", &keyword);
        }
        if bad || arms.is_empty() {
            return None;
        }
        Some(lower(subject?, arms, keyword.start, end))
    }

    /// An identifier or a path (`a::b`, `a.b`). E13 otherwise: the rest of
    /// the subject is skipped up to the `{`.
    fn parse_match_subject(&mut self) -> Option<Node> {
        let head = self
            .peek()
            .filter(|t| t.kind == TokenKind::Identifier)
            .cloned();
        let Some(head) = head else {
            self.error_here("match compares a name or path; bind the value first: let v = …;");
            self.skip_to_brace();
            return None;
        };
        self.next();
        let mut subject = ident_node(&head);
        while self.at(".") || self.at("::") {
            self.next();
            let Some(property) = self.expect_identifier("a property name") else {
                self.skip_to_brace();
                return None;
            };
            subject = Node::new(
                subject.start,
                node_end(&property),
                NodeKind::MemberExpression {
                    object: Box::new(subject),
                    property: Box::new(property),
                },
            );
        }
        if !self.at("{") && !self.at_end() {
            self.error_here("match compares a name or path; bind the value first: let v = …;");
            self.skip_to_brace();
            return None;
        }
        Some(subject)
    }

    fn skip_to_brace(&mut self) {
        while !self.at_end() && !self.at("{") && !self.at(";") && !self.at("}") {
            self.next();
        }
    }

    /// Skip the rest of a broken arm: through a `,`, past one balanced
    /// `{...}`, or up to the `}` that closes the match.
    fn skip_arm(&mut self) {
        let mut depth = 0usize;
        while let Some(token) = self.peek().cloned() {
            let punct = token.kind == TokenKind::Punctuation;
            if punct && token.text == "}" && depth == 0 {
                return;
            }
            self.next();
            if !punct {
                continue;
            }
            match token.text.as_str() {
                "," if depth == 0 => return,
                "{" => depth += 1,
                "}" => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return;
                    }
                }
                _ => {}
            }
        }
    }

    /// `Pattern { "|" Pattern } "=>" ( Block [","] | Expr ( "," | last ) )`.
    fn parse_arm(&mut self) -> Option<Arm> {
        let start = self.peek()?.start;
        let mut patterns = Vec::new();
        let mut wildcard = None;
        loop {
            if self.at("_") {
                let token = self.next()?;
                wildcard.get_or_insert((token.start, token.length));
            } else if let Some(pattern) = self.parse_pattern() {
                patterns.push(pattern);
            } else {
                self.skip_arm();
                return None;
            }
            if !self.eat("|") {
                break;
            }
        }
        if self.expect("=>").is_none() {
            self.skip_arm();
            return None;
        }
        let body = if self.at("{") {
            let block = self.parse_block(false);
            self.eat(",");
            block
        } else {
            let Some(expression) = self.parse_expression() else {
                self.skip_arm();
                return None;
            };
            let expression_end = node_end(&expression);
            let end = if self.at("}") {
                expression_end
            } else {
                self.expect(",").map_or(expression_end, |t| tok_end(&t))
            };
            Node::new(
                expression.start,
                end,
                NodeKind::ExpressionStatement {
                    expression: Box::new(expression),
                },
            )
        };
        Some(Arm {
            start,
            patterns,
            wildcard,
            body,
        })
    }

    fn parse_pattern(&mut self) -> Option<Pattern> {
        let low = self.parse_pattern_value()?;
        if self.at("..=") {
            self.next();
            let high = self.parse_pattern_value()?;
            return Some(Pattern::Range(low, high));
        }
        Some(Pattern::Value(low))
    }

    /// `[-] integer`, `true`, `false` or a `::` path.
    fn parse_pattern_value(&mut self) -> Option<Node> {
        let Some(token) = self.peek().cloned() else {
            self.error_found("a pattern");
            return None;
        };
        let integer = |t: &syntax::Token| t.kind == TokenKind::Number && t.is_decimal != Some(true);
        match (token.kind, token.text.as_str()) {
            (TokenKind::Operator, "-") if self.peek_n(1).is_some_and(integer) => {
                self.next();
                let number = self.next()?;
                Some(Node::new(
                    token.start,
                    tok_end(&number),
                    NodeKind::UnaryExpression {
                        operator: "-".to_string(),
                        argument: Box::new(integer_node(&number)),
                    },
                ))
            }
            (TokenKind::Number, _) if integer(&token) => {
                self.next();
                Some(integer_node(&token))
            }
            (TokenKind::Keyword, "true" | "false") => {
                self.next();
                Some(Node::new(
                    token.start,
                    tok_end(&token),
                    NodeKind::BooleanLiteral {
                        value: token.text == "true",
                    },
                ))
            }
            (TokenKind::Identifier, _) => {
                self.next();
                let mut path = ident_node(&token);
                while self.at("::") {
                    self.next();
                    let Some(property) = self.expect_identifier("a name") else {
                        break;
                    };
                    path = Node::new(
                        path.start,
                        node_end(&property),
                        NodeKind::MemberExpression {
                            object: Box::new(path),
                            property: Box::new(property),
                        },
                    );
                }
                Some(path)
            }
            _ => {
                self.error_found("a pattern");
                None
            }
        }
    }
}

fn binary(operator: &str, start: u32, end: u32, left: Node, right: Node) -> Node {
    Node::new(
        start,
        end,
        NodeKind::BinaryExpression {
            operator: operator.to_string(),
            left: Box::new(left),
            right: Box::new(right),
        },
    )
}

/// `S == P`, or `S >= lo && S <= hi`.
fn pattern_test(subject: &Node, pattern: Pattern) -> Node {
    match pattern {
        Pattern::Value(value) => {
            binary("==", value.start, node_end(&value), subject.clone(), value)
        }
        Pattern::Range(low, high) => {
            let (start, end) = (low.start, node_end(&high));
            let at_least = binary(">=", low.start, node_end(&low), subject.clone(), low);
            let at_most = binary("<=", high.start, node_end(&high), subject.clone(), high);
            binary("&&", start, end, at_least, at_most)
        }
    }
}

/// Alternatives joined with `||`, left to right.
fn arm_test(subject: &Node, patterns: Vec<Pattern>) -> Option<Node> {
    let mut tests = patterns.into_iter().map(|p| pattern_test(subject, p));
    let first = tests.next()?;
    Some(tests.fold(first, |left, right| {
        let (start, end) = (left.start, node_end(&right));
        binary("||", start, end, left, right)
    }))
}

/// The `IfStatement` chain: each arm's alternate is the next arm, the `_`
/// body or nothing. Only a `_` arm: its body alone.
fn lower(subject: Node, arms: Vec<Arm>, start: u32, end: u32) -> Node {
    let mut tail: Option<Node> = None;
    let mut top = true;
    for arm in arms.into_iter().rev() {
        let test = arm_test(&subject, arm.patterns);
        let Some(test) = test else {
            // A `_` arm (E14 keeps it last).
            tail = Some(arm.body);
            top = true;
            continue;
        };
        let node_start = arm.start;
        tail = Some(Node::new(
            node_start,
            end,
            NodeKind::IfStatement {
                test: Some(Box::new(test)),
                consequent: Some(Box::new(arm.body)),
                alternate: tail.take().map(Box::new),
            },
        ));
        top = false;
    }
    let mut result = tail
        .unwrap_or_else(|| Node::new(start, end, NodeKind::BlockStatement { body: Vec::new() }));
    if !top {
        // The first arm's `IfStatement` stands for the whole match.
        result.start = start;
        result.length = end.saturating_sub(start);
    }
    result
}
