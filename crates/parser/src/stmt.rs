//! Statements and declarations (`parser/index.mjs:96-243, 436-715`, syntax
//! spec 6 `Stmt`) with the new-syntax checks E3, E4, E12, E16-E19, E21.

use syntax::{Node, NodeKind, TokenKind};

use crate::{Parser, ident_name, node_end, strip_quotes, tok_end};

/// E3: the message for a reserved word, or `None` for any other word.
pub(crate) fn reserved_message(word: &str) -> Option<String> {
    match word {
        "struct" | "enum" => Some(format!(
            "'{word}' is not part of 8BitScript; group consts in a 'mod'"
        )),
        "impl" | "trait" => Some(format!(
            "'{word}' is not part of 8BitScript; methods are functions in a 'mod'"
        )),
        "static" => Some(
            "'static' is not part of 8BitScript; a global is 'let mut' at the top level"
                .to_string(),
        ),
        "type" => Some("8BitScript has no type aliases".to_string()),
        _ => None,
    }
}

/// The release that ships `8bs migrate`; the flip change sets the real
/// version here (syntax spec E21).
pub const MIGRATE_RELEASE: &str = "<cut release>";

/// E21: the full text, built from [`MIGRATE_RELEASE`].
#[must_use]
pub fn old_syntax_message() -> String {
    format!(
        "this is the old 8BitScript syntax; run '8bs migrate' from 8BitScript {MIGRATE_RELEASE} to convert it"
    )
}

const OLD_SYNTAX_WORDS: [&str; 4] = ["function", "import", "export", "namespace"];

fn set_exported(node: &mut Node) {
    match &mut node.kind {
        NodeKind::VariableDeclaration { exported, .. }
        | NodeKind::FunctionDeclaration { exported, .. }
        | NodeKind::NamespaceDeclaration { exported, .. } => *exported = true,
        _ => {}
    }
}

impl Parser<'_> {
    /// One statement. `tail` is set for a direct child of a `fn` body whose
    /// return type is not `void`: a tail expression there is E16.
    pub(crate) fn parse_statement(&mut self, tail: bool) -> Option<Node> {
        if !self.enter() {
            return None;
        }
        let result = self.statement_inner(tail);
        self.leave();
        result
    }

    /// One `match` on the first token with a default arm to an expression
    /// statement (R6.6).
    fn statement_inner(&mut self, tail: bool) -> Option<Node> {
        let token = self.peek()?.clone();
        match (token.kind, token.text.as_str()) {
            (TokenKind::Punctuation, "#[") => self.parse_decorated(),
            (TokenKind::Punctuation, "#![") => {
                self.skip_inner_attribute();
                None
            }
            (TokenKind::AsmBlock, _) => self.parse_asm_block(token.start),
            (TokenKind::Keyword, "use") => self.parse_use(),
            (TokenKind::Keyword, "pub") => self.parse_pub(),
            (TokenKind::Keyword, "fn") => self.parse_function(token.start, false),
            (TokenKind::Keyword, "mod") => self.parse_mod(token.start, false),
            (TokenKind::Keyword, "let" | "const") => self.parse_variable(None),
            (TokenKind::Keyword, "if") => self.parse_if(),
            (TokenKind::Keyword, "while") => self.parse_while(),
            (TokenKind::Keyword, "loop") => self.parse_loop(),
            (TokenKind::Keyword, "for") => self.parse_for(),
            (TokenKind::Keyword, "match") => self.parse_match(false),
            (TokenKind::Keyword, "return") => self.parse_return(),
            (TokenKind::Keyword, "break" | "continue") => self.parse_break_or_continue(),
            (TokenKind::Keyword, "asm6502") => {
                self.next();
                if self.peek().is_some_and(|t| t.kind == TokenKind::AsmBlock) {
                    return self.parse_asm_block(token.start);
                }
                self.error_here("expected '{' after 'asm6502'");
                None
            }
            (TokenKind::Keyword, word) if reserved_message(word).is_some() => {
                self.skip_reserved_item();
                None
            }
            (TokenKind::Punctuation, "{") => Some(self.parse_block(false)),
            (TokenKind::Punctuation, ";") => {
                self.next();
                None
            }
            (TokenKind::Identifier, word)
                if OLD_SYNTAX_WORDS.contains(&word) && self.old_syntax_follows() =>
            {
                self.skip_old_syntax_item();
                None
            }
            _ => self.parse_expression_statement(tail),
        }
    }

    // ---- recovery --------------------------------------------------------

    /// E3: report the reserved word and skip the item it starts.
    fn skip_reserved_item(&mut self) {
        let Some(token) = self.next() else { return };
        if let Some(message) = reserved_message(&token.text) {
            self.error_on(message, &token);
        }
        self.skip_item_tail();
    }

    /// E21: a statement that starts with an old-syntax word followed by a
    /// name, a keyword, a type, a string or a `{`.
    fn old_syntax_follows(&self) -> bool {
        self.peek_n(1).is_some_and(|t| {
            matches!(
                t.kind,
                TokenKind::Identifier | TokenKind::Keyword | TokenKind::Type | TokenKind::String
            ) || (t.kind == TokenKind::Punctuation && t.text == "{")
        })
    }

    fn skip_old_syntax_item(&mut self) {
        let Some(token) = self.next() else { return };
        self.error_on(old_syntax_message(), &token);
        self.skip_item_tail();
    }

    /// Skip to the end of an item: through a `;`, or past one balanced
    /// `{...}` block (an old `import { a } from "x";` keeps going to its
    /// `;`). Stops before a `}` that closes the enclosing block.
    fn skip_item_tail(&mut self) {
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
                ";" if depth == 0 => return,
                "{" => depth += 1,
                "}" => {
                    depth = depth.saturating_sub(1);
                    let from_follows = self
                        .peek()
                        .is_some_and(|t| t.kind == TokenKind::Identifier && t.text == "from");
                    if depth == 0 && !from_follows {
                        return;
                    }
                }
                _ => {}
            }
        }
    }

    // ---- attributes ------------------------------------------------------

    /// E18: `#![...]` is skipped through its matching `]`.
    fn skip_inner_attribute(&mut self) {
        let Some(open) = self.next() else { return };
        self.error_on("inner attributes are not supported", &open);
        let mut depth = 1usize;
        while depth > 0 {
            let Some(token) = self.next() else { return };
            if token.kind != TokenKind::Punctuation {
                continue;
            }
            match token.text.as_str() {
                "[" | "#[" | "#![" => depth += 1,
                "]" => depth -= 1,
                _ => {}
            }
        }
    }

    /// `#[name(args)]`: a `Decorator` spanning `#[` through `]`.
    fn parse_attribute(&mut self) -> Option<Node> {
        let open = self.next()?;
        let name_token = self
            .peek()
            .filter(|t| t.kind == TokenKind::Identifier)
            .cloned();
        let Some(name_token) = name_token else {
            self.error_found("an attribute name");
            self.skip_to_bracket_end();
            return None;
        };
        self.next();
        let name = ident_name(&name_token.text);
        let mut args = Vec::new();
        if self.at("(") {
            self.next();
            args = self.with_braces(|p| {
                let mut args = Vec::new();
                while !p.at_end() && !p.at(")") {
                    let Some(argument) = p.parse_expression() else {
                        break;
                    };
                    args.push(argument);
                    if !p.eat(",") {
                        break;
                    }
                }
                args
            });
            self.expect(")");
        }
        let close = self.expect("]");
        let end = close.map_or_else(|| self.prev_end(), |t| tok_end(&t));
        let is_test = name == "test"
            || (name == "cfg"
                && args.len() == 1
                && args.first().is_some_and(
                    |a| matches!(&a.kind, NodeKind::Identifier { name, .. } if name == "test"),
                ));
        if is_test {
            self.error_at(
                "tests come with '8bs test'",
                open.start,
                end.saturating_sub(open.start),
            );
        }
        Some(Node::new(
            open.start,
            end,
            NodeKind::Decorator { name, args },
        ))
    }

    fn skip_to_bracket_end(&mut self) {
        let mut depth = 1usize;
        while depth > 0 {
            let Some(token) = self.peek().cloned() else {
                return;
            };
            if token.kind == TokenKind::Punctuation && matches!(token.text.as_str(), ";" | "}") {
                return;
            }
            self.next();
            if token.kind != TokenKind::Punctuation {
                continue;
            }
            match token.text.as_str() {
                "[" | "#[" | "#![" => depth += 1,
                "]" => depth -= 1,
                _ => {}
            }
        }
    }

    fn parse_attributes(&mut self) -> Vec<Node> {
        let mut decorators = Vec::new();
        while self.at("#[") {
            let before = self.pos;
            if let Some(decorator) = self.parse_attribute() {
                decorators.push(decorator);
            }
            if self.pos == before {
                break;
            }
        }
        decorators
    }

    fn parse_decorated(&mut self) -> Option<Node> {
        let decorators = self.parse_attributes();
        let mut target = self.parse_statement(false);
        if let Some(node) = &mut target {
            node.decorators = Some(decorators);
        }
        target
    }

    // ---- declarations ----------------------------------------------------

    fn parse_asm_block(&mut self, start: u32) -> Option<Node> {
        let token = self.next()?;
        Some(Node::new(
            start,
            tok_end(&token),
            NodeKind::AsmBlock { body: token.text },
        ))
    }

    /// E19: `pub` before anything but `fn`, `mod`, `let` or `const`.
    fn parse_pub(&mut self) -> Option<Node> {
        let start = self.next()?.start;
        let keyword = self
            .peek()
            .filter(|t| t.kind == TokenKind::Keyword)
            .map(|t| t.text.clone());
        let mut declaration = match keyword.as_deref() {
            Some("fn") => self.parse_function(start, true),
            Some("mod") => self.parse_mod(start, true),
            Some("let" | "const") => self.parse_variable(Some(start)),
            _ => {
                let message = format!(
                    "expected a declaration after 'pub', found {}",
                    Self::describe(self.peek())
                );
                self.error_here(message);
                self.synchronize();
                return None;
            }
        };
        if let Some(node) = &mut declaration {
            set_exported(node);
        }
        declaration
    }

    /// `let [mut] x: T = e;` and `const X: T = e;`.
    pub(crate) fn parse_variable(&mut self, start_override: Option<u32>) -> Option<Node> {
        let keyword = self.next()?;
        let start = start_override.unwrap_or(keyword.start);
        let is_let = keyword.text == "let";
        let mutable = is_let && self.at_kw("mut");
        if mutable {
            self.next();
        }
        let Some(name) = self.expect_identifier("a variable name") else {
            self.synchronize();
            return None;
        };
        let type_annotation = if self.eat(":") {
            self.parse_type()
        } else {
            None
        };
        let initializer = if self.eat("=") {
            self.parse_expression()
        } else {
            None
        };
        let last_end = initializer
            .as_ref()
            .or(type_annotation.as_ref())
            .map_or_else(|| node_end(&name), node_end);
        let end = self.expect(";").map_or(last_end, |t| tok_end(&t));
        Some(Node::new(
            start,
            end,
            NodeKind::VariableDeclaration {
                kind: keyword.text,
                name: Some(Box::new(name)),
                type_annotation: type_annotation.map(Box::new),
                initializer: initializer.map(Box::new),
                exported: false,
                immutable: (is_let && !mutable).then_some(true),
            },
        ))
    }

    /// `fn f(a: u8, b: u8 = 3) -> u8 { ... }`.
    pub(crate) fn parse_function(&mut self, start: u32, exported: bool) -> Option<Node> {
        self.next()?; // 'fn'
        let name = self.expect_identifier("a function name");
        let mut params = Vec::new();
        if self.expect("(").is_some() {
            while !self.at_end() && !self.at(")") {
                let Some(param_name) = self.expect_identifier("a parameter name") else {
                    break;
                };
                let type_annotation = if self.expect(":").is_some() {
                    self.parse_type()
                } else {
                    None
                };
                let default_value = if self.eat("=") {
                    self.parse_expression()
                } else {
                    None
                };
                let last_end = default_value
                    .as_ref()
                    .or(type_annotation.as_ref())
                    .map_or_else(|| node_end(&param_name), node_end);
                params.push(Node::new(
                    param_name.start,
                    last_end,
                    NodeKind::Parameter {
                        name: Box::new(param_name),
                        type_annotation: type_annotation.map(Box::new),
                        default_value: default_value.map(Box::new),
                        optional: None,
                    },
                ));
                if !self.eat(",") {
                    break;
                }
            }
            self.expect(")");
        }
        let return_type = if self.eat("->") {
            self.parse_type()
        } else {
            None
        };
        let returns_value = return_type.as_ref().is_some_and(
            |t| !matches!(&t.kind, NodeKind::TypeReference { name, .. } if name == "void"),
        );
        let body = if self.at("{") {
            Some(self.parse_block(returns_value))
        } else {
            self.error_here("expected a function body");
            None
        };
        let end = body.as_ref().map_or_else(|| self.prev_end(), node_end);
        Some(Node::new(
            start,
            end,
            NodeKind::FunctionDeclaration {
                name: name.map(Box::new),
                params,
                return_type: return_type.map(Box::new),
                body: body.map(Box::new),
                exported,
            },
        ))
    }

    /// `mod M { {Attr} [pub] (fn | let | const) }`.
    fn parse_mod(&mut self, start: u32, exported: bool) -> Option<Node> {
        self.next()?; // 'mod'
        let name = self.expect_identifier("a mod name");
        let mut members = Vec::new();
        if self.expect("{").is_some() {
            while !self.at_end() && !self.at("}") {
                let before = self.pos;
                self.parse_mod_member(&mut members);
                if self.pos == before {
                    self.next();
                }
            }
        }
        let close = self.expect("}");
        let end = close.map_or_else(|| self.prev_end(), |t| tok_end(&t));
        Some(Node::new(
            start,
            end,
            NodeKind::NamespaceDeclaration {
                name: name.map(Box::new),
                members,
                exported,
            },
        ))
    }

    fn parse_mod_member(&mut self, members: &mut Vec<Option<Node>>) {
        let decorators = self.parse_attributes();
        // A `pub` on a member is accepted and ignored.
        if self.at_kw("pub") {
            self.next();
        }
        let keyword = self
            .peek()
            .filter(|t| t.kind == TokenKind::Keyword)
            .cloned();
        let mut member = match keyword.as_ref().map(|t| t.text.as_str()) {
            Some("fn") => keyword
                .as_ref()
                .and_then(|t| self.parse_function(t.start, false)),
            Some("let" | "const") => self.parse_variable(None),
            Some(word) if reserved_message(word).is_some() => {
                self.skip_reserved_item();
                return;
            }
            _ => {
                let message = format!(
                    "expected a function or const inside a mod, found {}",
                    Self::describe(self.peek())
                );
                self.error_here(message);
                return;
            }
        };
        if let Some(node) = &mut member
            && !decorators.is_empty()
        {
            node.decorators = Some(decorators);
        }
        members.push(member);
    }

    // ---- use -------------------------------------------------------------

    /// `use self::geo::{a, b as c};`, `use p::name;`, `use "spec"::{..};`.
    fn parse_use(&mut self) -> Option<Node> {
        let start = self.next()?.start;
        let string_head = self.peek().filter(|t| t.kind == TokenKind::String).cloned();
        let (source, use_path, brace_form) = if let Some(token) = string_head {
            self.next();
            let source = Node::new(
                token.start,
                tok_end(&token),
                NodeKind::StringLiteral {
                    value: strip_quotes(&token.text),
                    unterminated: None,
                },
            );
            self.expect("::");
            (Some(source), None, self.at("{"))
        } else {
            self.parse_use_path()
        };
        let mut specifiers = Vec::new();
        if brace_form {
            if self.expect("{").is_some() {
                while !self.at_end() && !self.at("}") {
                    let Some(name) = self.parse_use_name() else {
                        break;
                    };
                    specifiers.push(name);
                    if !self.eat(",") {
                        break;
                    }
                }
                self.expect("}");
            }
        } else if let Some(name) = self.parse_use_name() {
            specifiers.push(name);
        }
        let end = self
            .expect(";")
            .map_or_else(|| self.prev_end(), |t| tok_end(&t));
        Some(Node::new(
            start,
            end,
            NodeKind::ImportDeclaration {
                specifiers,
                source: source.map(Box::new),
                use_path,
            },
        ))
    }

    /// `UseName = ident [ "as" ident ]`; an alias keeps the imported name's span.
    fn parse_use_name(&mut self) -> Option<Node> {
        let mut name = self.expect_identifier("an imported name")?;
        if self.at_kw("as") {
            self.next();
            let local = self.expect_identifier("a local name");
            if let (
                Some(local),
                NodeKind::Identifier {
                    name: n, imported, ..
                },
            ) = (local, &mut name.kind)
                && let NodeKind::Identifier {
                    name: local_name, ..
                } = local.kind
            {
                *imported = Some(std::mem::replace(n, local_name));
            }
        }
        Some(name)
    }

    /// The module path of a `use` and whether a `{` list follows it. For
    /// the single-name form the cursor is left on the name.
    fn parse_use_path(&mut self) -> (Option<Node>, Option<bool>, bool) {
        // E4: drop `crate::`.
        if self.at_kw("crate") {
            if let Some(token) = self.next() {
                self.error_on(
                    "'crate::' paths are not supported; use 'self::' or 'super::'",
                    &token,
                );
            }
            self.eat("::");
        }
        let Some(head) = self.peek().cloned() else {
            self.error_found("a module path");
            return (None, None, false);
        };
        // Each segment: its text, the index of its token, the end of that token.
        let mut segments: Vec<(String, usize, u32)> = Vec::new();
        let head_word = match (head.kind, head.text.as_str()) {
            (TokenKind::Keyword, "self") => Some("self"),
            (TokenKind::Keyword, "super") => Some("super"),
            (TokenKind::Scope | TokenKind::Identifier, _) => None,
            _ => {
                self.error_found("a module path");
                return (None, None, false);
            }
        };
        let head_text = match head_word {
            Some("self") => ".".to_string(),
            Some(_) => "..".to_string(),
            None => ident_name(&head.text),
        };
        segments.push((head_text, self.pos, tok_end(&head)));
        self.next();
        let mut all_super = head_word == Some("super");

        // `::` segments, up to the `::{` of a list.
        while self.at("::") && !self.at_n(1, "{") {
            let Some(next) = self.peek_n(1).cloned() else {
                break;
            };
            let text = match (next.kind, next.text.as_str()) {
                (TokenKind::Keyword, "super") if all_super => "..".to_string(),
                (TokenKind::Identifier, _) => {
                    all_super = false;
                    ident_name(&next.text)
                }
                _ => break,
            };
            segments.push((text, self.pos + 1, tok_end(&next)));
            self.next();
            self.next();
        }

        let brace_form = self.at("::") && self.at_n(1, "{");
        if brace_form {
            self.next();
        } else if segments.len() < 2 {
            // `use foo;`: no module before the name.
            self.error_found("'::'");
            return (None, None, false);
        } else if let Some((_, name_index, _)) = segments.pop() {
            // The last segment is the name, read by `parse_use_name`.
            self.pos = name_index;
        }
        let words: Vec<&str> = segments.iter().map(|(t, _, _)| t.as_str()).collect();
        if words.iter().all(|w| *w == "." || *w == "..") {
            let word = head_word.unwrap_or("self");
            self.error_here(format!("expected a module name after '{word}'"));
            return (None, None, brace_form);
        }
        let end = segments.last().map_or(head.start, |(_, _, end)| *end);
        let source = Node::new(
            head.start,
            end,
            NodeKind::StringLiteral {
                value: words.join("/"),
                unterminated: None,
            },
        );
        (Some(source), Some(true), brace_form)
    }

    // ---- control flow ----------------------------------------------------

    /// A `{` block or `expected '{', found X`.
    fn parse_block_required(&mut self) -> Option<Node> {
        if self.at("{") {
            return Some(self.parse_block(false));
        }
        self.error_found("'{'");
        None
    }

    pub(crate) fn parse_block(&mut self, tail: bool) -> Node {
        let open = self.expect("{");
        let start = open.map_or_else(
            || self.peek().map_or_else(|| self.end_offset(), |t| t.start),
            |t| t.start,
        );
        let mut body = Vec::new();
        while !self.at_end() && !self.at("}") {
            let before = self.pos;
            if let Some(statement) = self.parse_statement(tail) {
                body.push(statement);
            }
            if self.pos == before {
                self.unexpected();
            }
        }
        let close = self.expect("}");
        let end = close.map_or_else(|| self.prev_end(), |t| tok_end(&t));
        Node::new(start, end, NodeKind::BlockStatement { body })
    }

    fn parse_if(&mut self) -> Option<Node> {
        let start = self.next()?.start;
        let test = self.parse_expression_no_brace();
        let consequent = self.parse_block_required();
        let mut alternate = None;
        if self.at_kw("else") {
            self.next();
            if self.at_kw("if") {
                if self.enter() {
                    alternate = self.parse_if();
                    self.leave();
                }
            } else {
                alternate = self.parse_block_required();
            }
        }
        let end = alternate
            .as_ref()
            .or(consequent.as_ref())
            .map_or_else(|| self.prev_end(), node_end);
        Some(Node::new(
            start,
            end,
            NodeKind::IfStatement {
                test: test.map(Box::new),
                consequent: consequent.map(Box::new),
                alternate: alternate.map(Box::new),
            },
        ))
    }

    fn parse_while(&mut self) -> Option<Node> {
        let start = self.next()?.start;
        let test = self.parse_expression_no_brace();
        let body = self.parse_block_required();
        let end = body.as_ref().map_or_else(|| self.prev_end(), node_end);
        Some(Node::new(
            start,
            end,
            NodeKind::WhileStatement {
                test: test.map(Box::new),
                body: body.map(Box::new),
            },
        ))
    }

    /// `loop { }`: `while true` with the span of the `loop` keyword.
    fn parse_loop(&mut self) -> Option<Node> {
        let keyword = self.next()?;
        let test = Node::new(
            keyword.start,
            tok_end(&keyword),
            NodeKind::BooleanLiteral { value: true },
        );
        let body = self.parse_block_required();
        let end = body.as_ref().map_or_else(|| self.prev_end(), node_end);
        Some(Node::new(
            keyword.start,
            end,
            NodeKind::WhileStatement {
                test: Some(Box::new(test)),
                body: body.map(Box::new),
            },
        ))
    }

    fn parse_for(&mut self) -> Option<Node> {
        if self.at_n(1, "(") {
            self.parse_c_for()
        } else {
            self.parse_range_for()
        }
    }

    /// `for i[: T] in a..b { }` and `a..=b`: a counted `ForStatement`.
    fn parse_range_for(&mut self) -> Option<Node> {
        let start = self.next()?.start;
        let Some(variable) = self.expect_identifier("a loop variable") else {
            self.synchronize();
            return None;
        };
        let type_annotation = if self.eat(":") {
            self.parse_type()
        } else {
            None
        };
        if self.at_kw("in") {
            self.next();
        } else {
            self.error_found("'in'");
        }
        let from = self.parse_binary(0)?;
        let inclusive = if self.at("..=") {
            true
        } else if self.at("..") {
            false
        } else {
            self.error_found("'..' or '..='");
            return None;
        };
        self.next();
        let saved = std::mem::replace(&mut self.no_brace, true);
        let to = self.parse_binary(0);
        self.no_brace = saved;
        let to = to?;
        let body = self.parse_block_required();
        let end = body.as_ref().map_or_else(|| node_end(&to), node_end);

        let init = Node::new(
            variable.start,
            node_end(&from),
            NodeKind::VariableDeclaration {
                kind: "let".to_string(),
                name: Some(Box::new(variable.clone())),
                type_annotation: type_annotation.map(Box::new),
                initializer: Some(Box::new(from)),
                exported: false,
                immutable: Some(true),
            },
        );
        let test = Node::new(
            variable.start,
            node_end(&to),
            NodeKind::BinaryExpression {
                operator: if inclusive { "<=" } else { "<" }.to_string(),
                left: Box::new(variable.clone()),
                right: Box::new(to),
            },
        );
        let update = Node::new(
            variable.start,
            node_end(&variable),
            NodeKind::UpdateExpression {
                operator: "++".to_string(),
                argument: Box::new(variable),
                prefix: false,
            },
        );
        Some(Node::new(
            start,
            end,
            NodeKind::ForStatement {
                init: Some(Box::new(init)),
                test: Some(Box::new(test)),
                update: Some(Box::new(update)),
                body: body.map(Box::new),
            },
        ))
    }

    /// `for (init; test; update) { }`.
    fn parse_c_for(&mut self) -> Option<Node> {
        let start = self.next()?.start;
        self.expect("(");
        let (init, test, update) = self.with_braces(|p| {
            let init = if p.at(";") { None } else { p.parse_for_init() };
            p.expect(";");
            let test = if p.at(";") {
                None
            } else {
                p.parse_expression()
            };
            p.expect(";");
            let update = if p.at(")") {
                None
            } else {
                p.parse_expression()
            };
            (init, test, update)
        });
        self.expect(")");
        let body = self.parse_block_required();
        let end = body.as_ref().map_or_else(|| self.prev_end(), node_end);
        Some(Node::new(
            start,
            end,
            NodeKind::ForStatement {
                init: init.map(Box::new),
                test: test.map(Box::new),
                update: update.map(Box::new),
                body: body.map(Box::new),
            },
        ))
    }

    /// A `for` initializer: a declaration without its `;`, or an expression.
    fn parse_for_init(&mut self) -> Option<Node> {
        if !(self.at_kw("let") || self.at_kw("const")) {
            return self.parse_expression();
        }
        let keyword = self.next()?;
        let is_let = keyword.text == "let";
        let mutable = is_let && self.at_kw("mut");
        if mutable {
            self.next();
        }
        let name = self.expect_identifier("a variable name");
        let type_annotation = if self.eat(":") {
            self.parse_type()
        } else {
            None
        };
        let initializer = if self.eat("=") {
            self.parse_expression()
        } else {
            None
        };
        let end = initializer
            .as_ref()
            .or(type_annotation.as_ref())
            .or(name.as_ref())
            .map_or_else(|| tok_end(&keyword), node_end);
        Some(Node::new(
            keyword.start,
            end,
            NodeKind::VariableDeclaration {
                kind: keyword.text,
                name: name.map(Box::new),
                type_annotation: type_annotation.map(Box::new),
                initializer: initializer.map(Box::new),
                exported: false,
                immutable: (is_let && !mutable).then_some(true),
            },
        ))
    }

    fn parse_return(&mut self) -> Option<Node> {
        let keyword = self.next()?;
        let argument = if self.at(";") || self.at("}") {
            None
        } else {
            self.parse_expression()
        };
        let fallback = argument
            .as_ref()
            .map_or_else(|| tok_end(&keyword), node_end);
        let end = self.expect(";").map_or(fallback, |t| tok_end(&t));
        Some(Node::new(
            keyword.start,
            end,
            NodeKind::ReturnStatement {
                argument: argument.map(Box::new),
            },
        ))
    }

    fn parse_break_or_continue(&mut self) -> Option<Node> {
        let keyword = self.next()?;
        let end = self
            .expect(";")
            .map_or_else(|| tok_end(&keyword), |t| tok_end(&t));
        let kind = if keyword.text == "break" {
            NodeKind::BreakStatement {}
        } else {
            NodeKind::ContinueStatement {}
        };
        Some(Node::new(keyword.start, end, kind))
    }

    /// `expr;`. E17 is the missing `;` and E16 a tail expression in a `fn`
    /// with a return type.
    fn parse_expression_statement(&mut self, tail: bool) -> Option<Node> {
        let before = self.pos;
        let Some(expression) = self.parse_expression() else {
            // A rule that consumed nothing left the token for us to skip.
            if self.pos == before {
                self.synchronize();
            }
            return None;
        };
        let expression_end = node_end(&expression);
        let end = if self.at(";") {
            self.next().map_or(expression_end, |t| tok_end(&t))
        } else if tail && self.at("}") {
            self.error_at(
                "write 'return …;' to return a value",
                expression.start,
                expression.length,
            );
            expression_end
        } else {
            self.expect(";");
            expression_end
        };
        Some(Node::new(
            expression.start,
            end,
            NodeKind::ExpressionStatement {
                expression: Box::new(expression),
            },
        ))
    }
}
