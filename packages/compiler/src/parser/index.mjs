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
import { TokenKind } from '../lexer/index.mjs';
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
  'let', 'const', 'function', 'export', 'import', 'return',
  'if', 'while', 'for', 'break', 'continue', 'asm6502', 'namespace',
]);

class Parser {
  constructor(tokens, text, file) {
    // Comments carry no syntax. Dropping them here keeps every rule below free
    // of "skip trivia" noise.
    this.tokens = tokens.filter((t) => t.kind !== TokenKind.Comment);
    this.text = text;
    this.file = file;
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

    return this.parseExpressionStatement();
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
        const pEnd = (paramType ?? paramName).start + (paramType ?? paramName).length;
        params.push(node(NodeType.Parameter, paramName.start, pEnd, {
          name: paramName, typeAnnotation: paramType,
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

  /** A `for` initialiser is either a declaration or a bare expression. */
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
        // An array length is a value, not a type: `array<u8, 16>`.
        if (argToken?.kind === TokenKind.Number) {
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
    const left = this.parseBinary(0);
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

  parsePrimary() {
    const token = this.peek();
    if (!token) {
      this.error('expected an expression, found end of file');
      return null;
    }
    const end = token.start + token.length;

    if (token.kind === TokenKind.Number) {
      this.next();
      return node(NodeType.IntegerLiteral, token.start, end, {
        value: token.value, raw: token.text, radix: token.radix,
      });
    }

    if (token.kind === TokenKind.String) {
      this.next();
      return node(NodeType.StringLiteral, token.start, end, { value: token.text.slice(1, -1) });
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

    if (token.text === '(') {
      this.next();
      const inner = this.parseExpression();
      this.expect(')');
      return inner;
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
export function parse(tokens, text, file = '<unknown>') {
  const parser = new Parser(tokens, text, file);
  const ast = parser.parseProgram();
  return { ast, diagnostics: parser.diagnostics };
}
