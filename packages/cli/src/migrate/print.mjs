// The converter's printer: old-syntax JS AST in, new Rust-style `.8bs` text
// out (notes/features/8bs-syntax-spec.md section 2; converter rules in
// notes/port/p3-frontend-spec.md section 5). Throwaway: it ships once as
// `8bs migrate` and is deleted after the flip.
//
// Mutability (`let` vs `let mut`) is decided by a scope-aware assignment scan
// over the AST (`analyzeMutability` below), not by the binder: the binder
// records declarations only and never resolves a use to its declaration. The
// scan marks a `let` as `mut` when it is the target of an assignment, an
// update, or an indexed store, and also, counted separately as "ambiguous",
// when the scan cannot prove it is never changed: an exported `let` (another
// module may assign it), a name that appears in an `asm6502` block, and an
// array, pointer or string variable that is used as a bare value (it may be
// written through a copy).
import { NodeType, TokenKind, parse, tokenize, walk } from '@8bitscript/compiler';

const INDENT = '    ';

/** Binary operator precedence, loosest first: the old table (`parser/index.mjs`). */
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
const COMPARISONS = new Set(['==', '!=', '<', '>', '<=', '>=']);
const BITWISE = new Set(['&', '|', '^']);
const UNARY_LEVEL = 11;
const POSTFIX_LEVEL = 12;
const PRIMARY_LEVEL = 13;

/** Words that are keywords or reserved in the new syntax (syntax spec 5). */
const NEW_KEYWORDS = new Set([
  'as', 'break', 'const', 'continue', 'crate', 'else', 'false', 'fn', 'for', 'if', 'in', 'let', 'loop',
  'match', 'mod', 'mut', 'pub', 'return', 'self', 'super', 'true', 'use', 'while', 'asm6502',
  'enum', 'impl', 'struct', 'trait', 'static', 'type',
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOURCE_EXTENSION = /\.(?:8bs|8bx|8bg|8ba)$/;
const ARRAYISH_TYPES = new Set(['array', 'ptr', 'string']);

/** A construct the printer has no new-syntax spelling for. */
export class UnsupportedError extends Error {
  constructor(kind, message, line = 0, column = 0) {
    super(line ? `${message} (line ${line})` : message);
    this.name = 'UnsupportedError';
    this.kind = kind;
    this.line = line;
    this.column = column;
  }
}

/** The input is not valid old-syntax source. */
export class OldSyntaxError extends Error {
  constructor(diagnostics) {
    super(`does not parse as old syntax: ${diagnostics[0]?.message ?? 'unknown error'}`);
    this.name = 'OldSyntaxError';
    this.diagnostics = diagnostics;
  }
}

const isIdentifier = (word) => IDENTIFIER.test(word) && !NEW_KEYWORDS.has(word);

/** A name as the new syntax spells it: a keyword becomes a raw identifier. */
export const spellName = (name) => (NEW_KEYWORDS.has(name) ? `r#${name}` : name);

const countNewlines = (text) => {
  let n = 0;
  for (const c of text) if (c === '\n') n += 1;
  return n;
};

const startOf = (n) => (n.decorators?.length ? Math.min(n.decorators[0].start, n.start) : n.start);
const endOf = (n) => n.start + n.length;

/** `./a/b` to `self::a::b`; null when no path spelling exists. */
export function usePathOf(specifier, aliasHeads = []) {
  const parts = specifier.split('/');
  const relative = parts[0] === '.' || parts[0] === '..';
  const scoped = /^@[A-Za-z0-9_-]+$/.test(parts[0]);
  const hasExtension = SOURCE_EXTENSION.test(specifier);
  // The extension search belongs to relative and alias specifiers; a package
  // specifier is looked up as written, so one with an extension keeps its string.
  if (hasExtension && !relative && !aliasHeads.includes(parts[0])) return null;
  const last = parts.length - 1;
  const segments = parts.map((p, i) => (i === last ? p.replace(SOURCE_EXTENSION, '') : p));
  let head;
  let rest;
  if (segments[0] === '.') {
    head = ['self'];
    rest = segments.slice(1);
  } else if (segments[0] === '..') {
    let i = 0;
    while (segments[i] === '..') i += 1;
    head = Array(i).fill('super');
    rest = segments.slice(i);
  } else if (scoped) {
    head = [segments[0]];
    rest = segments.slice(1);
  } else if (isIdentifier(segments[0])) {
    head = [segments[0]];
    rest = segments.slice(1);
  } else {
    return null;
  }
  if (relative && rest.length === 0) return null;
  if (!rest.every(isIdentifier)) return null;
  return [...head, ...rest].join('::');
}

// ---- mutability --------------------------------------------------------

/**
 * Which `let` declarations need `mut`. Returns a map from the declaration
 * node to the reason: `assigned` (a proven store) or an ambiguous reason
 * (`exported`, `asm`, `value`).
 *
 * @param {object} ast
 */
export function analyzeMutability(ast) {
  const reasons = new Map();
  const mark = (decl, reason) => {
    if (decl && !reasons.has(decl)) reasons.set(decl, reason);
  };
  const asmWords = new Set();
  const letDecls = [];
  walk(ast, (n) => {
    if (n.type === NodeType.AsmBlock) for (const w of n.body.match(/[A-Za-z_]\w*/g) ?? []) asmWords.add(w);
    if (n.type === NodeType.VariableDeclaration && n.kind === 'let') letDecls.push(n);
  });

  const newScope = (parent) => ({ parent, names: new Map() });
  const lookup = (scope, name) => {
    for (let s = scope; s; s = s.parent) {
      const hit = s.names.get(name);
      if (hit) return hit;
    }
    return null;
  };
  const declareVariable = (scope, decl) => {
    if (decl.name) scope.names.set(decl.name.name, { kind: decl.kind, decl });
  };
  // Module-level names are visible everywhere in the file, in any order.
  const hoist = (scope, body) => {
    for (const s of body ?? []) {
      if (s?.type === NodeType.VariableDeclaration) declareVariable(scope, s);
      else if (s?.type === NodeType.NamespaceDeclaration && s.name) {
        const members = newScope(scope);
        hoist(members, s.members);
        scope.names.set(s.name.name, { kind: 'namespace', members, node: s });
      } else if (s?.name) scope.names.set(s.name.name, { kind: 'other' });
      else if (s?.type === NodeType.ImportDeclaration) {
        for (const spec of s.specifiers) scope.names.set(spec.name, { kind: 'other' });
      }
    }
  };

  /** The declared `let` a store target writes to, or null. */
  const targetOf = (scope, target) => {
    let n = target;
    while (n?.type === NodeType.IndexExpression) n = n.object;
    if (n?.type === NodeType.MemberExpression && n.object.type === NodeType.Identifier) {
      const ns = lookup(scope, n.object.name);
      const member = ns?.kind === 'namespace' ? ns.members.names.get(n.property.name) : null;
      return member?.kind === 'let' ? member.decl : null;
    }
    if (n?.type === NodeType.Identifier) {
      const hit = lookup(scope, n.name);
      return hit?.kind === 'let' ? hit.decl : null;
    }
    return null;
  };

  const visitExpression = (scope, root) => {
    if (!root) return;
    walk(root, (n, parent) => {
      if (n.type === NodeType.AssignmentExpression) mark(targetOf(scope, n.left), 'assigned');
      else if (n.type === NodeType.UpdateExpression) mark(targetOf(scope, n.argument), 'assigned');
      else if (n.type === NodeType.Identifier && !n.compileTime) {
        const isObject = (parent?.type === NodeType.IndexExpression || parent?.type === NodeType.MemberExpression)
          && parent.object === n;
        const isStoreTarget = parent?.type === NodeType.AssignmentExpression && parent.left === n;
        const isProperty = parent?.type === NodeType.MemberExpression && parent.property === n;
        if (isObject || isStoreTarget || isProperty) return;
        const hit = lookup(scope, n.name);
        if (hit?.kind === 'let' && ARRAYISH_TYPES.has(hit.decl.typeAnnotation?.name)) mark(hit.decl, 'value');
      }
    });
  };

  const visitStatements = (scope, body) => {
    for (const s of body ?? []) visitStatement(scope, s);
  };
  function visitStatement(scope, s) {
    if (!s) return;
    switch (s.type) {
      case NodeType.VariableDeclaration:
      case NodeType.StateDeclaration:
        visitExpression(scope, s.initializer);
        declareVariable(scope, s);
        break;
      case NodeType.FunctionDeclaration:
      case NodeType.ComponentDeclaration: {
        const fnScope = newScope(scope);
        for (const p of s.params) fnScope.names.set(p.name.name, { kind: 'param' });
        for (const p of s.params) visitExpression(fnScope, p.defaultValue);
        visitStatement(fnScope, s.body);
        break;
      }
      case NodeType.NamespaceDeclaration: {
        const ns = lookup(scope, s.name?.name);
        const members = ns?.members ?? scope;
        for (const m of s.members) visitStatement(members, m);
        break;
      }
      case NodeType.BlockStatement:
        visitStatements(newScope(scope), s.body);
        break;
      case NodeType.IfStatement:
        visitExpression(scope, s.test);
        visitStatement(newScope(scope), s.consequent);
        visitStatement(newScope(scope), s.alternate);
        break;
      case NodeType.WhileStatement:
        visitExpression(scope, s.test);
        visitStatement(newScope(scope), s.body);
        break;
      case NodeType.ForStatement: {
        const forScope = newScope(scope);
        if (s.init?.type === NodeType.VariableDeclaration) visitStatement(forScope, s.init);
        else visitExpression(forScope, s.init);
        visitExpression(forScope, s.test);
        visitExpression(forScope, s.update);
        visitStatement(newScope(forScope), s.body);
        break;
      }
      case NodeType.ReturnStatement:
        visitExpression(scope, s.argument);
        break;
      case NodeType.ExpressionStatement:
        visitExpression(scope, s.expression);
        break;
      case NodeType.BxElement:
      case NodeType.BxFragment:
        visitExpression(scope, s);
        break;
      default:
        break;
    }
  }

  const moduleScope = newScope(null);
  hoist(moduleScope, ast.body);
  visitStatements(moduleScope, ast.body);

  for (const decl of letDecls) {
    if (decl.exported) mark(decl, 'exported');
    else if (decl.name && asmWords.has(decl.name.name)) mark(decl, 'asm');
  }
  return reasons;
}

/** Whether `body` stores to `name` (assignment or update, directly or through an index). */
function storesTo(root, name) {
  let found = false;
  walk(root, (n) => {
    const target = n.type === NodeType.AssignmentExpression ? n.left
      : n.type === NodeType.UpdateExpression ? n.argument : null;
    let t = target;
    while (t?.type === NodeType.IndexExpression) t = t.object;
    if (t?.type === NodeType.Identifier && t.name === name) found = true;
  });
  return found;
}

/** Whether an expression holds a record or a choice: both contain braces. */
function hasBraces(root) {
  let found = false;
  walk(root, (n) => {
    if (n.type === NodeType.RecordLiteral || n.type === NodeType.ConditionalExpression) found = true;
  });
  return found;
}

const levelOf = (n) => {
  switch (n.type) {
    case NodeType.AssignmentExpression:
    case NodeType.ConditionalExpression:
      return 0;
    case NodeType.BinaryExpression:
      return BINARY_PRECEDENCE[n.operator];
    case NodeType.UnaryExpression:
    case NodeType.UpdateExpression:
      return UNARY_LEVEL;
    case NodeType.CallExpression:
    case NodeType.MemberExpression:
    case NodeType.IndexExpression:
      return POSTFIX_LEVEL;
    default:
      return PRIMARY_LEVEL;
  }
};

// ---- printer ------------------------------------------------------------

class Printer {
  constructor(ast, tokens, text, options) {
    this.ast = ast;
    this.text = text;
    this.options = options;
    this.comments = tokens
      .filter((t) => t.kind === TokenKind.Comment)
      .map((t) => ({ start: t.start, end: t.start + t.length, text: t.text.replace(/\s+$/, '') }))
      .sort((a, b) => a.start - b.start);
    this.ci = 0;
    this.out = [];
    this.level = 0;
    this.prevEnd = null;
    this.fresh = true;
    this.mutable = analyzeMutability(ast);
    this.valueNames = new Set();
    walk(ast, (n) => {
      if (n.type === NodeType.VariableDeclaration || n.type === NodeType.StateDeclaration) {
        if (n.name) this.valueNames.add(n.name.name);
      } else if (n.type === NodeType.Parameter && n.name) {
        this.valueNames.add(n.name.name);
      }
    });
    this.stats = { letMut: 0, letPlain: 0, letAmbiguous: 0, comments: this.comments.length };
  }

  fail(kind, message, node) {
    const before = this.text.slice(0, node?.start ?? 0);
    const line = countNewlines(before) + 1;
    const column = (node?.start ?? 0) - (before.lastIndexOf('\n') + 1) + 1;
    throw new UnsupportedError(kind, message, line, column);
  }

  // ---- output ----

  emit(line) {
    this.out.push(`${INDENT.repeat(this.level)}${line}`);
    this.fresh = false;
  }

  /** Emit comments that start before `upTo`: trailing when on the previous item's line, else on their own. */
  emitComments(upTo) {
    while (this.ci < this.comments.length && this.comments[this.ci].start < upTo) {
      const c = this.comments[this.ci];
      this.ci += 1;
      const gap = this.prevEnd == null ? '\n' : this.text.slice(this.prevEnd, c.start);
      if (this.prevEnd != null && this.out.length > 0 && !gap.includes('\n')) {
        this.out[this.out.length - 1] += ` ${c.text}`;
      } else {
        if (!this.fresh && countNewlines(gap) >= 2 && this.out.at(-1) !== '') this.out.push('');
        this.emit(c.text);
      }
      this.prevEnd = c.end;
    }
  }

  /** Print a list of statements with their comments and one-blank-line gaps. */
  printList(statements, closeAt, openEnd) {
    this.fresh = true;
    this.prevEnd = openEnd;
    for (const s of statements) {
      const start = startOf(s);
      this.emitComments(start);
      if (!this.fresh && this.prevEnd != null && countNewlines(this.text.slice(this.prevEnd, start)) >= 2
        && this.out.at(-1) !== '') this.out.push('');
      this.statement(s);
      // Comments inside the statement that its own lists did not claim.
      const end = endOf(s);
      while (this.ci < this.comments.length && this.comments[this.ci].start < end) {
        this.emit(this.comments[this.ci].text);
        this.ci += 1;
      }
      this.prevEnd = end;
    }
    this.emitComments(closeAt);
    this.fresh = false;
  }

  /** `header {` list `}`, the closing brace left to the caller when `keepOpen`. */
  openBlock(header, body) {
    this.emit(header ? `${header} {` : "{");
    const isBlock = body?.type === NodeType.BlockStatement;
    const statements = isBlock ? body.body : (body ? [body] : []);
    this.level += 1;
    const saved = this.prevEnd;
    this.printList(statements, isBlock ? endOf(body) - 1 : (body ? endOf(body) : 0), isBlock ? body.start + 1 : null);
    this.prevEnd = saved;
    this.level -= 1;
  }

  block(header, body) {
    this.openBlock(header, body);
    this.emit('}');
  }

  // ---- statements ----

  statement(s) {
    const decorators = (s.decorators ?? []).map((d) => `#[${d.name}${d.args.length ? `(${d.args.map((a) => this.ex(a)).join(', ')})` : ''}] `).join('');
    switch (s.type) {
      case NodeType.ImportDeclaration:
        this.emit(this.importLine(s));
        break;
      case NodeType.VariableDeclaration:
        this.emit(`${decorators}${this.variable(s)};`);
        break;
      case NodeType.StateDeclaration:
        this.emit(`state ${spellName(s.name.name)}${this.typeSuffix(s.typeAnnotation)}${this.initSuffix(s.initializer)};`);
        break;
      case NodeType.FunctionDeclaration:
        this.block(`${decorators}${s.exported ? 'pub ' : ''}fn ${spellName(s.name.name)}(${this.params(s.params)})${this.returnSuffix(s.returnType)}`, s.body);
        break;
      case NodeType.ComponentDeclaration:
        this.block(`${decorators}${s.exported ? 'pub ' : ''}component ${spellName(s.name.name)}(${this.params(s.params)})`, s.body);
        break;
      case NodeType.NamespaceDeclaration:
        this.emit(`${decorators}${s.exported ? 'pub ' : ''}mod ${spellName(s.name.name)} {`);
        this.level += 1;
        this.printList(s.members, endOf(s) - 1, s.start);
        this.level -= 1;
        this.emit('}');
        break;
      case NodeType.BlockStatement:
        this.block(decorators.trimEnd(), s);
        break;
      case NodeType.IfStatement:
        this.ifStatement(s, decorators);
        break;
      case NodeType.WhileStatement:
        if (s.test.type === NodeType.BooleanLiteral && s.test.value === true) this.block(`${decorators}loop`, s.body);
        else this.block(`${decorators}while ${this.noBrace(s.test)}`, s.body);
        break;
      case NodeType.ForStatement:
        this.forStatement(s, decorators);
        break;
      case NodeType.ReturnStatement:
        this.emit(s.argument ? `return ${this.ex(s.argument)};` : 'return;');
        break;
      case NodeType.BreakStatement:
        this.emit('break;');
        break;
      case NodeType.ContinueStatement:
        this.emit('continue;');
        break;
      case NodeType.AsmBlock:
        this.emit(`${decorators}asm6502 ${s.body}`);
        break;
      case NodeType.ExpressionStatement:
        this.emit(`${decorators}${this.expressionStatement(s.expression)}`);
        break;
      case NodeType.BxElement:
      case NodeType.BxFragment:
        this.emit(`${this.bx(s, true)};`);
        break;
      case 'Assert':
        this.emit(`${this.assertion(s)};`);
        break;
      case 'Fail':
        this.emit(`panic!(${s.message ? this.ex(s.message) : ''});`);
        break;
      default:
        this.fail('statement', `no new-syntax spelling for statement '${s.type}'`, s);
    }
  }

  expressionStatement(e) {
    if (e.type === NodeType.UpdateExpression) return `${this.updateAsAssignment(e)};`;
    if (e.type === NodeType.ConditionalExpression || e.type === NodeType.RecordLiteral) return `(${this.ex(e)});`;
    return `${this.ex(e)};`;
  }

  updateAsAssignment(e) {
    return `${this.ex(e.argument, POSTFIX_LEVEL)} ${e.operator === '++' ? '+=' : '-='} 1`;
  }

  ifStatement(s, decorators) {
    let cur = s;
    let header = `${decorators}if ${this.noBrace(cur.test)}`;
    for (;;) {
      this.openBlock(header, cur.consequent);
      const alt = cur.alternate;
      if (!alt) {
        this.emit('}');
        return;
      }
      if (alt.type === NodeType.IfStatement) {
        cur = alt;
        header = `} else if ${this.noBrace(cur.test)}`;
        continue;
      }
      this.openBlock('} else', alt);
      this.emit('}');
      return;
    }
  }

  forStatement(s, decorators) {
    const init = s.init;
    const rangeEnd = s.test?.type === NodeType.BinaryExpression ? s.test.operator : null;
    const isRange = init?.type === NodeType.VariableDeclaration && init.kind === 'let' && init.name
      && init.initializer && !init.exported
      && (rangeEnd === '<' || rangeEnd === '<=')
      && s.test.left.type === NodeType.Identifier && s.test.left.name === init.name.name
      && s.update?.type === NodeType.UpdateExpression && s.update.operator === '++' && !s.update.prefix
      && s.update.argument.type === NodeType.Identifier && s.update.argument.name === init.name.name
      && !storesTo(s.body, init.name.name) && !storesTo(s.test.right, init.name.name);
    if (isRange) {
      const from = this.noBrace(init.initializer, 1);
      const to = this.noBrace(s.test.right, 1);
      const type = init.typeAnnotation ? `: ${this.type(init.typeAnnotation)}` : '';
      this.block(`${decorators}for ${spellName(init.name.name)}${type} in ${from}${rangeEnd === '<' ? '..' : '..='}${to}`, s.body);
      return;
    }
    const initText = !init ? '' : init.type === NodeType.VariableDeclaration ? this.variable(init) : this.ex(init);
    const testText = s.test ? this.ex(s.test) : '';
    const updateText = !s.update ? '' : s.update.type === NodeType.UpdateExpression
      ? this.updateAsAssignment(s.update) : this.ex(s.update);
    this.block(`${decorators}for (${initText}; ${testText}; ${updateText})`, s.body);
  }

  variable(s) {
    const name = spellName(s.name.name);
    const rest = `${this.typeSuffix(s.typeAnnotation)}${this.initSuffix(s.initializer)}`;
    const pub = s.exported ? 'pub ' : '';
    if (s.kind === 'const') return `${pub}const ${name}${rest}`;
    const reason = this.mutable.get(s);
    if (reason) {
      this.stats.letMut += 1;
      if (reason !== 'assigned') this.stats.letAmbiguous += 1;
    } else {
      this.stats.letPlain += 1;
    }
    return `${pub}let ${reason ? 'mut ' : ''}${name}${rest}`;
  }

  typeSuffix(t) {
    return t ? `: ${this.type(t)}` : '';
  }

  initSuffix(e) {
    return e ? ` = ${this.ex(e)}` : '';
  }

  returnSuffix(t) {
    if (!t || (t.name === 'void' && t.typeArguments.length === 0)) return '';
    return ` -> ${this.type(t)}`;
  }

  params(params) {
    return params.map((p) => {
      const type = p.typeAnnotation ? `: ${this.type(p.typeAnnotation)}` : '';
      return `${spellName(p.name.name)}${type}${p.defaultValue ? ` = ${this.ex(p.defaultValue)}` : ''}`;
    }).join(', ');
  }

  type(t) {
    const arg = (a) => (a.type === NodeType.IntegerLiteral ? this.number(a) : this.type(a));
    if (t.name === 'array' && t.typeArguments.length === 2) {
      return `[${arg(t.typeArguments[0])}; ${arg(t.typeArguments[1])}]`;
    }
    if (t.typeArguments.length === 0) return t.name;
    return `${t.name}<${t.typeArguments.map(arg).join(', ')}>`;
  }

  importLine(s) {
    const specifier = s.source?.value ?? '';
    const path = usePathOf(specifier, this.options.aliasHeads);
    const base = path ?? this.string(s.source);
    const names = s.specifiers.map((n) => (n.imported ? `${spellName(n.imported)} as ${spellName(n.name)}` : spellName(n.name)));
    if (names.length === 1 && !s.specifiers[0].imported) return `use ${base}::${names[0]};`;
    return `use ${base}::{${names.join(', ')}};`;
  }

  // ---- tests (nodes the old parser never builds; spec 8bs-test-spec.md 2) ----

  testFunction(t, index) {
    const words = t.name.split(' ');
    const plain = !t.name.includes('_') && words.every((w) => /^[A-Za-z0-9]+$/.test(w)) && /^[A-Za-z]/.test(t.name);
    const fn = plain ? words.join('_') : `t${index + 1}`;
    const attr = plain ? '#[test]' : `#[test(${JSON.stringify(t.name)})]`;
    this.block(`${attr} fn ${fn}()`, t.body);
  }

  assertion(s) {
    const test = s.test;
    const message = s.message ? `, ${this.ex(s.message)}` : '';
    if (test.type === NodeType.BinaryExpression && (test.operator === '==' || test.operator === '!=')) {
      const macro = test.operator === '==' ? 'assert_eq' : 'assert_ne';
      return `${macro}!(${this.ex(test.left)}, ${this.ex(test.right)}${message})`;
    }
    return `assert!(${this.ex(test)}${message})`;
  }

  // ---- expressions ----

  /** An expression in a position where a bare `{` would start the body: parenthesised when it holds braces. */
  noBrace(n, min = 0) {
    const text = this.ex(n, min);
    return hasBraces(n) && !text.startsWith('(') ? `(${text})` : text;
  }

  ex(n, min = 0) {
    const text = this.exRaw(n);
    return levelOf(n) < min ? `(${text})` : text;
  }

  number(n) {
    return n.raw.startsWith('%') ? `0b${n.raw.slice(1)}` : n.raw;
  }

  /** A string literal, always double-quoted: `'it\'s'` becomes `"it's"`. */
  string(n) {
    if (this.text[n.start] !== "'") return `"${n.value}"`;
    let out = '';
    for (let i = 0; i < n.value.length; i += 1) {
      const c = n.value[i];
      if (c === '\\' && i + 1 < n.value.length) {
        const next = n.value[i + 1];
        out += next === "'" ? "'" : `\\${next}`;
        i += 1;
      } else {
        out += c === '"' ? '\\"' : c;
      }
    }
    return `"${out}"`;
  }

  /** Whether a member access names a namespace item (`::`) rather than a value's field (`.`). */
  scopePath(n) {
    if (n.type === NodeType.MemberExpression) return n.property.name !== 'length' && this.scopePath(n.object);
    if (n.type !== NodeType.Identifier || n.compileTime) return false;
    return n.name === 'memory' || n.name === 'port' || !this.valueNames.has(n.name);
  }

  exRaw(n) {
    switch (n.type) {
      case NodeType.Identifier:
        return n.compileTime ? `#${n.name}` : spellName(n.name);
      case NodeType.IntegerLiteral:
        return this.number(n);
      case NodeType.DecimalLiteral:
        return n.raw;
      case NodeType.BooleanLiteral:
        return n.value ? 'true' : 'false';
      case NodeType.StringLiteral:
        return this.string(n);
      case NodeType.TemplateLiteral:
        return `\`${n.parts.map((p) => (p.type === NodeType.TemplateText ? p.value
          : `\${${this.ex(p.expression)}${p.width ? `:${this.number(p.width)}` : ''}}`)).join('')}\``;
      case NodeType.ArrayLiteral:
        return this.array(n);
      case NodeType.RecordLiteral:
        return n.properties.length === 0 ? '{}'
          : `{ ${n.properties.map((p) => `${spellName(p.key)}: ${this.ex(p.value)}`).join(', ')} }`;
      case NodeType.AssignmentExpression:
        return `${this.ex(n.left, POSTFIX_LEVEL)} ${n.operator} ${this.ex(n.right)}`;
      case NodeType.BinaryExpression:
        return this.binary(n);
      case NodeType.ConditionalExpression: {
        const alternate = n.alternate.type === NodeType.ConditionalExpression
          ? this.ex(n.alternate) : `{ ${this.ex(n.alternate)} }`;
        return `if ${this.noBrace(n.test, 1)} { ${this.ex(n.consequent)} } else ${alternate}`;
      }
      case NodeType.UnaryExpression: {
        const arg = this.ex(n.argument, UNARY_LEVEL);
        // `- -x` would read as `--`, `+ +x` as `++`: both are errors in the new syntax.
        return (n.operator === '-' || n.operator === '+') && arg.startsWith(n.operator)
          ? `${n.operator}(${arg})` : `${n.operator}${arg}`;
      }
      case NodeType.UpdateExpression:
        return this.fail('update-in-expression', `'${n.operator}' inside an expression has no new spelling`, n);
      case NodeType.CallExpression:
        return `${this.ex(n.callee, POSTFIX_LEVEL)}(${n.args.map((a) => this.ex(a)).join(', ')})`;
      case NodeType.MemberExpression:
        return `${this.ex(n.object, POSTFIX_LEVEL)}${this.scopePath(n) ? '::' : '.'}${spellName(n.property.name)}`;
      case NodeType.IndexExpression:
        return `${this.ex(n.object, POSTFIX_LEVEL)}[${this.ex(n.index)}]`;
      case NodeType.BxElement:
      case NodeType.BxFragment:
        return this.bx(n, false);
      default:
        return this.fail('expression', `no new-syntax spelling for expression '${n.type}'`, n);
    }
  }

  binary(n) {
    const p = BINARY_PRECEDENCE[n.operator];
    const guarded = COMPARISONS.has(n.operator) || BITWISE.has(n.operator);
    // E9, E10: a comparison under a comparison or a bit operator is always parenthesised.
    const side = (c, min) => (guarded && c.type === NodeType.BinaryExpression && COMPARISONS.has(c.operator)
      ? this.ex(c, PRIMARY_LEVEL + 1) : this.ex(c, min));
    return `${side(n.left, p)} ${n.operator} ${side(n.right, p + 1)}`;
  }

  /** An array literal; one that spans lines in the source keeps its line grouping. */
  array(n) {
    const multiline = this.text.slice(n.start, endOf(n)).includes('\n') && n.elements.length > 0;
    if (!multiline) return `[${n.elements.map((e) => this.ex(e)).join(', ')}]`;
    const savedOut = this.out;
    const savedPrev = this.prevEnd;
    const savedFresh = this.fresh;
    this.out = [];
    this.level += 1;
    this.fresh = true;
    this.prevEnd = n.start + 1;
    let line = [];
    let lineNo = -1;
    const flushLine = () => {
      if (line.length) this.emit(`${line.join(', ')},`);
      line = [];
    };
    for (const e of n.elements) {
      const elementLine = countNewlines(this.text.slice(0, e.start));
      this.emitCommentsInArray(e.start, flushLine);
      if (elementLine !== lineNo) flushLine();
      lineNo = elementLine;
      line.push(this.ex(e));
      this.prevEnd = endOf(e);
    }
    flushLine();
    this.emitCommentsInArray(endOf(n) - 1, flushLine);
    this.level -= 1;
    const lines = this.out;
    this.out = savedOut;
    this.prevEnd = savedPrev;
    this.fresh = savedFresh;
    // The last element's trailing comma is legal (a table may end every line alike).
    return `[\n${lines.join('\n')}\n${INDENT.repeat(this.level)}]`;
  }

  emitCommentsInArray(upTo, flushLine) {
    const next = this.comments[this.ci];
    if (next && next.start < upTo) flushLine();
    this.emitComments(upTo);
  }

  // ---- 8BX ----

  bx(n, multi) {
    const attributes = (n.attributes ?? []).map((a) => {
      if (a.type === NodeType.BxSpreadAttribute) return ` {${a.expression ? this.ex(a.expression) : ''}}`;
      if (!a.value || (a.value.type === NodeType.BooleanLiteral && a.value.start === a.start)) return ` ${a.name}`;
      if (a.value.type === NodeType.StringLiteral) return ` ${a.name}=${this.string(a.value)}`;
      return ` ${a.name}={${this.ex(a.value)}}`;
    }).join('');
    const isFragment = n.type === NodeType.BxFragment;
    const open = isFragment ? '<>' : `<${n.name}${attributes}${n.selfClosing ? ' />' : '>'}`;
    if (n.selfClosing && !isFragment) return open;
    const close = isFragment ? '</>' : `</${n.name}>`;
    if (n.children.length === 0) return `${open}${close}`;
    if (!multi) return `${open}${n.children.map((c) => this.bxChild(c, false)).join(' ')}${close}`;
    this.level += 1;
    const inner = n.children.map((c) => `${INDENT.repeat(this.level)}${this.bxChild(c, true)}`);
    this.level -= 1;
    return `${open}\n${inner.join('\n')}\n${INDENT.repeat(this.level)}${close}`;
  }

  bxChild(c, multi) {
    if (c.type === NodeType.BxText) return c.value;
    if (c.type === NodeType.BxExpressionChild) return `{${c.expression ? this.ex(c.expression) : ''}}`;
    return this.bx(c, multi);
  }

  // ---- program ----

  program() {
    const tests = this.ast.body.filter((s) => s.type === 'TestDecl');
    const body = this.ast.body.filter((s) => s.type !== 'TestDecl');
    this.printList(body, Infinity, null);
    if (tests.length > 0) {
      if (this.out.length) this.out.push('');
      this.emit('#[cfg(test)]');
      this.emit('mod tests {');
      this.level += 1;
      tests.forEach((t, i) => {
        if (i > 0) this.out.push('');
        this.testFunction(t, i);
      });
      this.level -= 1;
      this.emit('}');
    }
    return this.out.length ? `${this.out.join('\n')}\n` : '';
  }
}

/**
 * Print a parsed old-syntax program as new syntax.
 *
 * @param {object} ast
 * @param {object[]} tokens  the tokens `tokenize` produced, comments included
 * @param {string} text
 * @param {{ aliasHeads?: string[] }} [options]  import-alias heads (`@lib`) from the project config
 * @returns {{ text: string, stats: object }}
 */
export function printProgram(ast, tokens, text, options = {}) {
  const printer = new Printer(ast, tokens, text, { aliasHeads: [], ...options });
  const out = printer.program();
  return { text: out, stats: printer.stats };
}

/**
 * Convert old-syntax source text to new syntax.
 *
 * @param {string} text
 * @param {{ file?: string, sourceKind?: string, aliasHeads?: string[] }} [options]
 * @returns {{ text: string, stats: object }}
 * @throws {OldSyntaxError} when the text does not parse cleanly
 * @throws {UnsupportedError} when a construct has no new spelling
 */
export function convertSource(text, options = {}) {
  const file = options.file ?? '<input>';
  const sourceKind = options.sourceKind ?? '.8bs';
  const lexed = tokenize(text, file, { sourceKind });
  const parsed = parse(lexed.tokens, text, file, { sourceKind });
  const diagnostics = [...lexed.diagnostics, ...parsed.diagnostics];
  if (diagnostics.length > 0) throw new OldSyntaxError(diagnostics);
  return printProgram(parsed.ast, lexed.tokens, text, options);
}
