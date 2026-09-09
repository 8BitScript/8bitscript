// The lexer: raw text in, tokens out.
//
// First layer of the pipeline described in docs/compiler.md. Hand-written,
// never generated, never a regex over the file: the language is small, and
// several tokens are context-sensitive (`%101` vs `x%2`, `asm6502 { ... }`).
// It never throws — an editor asks for tokens on every keystroke, so
// half-typed source is the normal input. Rules for changing it live in
// AGENTS.md in this directory.
//
// Every token carries its offset and length. Diagnostics are built from those,
// so a position is never recomputed by guesswork later.
//
// tokenize()'s own body is a flat dispatch: one `if` per token kind, each
// calling straight into a same-named `scan*` closure below it. The nesting
// (loops, sub-branches, the string/template escape handling) lives inside
// those closures instead of inline in the main loop, so a change to how
// numbers or templates scan never touches the dispatch, and the dispatch
// itself stays readable as a flat list of "what starts here."
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { INTEGER_TYPE_NAMES } from '../types/index.mjs';

export const TokenKind = {
  Comment: 'comment',
  String: 'string',
  // A backtick string with `${...}` fields — `TICK ${ticks} OPTION ${option}`.
  // One token for the whole thing; `parts` records where its literal text
  // and its field sources sit, and the parser re-lexes each field.
  Template: 'template',
  Number: 'number',
  Identifier: 'identifier',
  Keyword: 'keyword',
  Type: 'type',
  Decorator: 'decorator',
  // `#frames` — a function the compiler evaluates, never the target. The
  // `#` is the one spelling that says "8bitscript resolves this before any
  // target toolchain runs"; a plain `name(...)` always runs on the machine.
  CompileTime: 'compileTime',
  AsmBlock: 'asm',
  Punctuation: 'punctuation',
  Operator: 'operator',
};

export const KEYWORDS = new Set([
  'let', 'const', 'function', 'return', 'export', 'import', 'from', 'as',
  'if', 'else', 'while', 'for', 'do', 'break', 'continue',
  'switch', 'case', 'default', 'true', 'false', 'asm6502', 'namespace',
]);

// Every primitive integer spelling comes from the shared registry — the
// canonical names (`utinyint`, `int`, ...) and the low-level aliases (`u8`,
// `i32`, ...) — so this set can't drift out of sync with the checker, the
// backends, or hover/completion.
export const TYPE_NAMES = new Set([
  ...INTEGER_TYPE_NAMES,
  'bool', 'void', 'string', 'ptr', 'array', 'volatile',
]);

const BRACKET_PAIRS = { ')': '(', ']': '[', '}': '{' };
const OPEN_BRACKETS = new Set(['(', '[', '{']);

// Operators, longest first, matched by maximal munch against this list only.
// Greedily globbing operator characters is how `x=-1` ends up lexed as the
// non-operator `=-`; matching real operators cannot produce a token that no
// rule of the language recognises.
const OPERATORS = [
  '<<=', '>>=',
  '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '=',
  '?', ':', ';', ',', '.',
];

const DIGITS_FOR_RADIX = { 2: /[01_]/, 10: /[0-9_]/, 16: /[0-9a-fA-F_]/ };

// `$` is not an identifier character: it introduces hex literals ($900F). A
// language aimed at this hardware gives the assembly spelling priority.
const isIdentStart = (c) => /[A-Za-z_]/.test(c);
const isIdentPart = (c) => /\w/.test(c);
const isDigit = (c) => c >= '0' && c <= '9';

/** Previous non-comment token. Comments are trivia for `%` vs binary. */
function lastSignificant(tokens) {
  for (let k = tokens.length - 1; k >= 0; k -= 1) {
    if (tokens[k].kind !== TokenKind.Comment) return tokens[k];
  }
  return undefined;
}

/**
 * Tokens that leave a value in place, so a following `%101` is modulo, not
 * a binary literal. `true`/`false` are literals; postfix `++`/`--` leave
 * their operand in place. The caller must already have skipped comments.
 */
function isOperandToken(tok) {
  if (!tok) return false;
  switch (tok.kind) {
    case TokenKind.Identifier:
    case TokenKind.Number:
    case TokenKind.String:
    case TokenKind.Template:
    case TokenKind.Type:
      return true;
    case TokenKind.Keyword:
      return tok.text === 'true' || tok.text === 'false';
    case TokenKind.Punctuation:
      return tok.text === ')' || tok.text === ']';
    case TokenKind.Operator:
      return tok.text === '++' || tok.text === '--';
    default:
      return false;
  }
}

/** Offset of the next newline at or after `j`, or `text.length` if there is none. Shared by every `;`/`//`-style comment scanner that just runs to end-of-line. */
function skipToLineEnd(text, j) {
  let k = j;
  while (k < text.length && text[k] !== '\n') k += 1;
  return k;
}

/**
 * Skips one `'`/`"`-quoted run starting at `text[j]`, stopping at the
 * closing quote, a newline, or end of file. Shared by `scanAsmBlock` (a
 * quote inside `asm6502 { ... }` must not have its own `{`/`}` counted)
 * and nowhere else — the real 8BitScript string scanner has its own
 * version (`skipStringEscape`, a closure in `tokenize` that also has to
 * update the token-level `i`), not this one.
 *
 * @param {string} text
 * @param {number} j  Offset of the opening quote.
 * @returns {number} Offset just past the closing quote (or the newline/EOF it stopped at).
 */
function skipQuoted(text, j) {
  const quote = text[j];
  let k = j + 1;
  while (k < text.length && text[k] !== '\n') {
    if (text[k] === '\\' && k + 1 < text.length && text[k + 1] !== '\n') {
      k += 2;
      continue;
    }
    if (text[k] === quote) { k += 1; break; }
    k += 1;
  }
  return k;
}

/**
 * End offset of an `asm6502 { ... }` body. The body is 6502 assembly, so
 * `{` / `}` inside `;` comments or quotes must not count toward depth.
 *
 * @param {string} text
 * @param {number} openBrace  Offset of the opening `{`.
 * @returns {{ end: number, depth: number }}
 */
function scanAsmBlock(text, openBrace) {
  let j = openBrace;
  let depth = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === ';') {
      j = skipToLineEnd(text, j);
      continue;
    }
    if (c === '"' || c === "'") {
      j = skipQuoted(text, j);
      continue;
    }
    if (c === '{') {
      depth += 1;
      j += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      j += 1;
      if (depth === 0) return { end: j, depth: 0 };
      continue;
    }
    j += 1;
  }
  return { end: j, depth };
}

/**
 * Tokenize a source file.
 *
 * Always returns both tokens and diagnostics: lexing never throws, because an
 * editor asks for tokens on every keystroke and half-typed source is the normal
 * case, not an exceptional one.
 *
 * @param {string} text
 * @param {string} file
 * @returns {{ tokens: object[], diagnostics: object[] }}
 */
export function tokenize(text, file = '<unknown>') {
  const tokens = [];
  const diagnostics = [];
  const brackets = [];
  let i = 0;

  const push = (kind, start, end, extra = {}) =>
    tokens.push({ kind, start, length: end - start, text: text.slice(start, end), ...extra });

  // A source newline always ends a string or template, even after `\`.
  // Skipping the newline as an escaped character would swallow the next line.
  const skipStringEscape = () => {
    if (text[i] === '\\' && i + 1 < text.length && text[i + 1] !== '\n') {
      i += 2;
      return true;
    }
    return false;
  };

  // Comments, both spellings.
  const scanLineComment = () => {
    const start = i;
    while (i < text.length && text[i] !== '\n') i += 1;
    push(TokenKind.Comment, start, i);
  };

  // The one exception to "never throw": nothing follows an unterminated
  // block comment for the scanner to recover into, so this runs the main
  // loop's cursor to EOF (via the same `i` closure everything else here
  // shares) instead of trying to find a next token that isn't there.
  const scanBlockComment = () => {
    const start = i;
    i += 2;
    while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
    if (i >= text.length) {
      diagnostics.push(
        diagnostic(Codes.UNTERMINATED_BLOCK_COMMENT, 'unterminated block comment', file, start, text.length - start),
      );
      push(TokenKind.Comment, start, text.length);
      i = text.length;
      return;
    }
    i += 2;
    push(TokenKind.Comment, start, i);
  };

  // Strings. A newline ends the search: an unterminated string should report
  // on its own line rather than swallowing the rest of the file.
  const scanString = () => {
    const start = i;
    const quote = text[i];
    i += 1;
    let closed = false;
    while (i < text.length) {
      if (skipStringEscape()) continue;
      if (text[i] === quote) { i += 1; closed = true; break; }
      if (text[i] === '\n') break;
      i += 1;
    }
    if (!closed) {
      diagnostics.push(
        diagnostic(Codes.UNTERMINATED_STRING, 'unterminated string literal', file, start, i - start),
      );
    }
    push(TokenKind.String, start, i, closed ? {} : { unterminated: true });
  };

  // The inside of one `${ ... }` field: braces nest so a future `{`-bearing
  // expression still ends at the right `}`; quoted text inside a field does
  // not count toward that depth. Broken out of scanTemplate() so a quote's
  // own escape/newline handling isn't nested inside the field-brace loop
  // inside the template loop inside tokenize() — three levels flattened to
  // one call each. Advances the shared `i`; returns the unmatched depth (0
  // means the field closed cleanly).
  const scanTemplateField = () => {
    let depth = 1;
    while (i < text.length && text[i] !== '\n') {
      if (text[i] === '"' || text[i] === "'") {
        // skipQuoted's own escape handling is exactly skipStringEscape's —
        // both refuse to step over a newline — so it's safe to reuse here
        // even though this quote sits inside a `${...}` field, not a
        // top-level string.
        i = skipQuoted(text, i);
        continue;
      }
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') { depth -= 1; if (depth === 0) break; }
      i += 1;
    }
    return depth;
  };

  // Template strings: `TICK ${ticks} OPTION ${option}`. Lexed as one token
  // so the parser sees a single literal, with `parts` marking each run of
  // text and each `${...}` field's source span (the field's own tokens are
  // produced by the parser re-lexing that span, offsets intact). Single-line,
  // like the other strings.
  const scanTemplate = () => {
    const start = i;
    i += 1;
    const parts = [];
    let textStart = i;
    let closed = false;
    const flushText = (end) => {
      if (end > textStart) parts.push({ kind: 'text', start: textStart, end });
    };
    while (i < text.length) {
      if (skipStringEscape()) continue;
      if (text[i] === '`') { flushText(i); i += 1; closed = true; break; }
      if (text[i] === '\n') break;
      if (text[i] === '$' && text[i + 1] === '{') {
        flushText(i);
        const fieldStart = i;
        i += 2;
        const sourceStart = i;
        const depth = scanTemplateField();
        if (depth !== 0) {
          diagnostics.push(diagnostic(
            Codes.UNTERMINATED_STRING, "unterminated '${' field in template string", file, fieldStart, i - fieldStart,
          ));
          // Recorded anyway: a field being typed has no `}` yet, and
          // hover and completion inside it are exactly what a person
          // wants at that moment (half-typed source is the normal input,
          // see this file's header).
          parts.push({ kind: 'field', start: fieldStart, end: i, sourceStart, sourceEnd: i });
          closed = true; // one diagnostic, not this plus "unterminated template"
          break;
        }
        parts.push({ kind: 'field', start: fieldStart, end: i + 1, sourceStart, sourceEnd: i });
        i += 1;
        textStart = i;
        continue;
      }
      i += 1;
    }
    if (!closed) {
      diagnostics.push(diagnostic(
        Codes.UNTERMINATED_STRING, 'unterminated template string', file, start, i - start,
      ));
    }
    push(TokenKind.Template, start, i, { parts });
  };

  // Numbers, in the C spellings and the assembly spellings. `c` is the
  // character tokenize()'s dispatch already looked at to decide this is a
  // number — `$`/`%`/a digit — so it's re-read from `text[i]` here rather
  // than threaded through as a parameter.
  const scanNumber = () => {
    const c = text[i];
    const start = i;
    let radix = 10;
    if (c === '$') { radix = 16; i += 1; }
    else if (c === '%') { radix = 2; i += 1; }
    else if (c === '0' && /[xX]/.test(text[i + 1] ?? '')) { radix = 16; i += 2; }
    else if (c === '0' && /[bB]/.test(text[i + 1] ?? '')) { radix = 2; i += 2; }
    const digitsStart = i;
    const digitPattern = DIGITS_FOR_RADIX[radix];
    while (i < text.length && digitPattern.test(text[i])) i += 1;
    const digits = text.slice(digitsStart, i).replaceAll('_', '');
    if (digits === '') {
      // `0x` with nothing after it. Reported here so the value can never be
      // a silent NaN travelling through the checker.
      diagnostics.push(
        diagnostic(Codes.INVALID_NUMBER, `invalid number literal '${text.slice(start, i)}'`, file, start, i - start),
      );
      push(TokenKind.Number, start, i, { value: 0, radix });
      return;
    }
    // A decimal fraction — `0.5` — radix 10 only, and only when a digit
    // actually follows the `.`: a bare `1.` stays `1` then the `.`
    // operator (unchanged), and `array<u8, 16>`-style code elsewhere in
    // the grammar never wants a Number token to swallow a trailing `.`.
    // Recorded as an exact numerator/denominator pair, never as a
    // floating-point value used for arithmetic — the only thing that ever
    // reads `isDecimal`/`numerator`/`denominator` is the `#frames(...)`
    // compile-time fold (packages/compiler/src/fold), which works in
    // exact integers throughout; `value` here is cosmetic only (kept for
    // uniformity with plain-integer Number tokens).
    if (radix === 10 && text[i] === '.' && isDigit(text[i + 1] ?? '')) {
      i += 1; // the '.'
      const fracStart = i;
      while (i < text.length && digitPattern.test(text[i])) i += 1;
      const fracDigits = text.slice(fracStart, i).replaceAll('_', '');
      push(TokenKind.Number, start, i, {
        value: Number.parseFloat(text.slice(start, i)),
        radix,
        isDecimal: true,
        numerator: Number.parseInt(digits + fracDigits, 10),
        denominator: 10 ** fracDigits.length,
      });
      return;
    }

    push(TokenKind.Number, start, i, { value: Number.parseInt(digits, radix), radix });
  };

  // `#frames(...)` (TokenKind.CompileTime) and `@address(0x900F)`
  // (TokenKind.Decorator) share one spelling shape: a sigil plus an
  // identifier, one token, no space allowed between them.
  const scanSigilWord = (kind) => {
    const start = i;
    i += 1;
    while (i < text.length && isIdentPart(text[i])) i += 1;
    push(kind, start, i);
  };

  // The body of an `asm6502 { ... }` block is 6502 assembly, not
  // 8BitScript. Lexing it as 8BitScript is simply wrong — `lda #$06` would
  // report `#` as an unexpected character — so the whole block is taken as
  // one opaque token and handed to the backend untouched.
  const scanAsmBlockIfPresent = () => {
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (text[j] !== '{') return;
    const bodyStart = j;
    const { end, depth } = scanAsmBlock(text, bodyStart);
    if (depth !== 0) {
      diagnostics.push(
        diagnostic(Codes.UNTERMINATED_ASM_BLOCK, 'unterminated asm6502 block', file, bodyStart, text.length - bodyStart),
      );
    }
    push(TokenKind.AsmBlock, bodyStart, end);
    i = end;
  };

  const scanIdentifier = () => {
    const start = i;
    while (i < text.length && isIdentPart(text[i])) i += 1;
    const word = text.slice(start, i);
    let kind = TokenKind.Identifier;
    if (KEYWORDS.has(word)) kind = TokenKind.Keyword;
    else if (TYPE_NAMES.has(word)) kind = TokenKind.Type;
    push(kind, start, i);
    if (word === 'asm6502') scanAsmBlockIfPresent();
  };

  const scanOpenBracket = () => {
    brackets.push({ char: text[i], offset: i });
    push(TokenKind.Punctuation, i, i + 1);
    i += 1;
  };

  const scanCloseBracket = () => {
    const c = text[i];
    const top = brackets.pop();
    if (!top || top.char !== BRACKET_PAIRS[c]) {
      diagnostics.push(diagnostic(Codes.UNMATCHED_BRACKET, `unmatched '${c}'`, file, i, 1));
      if (top) brackets.push(top);
    }
    push(TokenKind.Punctuation, i, i + 1);
    i += 1;
  };

  // Matched by maximal munch against OPERATORS only — see that list's own
  // header. Returns whether an operator was found, so the dispatch below
  // can fall through to "unexpected character" when nothing matches.
  const scanOperator = () => {
    const operator = OPERATORS.find((op) => text.startsWith(op, i));
    if (!operator) return false;
    push(TokenKind.Operator, i, i + operator.length);
    i += operator.length;
    return true;
  };

  // `%` is also the modulo operator, so `%101` is a binary literal only where
  // a value is expected: after an identifier, a literal, or a closing bracket
  // the `%` in `x%2` has to be modulo. `$` has no such conflict. Look past
  // comments: `x/*c*/%2` is still modulo.
  const startsNumber = () => {
    const c = text[i];
    if (isDigit(c)) return true;
    if (c === '$') return /[0-9a-fA-F]/.test(text[i + 1] ?? '');
    if (c === '%') return /[01]/.test(text[i + 1] ?? '') && !isOperandToken(lastSignificant(tokens));
    return false;
  };

  // What starts here, and the scanner that reads it — checked top to
  // bottom, first match wins. Kept as data rather than a chain of `if`s
  // in the loop below so tokenize() itself stays a single dispatch step
  // (find the entry, run its scanner) no matter how many token kinds
  // exist; every kind's own matching logic still lives with its scanner,
  // right above. Operator matching alone stays outside this table — its
  // own OPERATORS.find() already doubles as an answer to "did anything
  // match," so it's the fallback after the table instead of a redundant
  // test/scan pair.
  const DISPATCH = [
    { starts: () => text[i] === '/' && text[i + 1] === '/', scan: scanLineComment },
    { starts: () => text[i] === '/' && text[i + 1] === '*', scan: scanBlockComment },
    { starts: () => text[i] === '"' || text[i] === "'", scan: scanString },
    { starts: () => text[i] === '`', scan: scanTemplate },
    { starts: startsNumber, scan: scanNumber },
    { starts: () => text[i] === '#' && isIdentStart(text[i + 1] ?? ''), scan: () => scanSigilWord(TokenKind.CompileTime) },
    { starts: () => text[i] === '@' && isIdentStart(text[i + 1] ?? ''), scan: () => scanSigilWord(TokenKind.Decorator) },
    { starts: () => isIdentStart(text[i]), scan: scanIdentifier },
    { starts: () => OPEN_BRACKETS.has(text[i]), scan: scanOpenBracket },
    { starts: () => text[i] in BRACKET_PAIRS, scan: scanCloseBracket },
  ];

  while (i < text.length) {
    const c = text[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i += 1;
      continue;
    }

    const entry = DISPATCH.find((d) => d.starts());
    if (entry) { entry.scan(); continue; }
    if (scanOperator()) continue;

    diagnostics.push(
      diagnostic(Codes.UNEXPECTED_CHARACTER, `unexpected character '${c}'`, file, i, 1),
    );
    i += 1;
  }

  for (const open of brackets) {
    diagnostics.push(
      diagnostic(Codes.UNCLOSED_BRACKET, `unclosed '${open.char}'`, file, open.offset, 1),
    );
  }

  return { tokens, diagnostics };
}
