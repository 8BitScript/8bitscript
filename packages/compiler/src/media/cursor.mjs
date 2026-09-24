// Shared cursor over media tokens. Never throws: a missing token becomes
// a diagnostic and a dummy so the rest of the file can still be read.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { MediaTokenKind } from './lexer.mjs';

const significant = (tokens) => tokens.filter((t) => t.kind !== MediaTokenKind.Comment);

export function cursor(tokens, text, file, sourceKind) {
  const t = significant(tokens);
  let i = 0;
  const syntax = sourceKind === '.8ba' ? Codes.AUD_SYNTAX : Codes.GFX_SYNTAX;
  const unknown = sourceKind === '.8ba' ? Codes.AUD_UNKNOWN_FIELD : Codes.GFX_UNKNOWN_FIELD;

  const at = (n = 0) => t[i + n] ?? null;
  const done = () => i >= t.length;
  const spanOf = (tok) => tok ?? { start: text.length, length: 0 };

  const report = (code, message, tok) => {
    const s = spanOf(tok);
    return diagnostic(code, message, file, s.start ?? 0, s.length ?? 0);
  };

  const eat = (kind, textMatch) => {
    const tok = at();
    if (!tok) return null;
    if (kind && tok.kind !== kind) return null;
    if (textMatch !== undefined && tok.text !== textMatch) return null;
    i += 1;
    return tok;
  };

  const expect = (kind, textMatch, what) => {
    const tok = eat(kind, textMatch);
    if (tok) return { ok: true, tok, diagnostics: [] };
    return {
      ok: false,
      tok: spanOf(at()),
      diagnostics: [report(syntax, `expected ${what}`, at())],
    };
  };

  const skipTo = (texts) => {
    const stop = new Set(texts);
    while (!done() && !stop.has(at().text)) i += 1;
  };

  return {
    at, done, eat, expect, skipTo, report, syntax, unknown, file, text, sourceKind,
    get index() { return i; },
    set index(v) { i = v; },
  };
}

export function parseName(c) {
  const tok = c.eat(MediaTokenKind.Identifier);
  if (!tok) {
    return { name: '', start: c.at()?.start ?? 0, length: 0, diagnostics: [c.report(c.syntax, 'expected a name', c.at())] };
  }
  return { name: tok.text, start: tok.start, length: tok.length, diagnostics: [] };
}

export function parseString(c, what) {
  const tok = c.eat(MediaTokenKind.String);
  if (!tok) {
    return { value: '', start: 0, length: 0, diagnostics: [c.report(c.syntax, `expected ${what} as a string`, c.at())] };
  }
  return { value: tok.value, start: tok.start, length: tok.length, diagnostics: [] };
}

export function parseNumber(c, what) {
  const tok = c.eat(MediaTokenKind.Number);
  if (!tok) {
    return { value: 0, start: 0, length: 0, diagnostics: [c.report(c.syntax, `expected ${what} as a number`, c.at())] };
  }
  return { value: tok.value, start: tok.start, length: tok.length, diagnostics: [] };
}

export function parseBlock(c, parseBody) {
  const open = c.expect(MediaTokenKind.Punctuation, '{', "'{'");
  const diagnostics = [...open.diagnostics];
  const body = [];
  if (!open.ok) return { body, diagnostics };
  while (!c.done() && c.at().text !== '}') {
    const item = parseBody(c);
    if (item.diagnostics) diagnostics.push(...item.diagnostics);
    if (item.skip) continue;
    body.push(item);
  }
  const close = c.expect(MediaTokenKind.Punctuation, '}', "'}'");
  diagnostics.push(...close.diagnostics);
  return { body, diagnostics, start: open.tok.start, length: (close.tok.start ?? open.tok.start) + (close.tok.length ?? 0) - open.tok.start };
}
