// Lexer for `.8bg` and `.8ba`. The syntax is not 8BitScript, so this
// scanner does not share packages/compiler/src/lexer. It never throws:
// analyze() runs on every keystroke, and half-typed media is the normal
// input. Every token carries start/length so diagnostics point at the
// exact span.
import { Codes, diagnostic } from '../diagnostics/index.mjs';

export const MediaTokenKind = {
  Comment: 'comment',
  String: 'string',
  Number: 'number',
  Identifier: 'identifier',
  Punctuation: 'punctuation',
};

/**
 * @param {string} sourceKind
 * @returns {typeof Codes.GFX_UNEXPECTED_CHARACTER | typeof Codes.AUD_UNEXPECTED_CHARACTER}
 */
function unexpectedCode(sourceKind) {
  return sourceKind === '.8ba' ? Codes.AUD_UNEXPECTED_CHARACTER : Codes.GFX_UNEXPECTED_CHARACTER;
}

/**
 * @param {string} sourceKind
 * @returns {typeof Codes.GFX_UNTERMINATED_STRING | typeof Codes.AUD_UNTERMINATED_STRING}
 */
function unterminatedCode(sourceKind) {
  return sourceKind === '.8ba' ? Codes.AUD_UNTERMINATED_STRING : Codes.GFX_UNTERMINATED_STRING;
}

/**
 * @param {string} text
 * @param {string} file
 * @param {{ sourceKind?: '.8bg'|'.8ba' }} [options]
 * @returns {{ tokens: object[], diagnostics: object[] }}
 */
export function tokenizeMedia(text, file = '<unknown>', options = {}) {
  const sourceKind = options.sourceKind ?? '.8bg';
  const tokens = [];
  const diagnostics = [];
  let i = 0;

  const push = (kind, start, end, extra = {}) => {
    tokens.push({ kind, text: text.slice(start, end), start, length: end - start, ...extra });
  };

  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      push(MediaTokenKind.Comment, start, i);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      if (i < text.length) i += 2;
      push(MediaTokenKind.Comment, start, i);
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i += 1;
      while (i < text.length && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < text.length) i += 2;
        else i += 1;
      }
      if (i < text.length && text[i] === quote) {
        i += 1;
        const raw = text.slice(start + 1, i - 1).replace(/\\(["'\\])/g, '$1');
        push(MediaTokenKind.String, start, i, { value: raw });
      } else {
        diagnostics.push(diagnostic(unterminatedCode(sourceKind), 'unterminated string', file, start, i - start));
        push(MediaTokenKind.String, start, i, { value: text.slice(start + 1, i) });
      }
      continue;
    }
    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
      const value = Number(text.slice(start, i));
      push(MediaTokenKind.Number, start, i, { value });
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      const start = i;
      i += 1;
      while (i < text.length) {
        const d = text[i];
        if ((d >= 'A' && d <= 'Z') || (d >= 'a' && d <= 'z') || (d >= '0' && d <= '9') || d === '_') i += 1;
        else break;
      }
      push(MediaTokenKind.Identifier, start, i);
      continue;
    }
    if ('{}(),;x='.includes(c)) {
      push(MediaTokenKind.Punctuation, i, i + 1);
      i += 1;
      continue;
    }
    diagnostics.push(diagnostic(
      unexpectedCode(sourceKind),
      `unexpected '${c}'`,
      file, i, 1,
    ));
    i += 1;
  }

  return { tokens, diagnostics };
}
