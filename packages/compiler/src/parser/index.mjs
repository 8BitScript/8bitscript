// Recursive-descent parser: tokens in, AST out.
//
// Two rules shape the whole design.
//
// First, it never throws. An editor parses on every keystroke, so half-typed
// source is the normal input, not an error case. On a syntax error the parser
// records a diagnostic, synchronises to the next statement boundary, and keeps
// going — a file with ten mistakes yields ten diagnostics and a partial tree,
// not one diagnostic and nothing.
//
// Second, it parses only what the language has actually specified. `switch` and
// `case` are lexed as keywords but have no parse rule, so writing one is an
// honest syntax error rather than a silently accepted guess at syntax nobody
// has decided on.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { TokenKind, tokenize } from '../lexer/index.mjs';
import { NodeType, node } from '../ast/index.mjs';

/** Binary operator precedence, loosest first. Mirrors the C/TypeScript table. */
const BINARY_PRECEDENCE = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

const ASSIGNMENT_OPERATORS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=',
]);

/** Keywords that can begin a statement — used to resynchronise after an error. */
const STATEMENT_START = new Set([
  'let', 'const', 'function', 'component', 'export', 'import', 'return',
  'if', 'while', 'for', 'break', 'continue', 'asm6502', 'namespace',
]);

/**
 * Raw text between tags, the way spec §35 reads it: each line trimmed,
 * blank lines dropped, the rest joined with one space. `""` when nothing
 * is left — the caller makes no node of that.
 *
 * @param {string} raw
 */
export function normalizeBxText(raw) {
  return raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join(' ');
}

class Parser {
  constructor(tokens, text, file, options = {}) {
    // Comments carry no syntax. Dropping them here keeps every rule below free
    // of "skip trivia" noise.
    this.tokens = tokens.filter((t) => t.kind !== TokenKind.Comment);
    this.text = text;
    this.file = file;
    this.sourceKind = options.sourceKind ?? '.8bs';
    this.pos = 0;
    this.diagnostics = [];
  }

  // ---- token access -------------------------------------------------------

  peek(offset = 0) {
    return this.tokens[this.pos + offset] ?? null;
  }

  get atEnd() {
    return this.pos >= this.tokens.length;
  }

  /** Offset just past the last token, for spans that run to end of file. */
  get endOffset() {
    const last = this.tokens[this.tokens.length - 1];
    return last ? last.start + last.length : 0;
  }

  next() {
    return this.tokens[this.pos++] ?? null;
  }

  at(text) {
    return this.peek()?.text === text;
  }

  atKeyword(word) {
    const t = this.peek();
    return t?.kind === TokenKind.Keyword && t.text === word;
  }

  eat(text) {
    if (this.at(text)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  describe(token) {
    if (!token) return 'end of file';
    return `'${token.text}'`;
  }

  error(message, token = this.peek()) {
    const start = token ? token.start : this.endOffset;
    const length = token ? token.length : 0;
    this.diagnostics.push(diagnostic(Codes.SYNTAX_ERROR, message, this.file, start, length));
  }

  /** Consume `text` or record what was found instead. */
  expect(text) {
    const token = this.peek();
    if (token?.text === text) {
      this.pos += 1;
      return token;
    }
    this.error(`expected '${text}', found ${this.describe(token)}`, token);
    return null;
  }

  expectIdentifier(what = 'an identifier') {
    const token = this.peek();
    if (token?.kind === TokenKind.Identifier) {
      this.pos += 1;
      return node(NodeType.Identifier, token.start, token.start + token.length, {
        name: token.text,
      });
    }
    this.error(`expected ${what}, found ${this.describe(token)}`, token);
    return null;
  }

  /**
   * Skip forward until something that can plausibly start a new statement.
   *
   * This is what turns one mistake into one diagnostic instead of a cascade.
   */
  synchronize() {
    while (!this.atEnd) {
      const token = this.next();
      if (token.text === ';') return;
      if (token.text === '}') return;
      const ahead = this.peek();
      if (ahead?.kind === TokenKind.Keyword && STATEMENT_START.has(ahead.text)) return;
    }
  }

  // ---- program ------------------------------------------------------------

  parseProgram() {
    const body = [];
    while (!this.atEnd) {
      const before = this.pos;
      const statement = this.parseStatement();
      if (statement) body.push(statement);
      // Guarantee forward progress: a rule that consumed nothing would spin.
      if (this.pos === before) {
        this.error(`unexpected ${this.describe(this.peek())}`);
        this.next();
      }
    }
    return node(NodeType.Program, 0, this.text.length, { body });
  }

  // ---- statements ---------------------------------------------------------

  parseStatement() {
    const token = this.peek();
    if (!token) return null;

    if (token.kind === TokenKind.Decorator) return this.parseDecorated();
    if (token.kind === TokenKind.AsmBlock) return this.parseAsmBlock(token.start);

    if (token.kind === TokenKind.Keyword) {
      switch (token.text) {
        case 'import': return this.parseImport();
        case 'export': return this.parseExport();
        case 'let':
        case 'const': return this.parseVariableDeclaration();
        case 'function': return this.parseFunctionDeclaration(token.start, false);
        case 'component':
          if (this.sourceKind !== '.8bx') {
            this.error("'component' is only allowed in .8bx files", token);
            return null;
          }
          return this.parseComponentDeclaration(token.start, false);
        case 'namespace': return this.parseNamespace(token.start, false);
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'for': return this.parseFor();
        case 'return': return this.parseReturn();
        case 'break':
        case 'continue': return this.parseBreakOrContinue();
        case 'asm6502': {
          const start = this.next().start;
          if (this.peek()?.kind === TokenKind.AsmBlock) return this.parseAsmBlock(start);
          // The lexer only emits a block token when a `{` follows.
          this.error("expected '{' after 'asm6502'", this.peek());
          return null;
        }
        default:
          break;
      }
    }

    if (token.text === '{') return this.parseBlock();
    if (token.text === ';') {
      this.next();
      return null;
    }

    // An element as a statement (spec §95): the lexer already decided this
    // `<` opens a tag, so there is nothing to disambiguate here.
    if (token.kind === TokenKind.BxTagOpen) {
      const element = this.parseBxElement();
      if (!this.at(';') && !this.at('}') && !this.atEnd) this.eat(';');
      else this.eat(';');
      return element;
    }

    return this.parseExpressionStatement();
  }

  // ---- 8BX elements ------------------------------------------------------
  //
  // Token-driven, over the lexer's tag/children/expression modes: every
  // span is a token's, so a diagnostic inside `{…}` points into the file.
  // The parser never throws on a half-typed tag; each `expect*` records
  // what it found and moves on (§90).

  atKind(kind) {
    return this.peek()?.kind === kind;
  }

  bxError(message, token = this.peek()) {
    const start = token ? token.start : this.endOffset;
    const length = token ? token.length : 0;
    this.diagnostics.push(diagnostic(Codes.BX_SYNTAX, message, this.file, start, length));
  }

  /** `Foo` or `Foo.Bar` (spec §25): the dotted name as one string, spanning its tokens. */
  parseBxName(what) {
    const first = this.peek();
    if (first?.kind !== TokenKind.Identifier) {
      this.bxError(`expected ${what}, found ${this.describe(first)}`, first);
      return null;
    }
    this.next();
    let name = first.text;
    let end = first.start + first.length;
    while (this.at('.') && this.peek(1)?.kind === TokenKind.Identifier) {
      this.next();
      const part = this.next();
      name += `.${part.text}`;
      end = part.start + part.length;
    }
    return { name, start: first.start, end };
  }

  /**
   * `{ expression }` in a tag or between tags. `{}` and `{ /* … *\/ }` (the
   * comment is already gone from the token stream) are an empty field —
   * a child comment, which elaboration drops. Returns the expression (or
   * null for an empty field) and the span of the braces.
   */
  parseBxBraces() {
    const open = this.next(); // `{`
    let expression = null;
    if (!this.at('}')) expression = this.parseExpression();
    const close = this.peek();
    if (this.at('}')) this.next();
    else this.bxError(`expected '}' to close the expression, found ${this.describe(close)}`, close);
    const end = close?.text === '}' ? close.start + close.length : (expression ? expression.start + expression.length : open.start + open.length);
    return { expression, start: open.start, end };
  }

  /**
   * One element or fragment, from its BxTagOpen to its `/>` or closing tag.
   * Text children are normalized here, once, the way the spec's §35 says:
   * lines trimmed, blank lines dropped, the rest joined with one space; a
   * run that is only whitespace is no child at all.
   */
  parseBxElement() {
    const open = this.next(); // BxTagOpen
    const start = open.start;

    // Fragment: `<>` … `</>`.
    if (this.atKind(TokenKind.BxTagEnd)) {
      this.next();
      const children = this.parseBxChildren(null, start);
      return node(NodeType.BxFragment, start, children.end, { children: children.nodes });
    }

    const named = this.parseBxName('a component name after <');
    if (!named) {
      this.recoverBxTag();
      return null;
    }
    const { name } = named;

    const attributes = [];
    for (;;) {
      const t = this.peek();
      if (!t) {
        this.bxError(`unterminated <${name}>: expected '>' or '/>'`);
        return node(NodeType.BxElement, start, this.endOffset, { name, attributes, children: [], selfClosing: true });
      }
      if (t.kind === TokenKind.BxSelfClose) {
        this.next();
        return node(NodeType.BxElement, start, t.start + t.length, { name, attributes, children: [], selfClosing: true });
      }
      if (t.kind === TokenKind.BxTagEnd) {
        this.next();
        const children = this.parseBxChildren(name, start);
        return node(NodeType.BxElement, start, children.end, { name, attributes, children: children.nodes, selfClosing: false });
      }
      if (t.text === '{') {
        const spread = this.parseBxBraces();
        attributes.push(node(NodeType.BxSpreadAttribute, spread.start, spread.end, { expression: spread.expression }));
        continue;
      }
      if (t.kind === TokenKind.Identifier) {
        this.next();
        let value;
        let end = t.start + t.length;
        if (this.at('=')) {
          this.next();
          const v = this.peek();
          if (v?.text === '{') {
            const braces = this.parseBxBraces();
            value = braces.expression;
            end = braces.end;
          } else if (v?.kind === TokenKind.String) {
            this.next();
            // A string attribute is an ordinary string literal (spec §18).
            value = node(NodeType.StringLiteral, v.start, v.start + v.length, { value: v.text.slice(1, v.unterminated ? undefined : -1) });
            end = v.start + v.length;
          } else {
            this.bxError(`expected a string or {expression} after ${t.text}=, found ${this.describe(v)}`, v);
            value = null;
          }
        } else {
          // A bare attribute is `true` (spec §31).
          value = node(NodeType.BooleanLiteral, t.start, end, { value: true });
        }
        attributes.push(node(NodeType.BxAttribute, t.start, end, { name: t.text, value }));
        continue;
      }
      // The lexer reports a stray character in a tag; whatever token came
      // of it is skipped so the tag can still close.
      this.bxError(`unexpected ${this.describe(t)} in <${name}>`, t);
      this.next();
    }
  }

  /**
   * The children of an element (or fragment when `name` is null), up to
   * and including its closing tag. Returns the child nodes and the offset
   * just past the closing tag.
   */
  parseBxChildren(name, start) {
    const nodes = [];
    for (;;) {
      const t = this.peek();
      if (!t) {
        this.bxError(name ? `unclosed element <${name}>: expected </${name}>` : 'unclosed fragment: expected </>', null);
        return { nodes, end: this.endOffset };
      }
      if (t.kind === TokenKind.BxClosingTagOpen) {
        this.next();
        const closeStart = t.start;
        let end = t.start + t.length;
        if (name === null) {
          if (!this.atKind(TokenKind.BxTagEnd)) this.bxError(`expected </> to close the fragment, found ${this.describe(this.peek())}`);
        } else {
          const closing = this.peek()?.kind === TokenKind.Identifier ? this.parseBxName('a closing tag name') : null;
          if (!closing) this.bxError(`expected </${name}>, found ${this.describe(this.peek())}`);
          else if (closing.name !== name) {
            this.diagnostics.push(diagnostic(Codes.BX_SYNTAX, `expected </${name}>, found </${closing.name}>`, this.file, closing.start, closing.end - closing.start));
          }
        }
        if (this.atKind(TokenKind.BxTagEnd)) {
          const gt = this.next();
          end = gt.start + gt.length;
        } else {
          this.bxError(`expected '>' after </${name ?? ''}`, this.peek());
          end = closeStart + t.length;
        }
        return { nodes, end };
      }
      if (t.kind === TokenKind.BxTagOpen) {
        const child = this.parseBxElement();
        if (child) nodes.push(child);
        continue;
      }
      if (t.kind === TokenKind.BxText) {
        this.next();
        const value = normalizeBxText(t.text);
        if (value) nodes.push(node(NodeType.BxText, t.start, t.start + t.length, { value, raw: t.text }));
        continue;
      }
      if (t.text === '{') {
        const braces = this.parseBxBraces();
        nodes.push(node(NodeType.BxExpressionChild, braces.start, braces.end, { expression: braces.expression }));
        continue;
      }
      // Something the lexer's children mode never produces; skip it rather than spin.
      this.bxError(`unexpected ${this.describe(t)} between tags`, t);
      this.next();
    }
  }

  /** After a tag that could not be named: skip to its end so parsing resumes after it. */
  recoverBxTag() {
    while (!this.atEnd) {
      const t = this.next();
      if (t.kind === TokenKind.BxSelfClose || t.kind === TokenKind.BxTagEnd) return;
    }
  }

  /** The block body is opaque: 6502 assembly, held verbatim for the backend. */
  parseAsmBlock(start) {
    const token = this.next();
    return node(NodeType.AsmBlock, start, token.start + token.length, { body: token.text });
  }

  parseDecorated() {
    const decorators = [];
    while (this.peek()?.kind === TokenKind.Decorator) {
      const token = this.next();
      let end = token.start + token.length;
      const args = [];
      if (this.at('(')) {
        this.next();
        while (!this.atEnd && !this.at(')')) {
          const argument = this.parseExpression();
          if (!argument) break;
          args.push(argument);
          if (!this.eat(',')) break;
        }
        const close = this.expect(')');
        if (close) end = close.start + close.length;
      }
      decorators.push(
        node(NodeType.Decorator, token.start, end, { name: token.text.slice(1), args }),
      );
    }

    const target = this.parseStatement();
    if (target) target.decorators = decorators;
    return target;
  }

  parseImport() {
    const start = this.next().start;
    const specifiers = [];

    if (this.at('{')) {
      this.next();
      while (!this.atEnd && !this.at('}')) {
        const name = this.expectIdentifier('an imported name');
        if (!name) break;
        let local = null;
        if (this.atKeyword('as')) {
          this.next();
          local = this.expectIdentifier('a local name');
        }
        specifiers.push(local ? { ...name, imported: name.name, name: local.name } : name);
        if (!this.eat(',')) break;
      }
      this.expect('}');
      if (!this.atKeyword('from')) this.error("expected 'from'", this.peek());
      else this.next();
    }

    const sourceToken = this.peek();
    let source = null;
    if (sourceToken?.kind === TokenKind.String) {
      this.next();
      source = node(NodeType.StringLiteral, sourceToken.start, sourceToken.start + sourceToken.length, {
        value: sourceToken.text.slice(1, -1),
      });
    } else {
      this.error(`expected a module specifier, found ${this.describe(sourceToken)}`, sourceToken);
    }

    const end = this.eat(';') ? this.tokens[this.pos - 1].start + 1 : (source?.start ?? start);
    return node(NodeType.ImportDeclaration, start, end, { specifiers, source });
  }

  parseExport() {
    const start = this.next().start;
    if (this.atKeyword('function')) return this.parseFunctionDeclaration(start, true);
    if (this.atKeyword('component')) return this.parseComponentDeclaration(start, true);
    if (this.atKeyword('namespace')) return this.parseNamespace(start, true);
    if (this.atKeyword('let') || this.atKeyword('const')) {
      const declaration = this.parseVariableDeclaration(start);
      if (declaration) declaration.exported = true;
      return declaration;
    }
    this.error(`expected a declaration after 'export', found ${this.describe(this.peek())}`);
    this.synchronize();
    return null;
  }

  /**
   * `namespace screen { function setBorderColor(...): void { ... } }`.
   *
   * A namespace is compile-time-only qualification, not a struct or a value:
   * its members compile straight to ordinary functions and inlined
   * constants, and calling `screen.setBorderColor(...)` is exactly as cheap
   * as calling a plain function with that name would be. Members are written
   * without their own `export` — the namespace itself is the unit that is or
   * isn't visible to other modules.
   */
  parseNamespace(start, exported) {
    this.next(); // 'namespace'
    const name = this.expectIdentifier('a namespace name');
    const members = [];
    if (this.expect('{')) {
      while (!this.atEnd && !this.at('}')) {
        const before = this.pos;
        if (this.atKeyword('function')) {
          const token = this.peek();
          members.push(this.parseFunctionDeclaration(token.start, false));
        } else if (this.atKeyword('let') || this.atKeyword('const')) {
          members.push(this.parseVariableDeclaration());
        } else {
          this.error(`expected a function or const inside a namespace, found ${this.describe(this.peek())}`);
        }
        if (this.pos === before) this.next();
      }
    }
    const close = this.expect('}');
    const end = close ? close.start + 1 : this.endOffset;
    return node(NodeType.NamespaceDeclaration, start, end, { name, members, exported });
  }

  parseVariableDeclaration(startOverride = null) {
    const keyword = this.next();
    const start = startOverride ?? keyword.start;
    const name = this.expectIdentifier('a variable name');
    if (!name) {
      this.synchronize();
      return null;
    }

    let typeAnnotation = null;
    if (this.eat(':')) typeAnnotation = this.parseType();

    let initializer = null;
    if (this.eat('=')) initializer = this.parseExpression();

    const end = this.eat(';')
      ? this.tokens[this.pos - 1].start + 1
      : (initializer ?? typeAnnotation ?? name).start
        + (initializer ?? typeAnnotation ?? name).length;

    return node(NodeType.VariableDeclaration, start, end, {
      kind: keyword.text,
      name,
      typeAnnotation,
      initializer,
      exported: false,
    });
  }

  parseComponentDeclaration(start, exported) {
    this.next(); // 'component'
    const name = this.expectIdentifier('a component name');
    const params = [];
    if (this.expect('(')) {
      while (!this.atEnd && !this.at(')')) {
        const paramName = this.expectIdentifier('a parameter name');
        if (!paramName) break;
        let paramType = null;
        if (this.eat(':')) paramType = this.parseType();
        let defaultValue = null;
        if (this.eat('=')) defaultValue = this.parseExpression();
        const last = defaultValue ?? paramType ?? paramName;
        const pEnd = last.start + last.length;
        params.push(node(NodeType.Parameter, paramName.start, pEnd, {
          name: paramName, typeAnnotation: paramType, defaultValue,
          optional: defaultValue != null,
        }));
        if (!this.eat(',')) break;
      }
      this.expect(')');
    }
    const body = this.parseBlock();
    // Element children go where the body says `<slot />` (spec §33); a
    // parameter named `children` is the separate declaration that the
    // component accepts *text* children (§35).
    const allowsChildren = (body?.body ?? []).some((s) => s.type === NodeType.BxElement && s.name === 'slot');
    const end = body ? body.start + body.length : start;
    return node(NodeType.ComponentDeclaration, start, end, {
      name, params, body, exported, allowsChildren,
    });
  }

  parseFunctionDeclaration(start, exported) {
    this.next(); // 'function'
    const name = this.expectIdentifier('a function name');
    const params = [];

    if (this.expect('(')) {
      while (!this.atEnd && !this.at(')')) {
        const paramName = this.expectIdentifier('a parameter name');
        if (!paramName) break;
        let paramType = null;
        if (this.eat(':')) paramType = this.parseType();
        // `border: utinyint = BorderColor.BLACK`: a default, a compile-time
        // value the call site gets when the argument is left off.
        let defaultValue = null;
        if (this.eat('=')) defaultValue = this.parseExpression();
        const last = defaultValue ?? paramType ?? paramName;
        const pEnd = last.start + last.length;
        params.push(node(NodeType.Parameter, paramName.start, pEnd, {
          name: paramName, typeAnnotation: paramType, defaultValue,
        }));
        if (!this.eat(',')) break;
      }
      this.expect(')');
    }

    let returnType = null;
    if (this.eat(':')) returnType = this.parseType();

    const body = this.at('{') ? this.parseBlock() : null;
    if (!body) this.error("expected a function body", this.peek());

    const end = body ? body.start + body.length : this.endOffset;
    return node(NodeType.FunctionDeclaration, start, end, {
      name, params, returnType, body, exported,
    });
  }

  parseBlock() {
    const open = this.expect('{');
    const start = open ? open.start : this.peek()?.start ?? this.endOffset;
    const body = [];
    while (!this.atEnd && !this.at('}')) {
      const before = this.pos;
      const statement = this.parseStatement();
      if (statement) body.push(statement);
      if (this.pos === before) {
        this.error(`unexpected ${this.describe(this.peek())}`);
        this.next();
      }
    }
    const close = this.expect('}');
    const end = close ? close.start + 1 : this.endOffset;
    return node(NodeType.BlockStatement, start, end, { body });
  }

  parseIf() {
    const start = this.next().start;
    this.expect('(');
    const test = this.parseExpression();
    this.expect(')');
    const consequent = this.parseStatement();
    let alternate = null;
    if (this.atKeyword('else')) {
      this.next();
      alternate = this.parseStatement();
    }
    const last = alternate ?? consequent;
    const end = last ? last.start + last.length : this.endOffset;
    return node(NodeType.IfStatement, start, end, { test, consequent, alternate });
  }

  parseWhile() {
    const start = this.next().start;
    this.expect('(');
    const test = this.parseExpression();
    this.expect(')');
    const body = this.parseStatement();
    const end = body ? body.start + body.length : this.endOffset;
    return node(NodeType.WhileStatement, start, end, { test, body });
  }

  parseFor() {
    const start = this.next().start;
    this.expect('(');
    const init = this.at(';') ? null : this.parseStatementLikeInit();
    this.eat(';');
    const test = this.at(';') ? null : this.parseExpression();
    this.expect(';');
    const update = this.at(')') ? null : this.parseExpression();
    this.expect(')');
    const body = this.parseStatement();
    const end = body ? body.start + body.length : this.endOffset;
    return node(NodeType.ForStatement, start, end, { init, test, update, body });
  }

  /** A `for` initializer is either a declaration or a bare expression. */
  parseStatementLikeInit() {
    if (this.atKeyword('let') || this.atKeyword('const')) {
      const keyword = this.next();
      const name = this.expectIdentifier('a variable name');
      let typeAnnotation = null;
      if (this.eat(':')) typeAnnotation = this.parseType();
      let initializer = null;
      if (this.eat('=')) initializer = this.parseExpression();
      const last = initializer ?? typeAnnotation ?? name;
      const end = last ? last.start + last.length : keyword.start + keyword.length;
      return node(NodeType.VariableDeclaration, keyword.start, end, {
        kind: keyword.text, name, typeAnnotation, initializer, exported: false,
      });
    }
    return this.parseExpression();
  }

  parseReturn() {
    const keyword = this.next();
    const argument = this.at(';') || this.at('}') ? null : this.parseExpression();
    const end = this.eat(';')
      ? this.tokens[this.pos - 1].start + 1
      : argument
        ? argument.start + argument.length
        : keyword.start + keyword.length;
    return node(NodeType.ReturnStatement, keyword.start, end, { argument });
  }

  parseBreakOrContinue() {
    const keyword = this.next();
    const end = this.eat(';') ? this.tokens[this.pos - 1].start + 1 : keyword.start + keyword.length;
    const type = keyword.text === 'break' ? NodeType.BreakStatement : NodeType.ContinueStatement;
    return node(type, keyword.start, end, {});
  }

  parseExpressionStatement() {
    const expression = this.parseExpression();
    if (!expression) {
      this.synchronize();
      return null;
    }
    const end = this.eat(';')
      ? this.tokens[this.pos - 1].start + 1
      : expression.start + expression.length;
    return node(NodeType.ExpressionStatement, expression.start, end, { expression });
  }

  // ---- types --------------------------------------------------------------

  /** `u8`, `ptr<u8>`, `array<u8, 16>`, `volatile<u8>`. */
  parseType() {
    const token = this.peek();
    if (!token || (token.kind !== TokenKind.Type && token.kind !== TokenKind.Identifier)) {
      this.error(`expected a type, found ${this.describe(token)}`, token);
      return null;
    }
    this.next();
    let end = token.start + token.length;
    const typeArguments = [];

    if (this.at('<')) {
      this.next();
      while (!this.atEnd && !this.at('>')) {
        const argToken = this.peek();
        // An array length is a value, not a type: `array<u8, 16>`. A decimal
        // literal (`array<u8, 0.5>`) is never a valid length — fall through
        // to parseType() below, which reports a plain "expected a type"
        // diagnostic instead of building a bogus IntegerLiteral from a
        // fractional token's integer-only fields.
        if (argToken?.kind === TokenKind.Number && !argToken.isDecimal) {
          this.next();
          typeArguments.push(
            node(NodeType.IntegerLiteral, argToken.start, argToken.start + argToken.length, {
              value: argToken.value, raw: argToken.text, radix: argToken.radix,
            }),
          );
        } else {
          const inner = this.parseType();
          if (!inner) break;
          typeArguments.push(inner);
        }
        if (!this.eat(',')) break;
      }
      const close = this.expect('>');
      if (close) end = close.start + close.length;
    }

    return node(NodeType.TypeReference, token.start, end, { name: token.text, typeArguments });
  }

  // ---- expressions --------------------------------------------------------

  parseExpression() {
    return this.parseAssignment();
  }

  parseAssignment() {
    const left = this.parseConditional();
    if (!left) return null;
    const token = this.peek();
    if (token && ASSIGNMENT_OPERATORS.has(token.text)) {
      this.next();
      // Right-associative: `a = b = c` is `a = (b = c)`.
      const right = this.parseAssignment();
      const end = right ? right.start + right.length : token.start + token.length;
      return node(NodeType.AssignmentExpression, left.start, end, {
        operator: token.text, left, right,
      });
    }
    return left;
  }

  parseConditional() {
    const start = this.peek()?.start ?? 0;
    let expr = this.parseBinary(0);
    if (!expr) return null;
    if (this.at('?')) {
      this.next();
      const consequent = this.parseExpression();
      this.expect(':');
      const alternate = this.parseConditional();
      const end = alternate ? alternate.start + alternate.length : expr.start + expr.length;
      return node(NodeType.ConditionalExpression, start, end, { test: expr, consequent, alternate });
    }
    return expr;
  }

  /** Precedence climbing over the table above. */
  parseBinary(minPrecedence) {
    let left = this.parseUnary();
    if (!left) return null;

    for (;;) {
      const token = this.peek();
      const precedence = token ? BINARY_PRECEDENCE[token.text] : undefined;
      if (precedence === undefined || precedence < minPrecedence) return left;
      this.next();
      const right = this.parseBinary(precedence + 1);
      if (!right) return left;
      left = node(NodeType.BinaryExpression, left.start, right.start + right.length, {
        operator: token.text, left, right,
      });
    }
  }

  parseUnary() {
    const token = this.peek();
    if (token && ['!', '~', '-', '+'].includes(token.text)) {
      this.next();
      const argument = this.parseUnary();
      if (!argument) return null;
      return node(NodeType.UnaryExpression, token.start, argument.start + argument.length, {
        operator: token.text, argument,
      });
    }
    if (token && ['++', '--'].includes(token.text)) {
      this.next();
      const argument = this.parseUnary();
      if (!argument) return null;
      return node(NodeType.UpdateExpression, token.start, argument.start + argument.length, {
        operator: token.text, argument, prefix: true,
      });
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let expression = this.parsePrimary();
    if (!expression) return null;

    for (;;) {
      const token = this.peek();
      if (!token) return expression;

      if (token.text === '.') {
        this.next();
        const property = this.expectIdentifier('a property name');
        if (!property) return expression;
        expression = node(NodeType.MemberExpression, expression.start,
          property.start + property.length, { object: expression, property });
        continue;
      }

      if (token.text === '[') {
        this.next();
        const index = this.parseExpression();
        const close = this.expect(']');
        const end = close ? close.start + 1 : expression.start + expression.length;
        expression = node(NodeType.IndexExpression, expression.start, end, {
          object: expression, index,
        });
        continue;
      }

      if (token.text === '(') {
        this.next();
        const args = [];
        while (!this.atEnd && !this.at(')')) {
          const argument = this.parseExpression();
          if (!argument) break;
          args.push(argument);
          if (!this.eat(',')) break;
        }
        const close = this.expect(')');
        const end = close ? close.start + 1 : expression.start + expression.length;
        expression = node(NodeType.CallExpression, expression.start, end, {
          callee: expression, args,
        });
        continue;
      }

      if (token.text === '++' || token.text === '--') {
        this.next();
        expression = node(NodeType.UpdateExpression, expression.start,
          token.start + token.length, { operator: token.text, argument: expression, prefix: false });
        continue;
      }

      return expression;
    }
  }

  /**
   * `\`TICK ${ticks % 10:1} OPTION ${option}\``: the lexer handed over one
   * token with the spans of its text runs and `${...}` fields; each field's
   * source is re-lexed here (its offsets shifted back into the file, so a
   * diagnostic inside a field lands on the right characters) and parsed as
   * an ordinary expression, followed by an optional `:width` — an integer
   * literal saying how many cells the field takes. `:` is not a binary
   * operator in this grammar, so the expression parser stops at it by
   * itself.
   */
  parseTemplate(token) {
    const parts = [];
    for (const part of token.parts) {
      if (part.kind === 'text') {
        parts.push(node(NodeType.TemplateText, part.start, part.end, {
          value: this.text.slice(part.start, part.end),
        }));
        continue;
      }
      const source = this.text.slice(part.sourceStart, part.sourceEnd);
      const { tokens, diagnostics } = tokenize(source, this.file);
      for (const t of tokens) t.start += part.sourceStart;
      for (const d of diagnostics) d.start += part.sourceStart;
      this.diagnostics.push(...diagnostics);
      const inner = new Parser(tokens, this.text, this.file);
      inner.pos = 0;
      const expression = inner.parseExpression();
      let width = null;
      if (expression && inner.eat(':')) {
        const widthToken = inner.peek();
        if (widthToken?.kind === TokenKind.Number && !widthToken.isDecimal) {
          inner.next();
          width = node(NodeType.IntegerLiteral, widthToken.start, widthToken.start + widthToken.length, {
            value: widthToken.value, raw: widthToken.text, radix: widthToken.radix,
          });
        } else {
          inner.error(`expected a field width after ':', found ${inner.describe(widthToken)}`, widthToken);
          inner.pos = inner.tokens.length; // reported once; don't also flag the rest as junk
        }
      }
      if (expression && !inner.atEnd) {
        inner.error(`unexpected ${inner.describe(inner.peek())} in template field`);
      }
      this.diagnostics.push(...inner.diagnostics);
      if (!expression) continue;
      parts.push(node(NodeType.TemplateField, part.start, part.end, { expression, width }));
    }
    return node(NodeType.TemplateLiteral, token.start, token.start + token.length, { parts });
  }

  parsePrimary() {
    const token = this.peek();
    if (!token) {
      this.error('expected an expression, found end of file');
      return null;
    }
    // An element where a value is expected — the arm of a `?:` in an
    // expression child, for one (spec §48). Parsed for its spans; what it
    // may mean there is the checker's and the elaborator's to say (§94).
    if (token.kind === TokenKind.BxTagOpen) return this.parseBxElement();
    const end = token.start + token.length;

    if (token.kind === TokenKind.Number) {
      this.next();
      if (token.isDecimal) {
        return node(NodeType.DecimalLiteral, token.start, end, {
          numerator: token.numerator, denominator: token.denominator, raw: token.text,
        });
      }
      return node(NodeType.IntegerLiteral, token.start, end, {
        value: token.value, raw: token.text, radix: token.radix,
      });
    }

    if (token.kind === TokenKind.String) {
      this.next();
      return node(NodeType.StringLiteral, token.start, end, {
        value: token.text.slice(1, -1),
        // Already reported by the lexer; the checker leaves its text alone.
        ...(token.unterminated ? { unterminated: true } : {}),
      });
    }

    if (token.kind === TokenKind.Template) {
      this.next();
      return this.parseTemplate(token);
    }

    if (token.kind === TokenKind.Keyword && (token.text === 'true' || token.text === 'false')) {
      this.next();
      return node(NodeType.BooleanLiteral, token.start, end, { value: token.text === 'true' });
    }

    // A type name in expression position is a plain identifier, e.g. a call.
    if (token.kind === TokenKind.Identifier || token.kind === TokenKind.Type) {
      this.next();
      return node(NodeType.Identifier, token.start, end, { name: token.text });
    }

    // `#frames`: an identifier the compiler evaluates (the fold pass consumes
    // it as a call; one left over anywhere else is that pass's diagnostic).
    if (token.kind === TokenKind.CompileTime) {
      this.next();
      return node(NodeType.Identifier, token.start, end, { name: token.text.slice(1), compileTime: true });
    }

    if (token.text === '(') {
      this.next();
      const inner = this.parseExpression();
      this.expect(')');
      return inner;
    }

    // `[1, 2, 3]`: an array initializer. A trailing comma is allowed, as in
    // TypeScript, so a table one value per line can end every line alike.
    if (token.text === '[') {
      this.next();
      const elements = [];
      while (!this.atEnd && !this.at(']')) {
        const element = this.parseExpression();
        if (!element) break;
        elements.push(element);
        if (!this.eat(',')) break;
      }
      const close = this.expect(']');
      const last = elements[elements.length - 1];
      const literalEnd = close ? close.start + 1 : (last ? last.start + last.length : end);
      return node(NodeType.ArrayLiteral, token.start, literalEnd, { elements });
    }

    this.error(`expected an expression, found ${this.describe(token)}`, token);
    return null;
  }
}

/**
 * Parse a token stream.
 *
 * Always returns both an AST and diagnostics; never throws.
 *
 * @param {object[]} tokens
 * @param {string} text
 * @param {string} file
 * @returns {{ ast: object, diagnostics: object[] }}
 */
export function parse(tokens, text, file = '<unknown>', options = {}) {
  const parser = new Parser(tokens, text, file, options);
  const ast = parser.parseProgram();
  return { ast, diagnostics: parser.diagnostics };
}
