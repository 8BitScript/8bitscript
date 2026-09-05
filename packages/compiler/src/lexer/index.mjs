// The lexer: raw text in, tokens out.
//
// First layer of the pipeline described in docs/compiler.md. It is deliberately
// the only layer that exists today, because it is the one that pays off before
// a parser does: it finds unterminated strings, stray characters, and unbalanced
// brackets, which is already enough to put real errors under the cursor.
//
// Every token carries its offset and length. Diagnostics are built from those,
// so a position is never recomputed by guesswork later.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { INTEGER_TYPE_NAMES } from '../types/index.mjs';

export const TokenKind = {
  Comment: 'comment',
  String: 'string',
  Number: 'number',
  Identifier: 'identifier',
  Keyword: 'keyword',
  Type: 'type',
  Decorator: 'decorator',
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
  'bool', 'void', 'ptr', 'array', 'volatile',
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
const isIdentPart = (c) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c) => c >= '0' && c <= '9';

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

  while (i < text.length) {
    const c = text[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i += 1;
      continue;
    }

    // Comments, both spellings.
    if (c === '/' && text[i + 1] === '/') {
      const start = i;
      while (i < text.length && text[i] !== '\n') i += 1;
      push(TokenKind.Comment, start, i);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      if (i >= text.length) {
        diagnostics.push(
          diagnostic(
            Codes.UNTERMINATED_BLOCK_COMMENT,
            'unterminated block comment',
            file, start, text.length - start,
          ),
        );
        push(TokenKind.Comment, start, text.length);
        break;
      }
      i += 2;
      push(TokenKind.Comment, start, i);
      continue;
    }

    // Strings. A newline ends the search: an unterminated string should report
    // on its own line rather than swallowing the rest of the file.
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) { i += 1; closed = true; break; }
        if (text[i] === '\n') break;
        i += 1;
      }
      if (!closed) {
        diagnostics.push(
          diagnostic(
            Codes.UNTERMINATED_STRING,
            'unterminated string literal',
            file, start, i - start,
          ),
        );
      }
      push(TokenKind.String, start, i);
      continue;
    }

    // Numbers, in the C spellings and the assembly spellings.
    //
    // `%` is also the modulo operator, so `%101` is a binary literal only where
    // a value is expected: after an identifier, a literal, or a closing bracket
    // the `%` in `x%2` has to be modulo. `$` has no such conflict.
    const prev = tokens[tokens.length - 1];
    const prevIsOperand = prev && (
      prev.kind === TokenKind.Identifier ||
      prev.kind === TokenKind.Number ||
      prev.kind === TokenKind.String ||
      prev.kind === TokenKind.Type ||
      [')', ']'].includes(prev.text)
    );
    const startsBinaryLiteral = c === '%' && /[01]/.test(text[i + 1] ?? '') && !prevIsOperand;
    const startsHexLiteral = c === '$' && /[0-9a-fA-F]/.test(text[i + 1] ?? '');

    if (isDigit(c) || startsHexLiteral || startsBinaryLiteral) {
      const start = i;
      let radix = 10;
      if (c === '$') { radix = 16; i += 1; }
      else if (c === '%') { radix = 2; i += 1; }
      else if (c === '0' && /[xX]/.test(text[i + 1] ?? '')) { radix = 16; i += 2; }
      else if (c === '0' && /[bB]/.test(text[i + 1] ?? '')) { radix = 2; i += 2; }
      const digitsStart = i;
      const digitPattern = DIGITS_FOR_RADIX[radix];
      while (i < text.length && digitPattern.test(text[i])) i += 1;
      const digits = text.slice(digitsStart, i).replace(/_/g, '');
      if (digits === '') {
        // `0x` with nothing after it. Reported here so the value can never be
        // a silent NaN travelling through the checker.
        diagnostics.push(
          diagnostic(
            Codes.INVALID_NUMBER,
            `invalid number literal '${text.slice(start, i)}'`,
            file, start, i - start,
          ),
        );
        push(TokenKind.Number, start, i, { value: 0, radix });
        continue;
      }
      // A decimal fraction — `0.5` — radix 10 only, and only when a digit
      // actually follows the `.`: a bare `1.` stays `1` then the `.`
      // operator (unchanged), and `array<u8, 16>`-style code elsewhere in
      // the grammar never wants a Number token to swallow a trailing `.`.
      // Recorded as an exact numerator/denominator pair, never as a
      // floating-point value used for arithmetic — the only thing that ever
      // reads `isDecimal`/`numerator`/`denominator` is the `frames(...)`
      // compile-time fold (packages/compiler/src/fold), which works in
      // exact integers throughout; `value` here is cosmetic only (kept for
      // uniformity with plain-integer Number tokens).
      if (radix === 10 && text[i] === '.' && isDigit(text[i + 1] ?? '')) {
        i += 1; // the '.'
        const fracStart = i;
        while (i < text.length && digitPattern.test(text[i])) i += 1;
        const fracDigits = text.slice(fracStart, i).replace(/_/g, '');
        push(TokenKind.Number, start, i, {
          value: Number.parseFloat(text.slice(start, i)),
          radix,
          isDecimal: true,
          numerator: Number.parseInt(digits + fracDigits, 10),
          denominator: 10 ** fracDigits.length,
        });
        continue;
      }

      push(TokenKind.Number, start, i, { value: Number.parseInt(digits, radix), radix });
      continue;
    }

    // `@address(0x900F)` and friends.
    if (c === '@' && isIdentStart(text[i + 1] ?? '')) {
      const start = i;
      i += 1;
      while (i < text.length && isIdentPart(text[i])) i += 1;
      push(TokenKind.Decorator, start, i);
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      while (i < text.length && isIdentPart(text[i])) i += 1;
      const word = text.slice(start, i);
      const kind = KEYWORDS.has(word)
        ? TokenKind.Keyword
        : TYPE_NAMES.has(word)
          ? TokenKind.Type
          : TokenKind.Identifier;
      push(kind, start, i);

      // The body of an `asm6502 { ... }` block is 6502 assembly, not
      // 8BitScript. Lexing it as 8BitScript is simply wrong — `lda #$06` would
      // report `#` as an unexpected character — so the whole block is taken as
      // one opaque token and handed to the backend untouched.
      if (word === 'asm6502') {
        let j = i;
        while (j < text.length && /\s/.test(text[j])) j += 1;
        if (text[j] === '{') {
          const bodyStart = j;
          let depth = 0;
          while (j < text.length) {
            if (text[j] === '{') depth += 1;
            else if (text[j] === '}') {
              depth -= 1;
              if (depth === 0) { j += 1; break; }
            }
            j += 1;
          }
          if (depth !== 0) {
            diagnostics.push(
              diagnostic(
                Codes.UNTERMINATED_ASM_BLOCK,
                'unterminated asm6502 block',
                file, bodyStart, text.length - bodyStart,
              ),
            );
          }
          push(TokenKind.AsmBlock, bodyStart, j);
          i = j;
        }
      }
      continue;
    }

    if (OPEN_BRACKETS.has(c)) {
      brackets.push({ char: c, offset: i });
      push(TokenKind.Punctuation, i, i + 1);
      i += 1;
      continue;
    }
    if (c in BRACKET_PAIRS) {
      const top = brackets.pop();
      if (!top || top.char !== BRACKET_PAIRS[c]) {
        diagnostics.push(
          diagnostic(Codes.UNMATCHED_BRACKET, `unmatched '${c}'`, file, i, 1),
        );
        if (top) brackets.push(top);
      }
      push(TokenKind.Punctuation, i, i + 1);
      i += 1;
      continue;
    }

    const operator = OPERATORS.find((op) => text.startsWith(op, i));
    if (operator) {
      push(TokenKind.Operator, i, i + operator.length);
      i += operator.length;
      continue;
    }

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
