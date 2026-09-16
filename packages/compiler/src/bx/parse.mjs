// Parse 8BX element trees from source text at a `<` offset.
//
// Keeps ordinary lexer rules for `a < b` and `array<u8, N>`: only call this
// when the parser has already decided a `<` begins an element (statement
// start in `.8bx`, or inside BX children).
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { TokenKind, tokenize } from '../lexer/index.mjs';
import { NodeType, node } from '../ast/index.mjs';
import { parse as parseTokens } from '../parser/index.mjs';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

function skipWs(text, i) {
  while (i < text.length && /[ \t\r\n]/.test(text[i])) i += 1;
  return i;
}

function readIdent(text, i) {
  const m = text.slice(i).match(IDENT);
  if (!m) return null;
  return { name: m[0], end: i + m[0].length };
}

function parseExpressionInBraces(text, start, file) {
  let i = start;
  if (text[i] !== '{') return null;
  i += 1;
  let depth = 1;
  const exprStart = i;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      i += 1;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth > 0) i += 1;
  }
  const exprText = text.slice(exprStart, i);
  if (text[i] === '}') i += 1;
  const { tokens, diagnostics: lexDiags } = tokenize(exprText, file, { sourceKind: '.8bx' });
  const { ast, diagnostics: parseDiags } = parseTokens(tokens, exprText, file, { sourceKind: '.8bx' });
  const expr = ast?.body?.[0]?.expression ?? ast?.body?.[0];
  return {
    expression: expr,
    end: i,
    diagnostics: [...lexDiags, ...parseDiags],
  };
}

/**
 * @param {string} text
 * @param {number} start  Index of `<`
 * @param {string} file
 * @returns {{ node: object|null, end: number, diagnostics: object[] }}
 */
export function parseBxElement(text, start, file) {
  const diagnostics = [];
  let i = start;
  if (text[i] !== '<') {
    return { node: null, end: start + 1, diagnostics };
  }
  i += 1;

  // Fragment <>...</>
  if (text[i] === '>') {
    i += 1;
    const children = [];
    const childStart = i;
    while (i < text.length) {
      i = skipWs(text, i);
      if (text[i] === '<' && text[i + 1] === '/') {
        const close = text.indexOf('>', i);
        if (close === -1) {
          diagnostics.push(diagnostic(Codes.BX_SYNTAX, 'unclosed fragment', file, start, text.length - start));
          break;
        }
        const end = close + 1;
        return {
          node: node(NodeType.BxFragment, start, end, { children }),
          end,
          diagnostics,
        };
      }
      if (text[i] === '{') {
        const parsed = parseExpressionInBraces(text, i, file);
        if (!parsed?.expression) break;
        diagnostics.push(...parsed.diagnostics);
        children.push(node(NodeType.BxExpressionChild, i, parsed.end, { expression: parsed.expression }));
        i = parsed.end;
        continue;
      }
      if (text[i] === '<') {
        const inner = parseBxElement(text, i, file);
        if (!inner.node) break;
        diagnostics.push(...inner.diagnostics);
        children.push(inner.node);
        i = inner.end;
        continue;
      }
      const nextSpecial = (() => {
        for (let k = i; k < text.length; k += 1) {
          if (text[k] === '<' || text[k] === '{') return k;
        }
        return text.length;
      })();
      const raw = text.slice(i, nextSpecial);
      if (raw.length > 0) {
        children.push(node(NodeType.BxText, i, nextSpecial, { value: raw }));
      }
      i = nextSpecial;
    }
    diagnostics.push(diagnostic(Codes.BX_SYNTAX, 'unclosed fragment', file, start, text.length - start));
    return { node: null, end: i, diagnostics };
  }

  // Closing tag </Name> — not an element start
  if (text[i] === '/') {
    return { node: null, end: start + 1, diagnostics };
  }

  const ident = readIdent(text, i);
  if (!ident) {
    diagnostics.push(diagnostic(Codes.BX_SYNTAX, 'expected a component name after <', file, start, 1));
    return { node: null, end: start + 1, diagnostics };
  }
  const name = ident.name;
  i = ident.end;

  const attributes = [];
  for (;;) {
    i = skipWs(text, i);
    if (text[i] === '/' || text[i] === '>' || i >= text.length) break;
    if (text[i] === '{') {
      const spread = parseExpressionInBraces(text, i, file);
      if (!spread?.expression) break;
      diagnostics.push(...spread.diagnostics);
      attributes.push(node(NodeType.BxSpreadAttribute, i, spread.end, { expression: spread.expression }));
      i = spread.end;
      continue;
    }
    const attr = readIdent(text, i);
    if (!attr) break;
    i = skipWs(text, attr.end);
    let value = null;
    if (text[i] === '=') {
      i += 1;
      i = skipWs(text, i);
      if (text[i] === '{') {
        const parsed = parseExpressionInBraces(text, i, file);
        if (!parsed?.expression) break;
        diagnostics.push(...parsed.diagnostics);
        value = parsed.expression;
        i = parsed.end;
      } else if (text[i] === '"' || text[i] === "'") {
        const q = text[i];
        const litStart = i;
        i += 1;
        while (i < text.length && text[i] !== q) {
          if (text[i] === '\\') i += 1;
          i += 1;
        }
        i += 1;
        const raw = text.slice(litStart, i);
        value = node(NodeType.StringLiteral, litStart, i, { value: raw.slice(1, -1) });
      }
    } else {
      value = node(NodeType.BooleanLiteral, attr.end - attr.name.length, attr.end, { value: true });
    }
    attributes.push(node(NodeType.BxAttribute, attr.end - attr.name.length, i, {
      name: attr.name, value,
    }));
  }

  if (text[i] === '/') {
    i += 1;
    i = skipWs(text, i);
    if (text[i] !== '>') {
      diagnostics.push(diagnostic(Codes.BX_SYNTAX, "expected '>' after /", file, i, 1));
    } else {
      i += 1;
    }
    const end = i;
    return {
      node: node(NodeType.BxElement, start, end, { name, attributes, children: [], selfClosing: true }),
      end,
      diagnostics,
    };
  }

  if (text[i] !== '>') {
    diagnostics.push(diagnostic(Codes.BX_SYNTAX, "expected '>' or '/>'", file, i, 1));
    return { node: null, end: i, diagnostics };
  }
  i += 1;

  const children = [];
  while (i < text.length) {
    i = skipWs(text, i);
    if (text[i] === '<' && text[i + 1] === '/') {
      i += 2;
      const closeName = readIdent(text, i);
      if (!closeName || closeName.name !== name) {
        diagnostics.push(diagnostic(
          Codes.BX_SYNTAX,
          `expected closing tag </${name}>`,
          file,
          i,
          closeName ? closeName.end - i : 1,
        ));
      } else {
        i = closeName.end;
      }
      i = skipWs(text, i);
      if (text[i] === '>') i += 1;
      const end = i;
      return {
        node: node(NodeType.BxElement, start, end, { name, attributes, children, selfClosing: false }),
        end,
        diagnostics,
      };
    }
    if (text[i] === '{') {
      const parsed = parseExpressionInBraces(text, i, file);
      if (!parsed?.expression) break;
      diagnostics.push(...parsed.diagnostics);
      children.push(node(NodeType.BxExpressionChild, i, parsed.end, { expression: parsed.expression }));
      i = parsed.end;
      continue;
    }
    if (text[i] === '<') {
      const inner = parseBxElement(text, i, file);
      if (!inner.node) break;
      diagnostics.push(...inner.diagnostics);
      children.push(inner.node);
      i = inner.end;
      continue;
    }
    const nextSpecial = (() => {
      for (let k = i; k < text.length; k += 1) {
        if (text[k] === '<' || text[k] === '{') return k;
      }
      return text.length;
    })();
    const raw = text.slice(i, nextSpecial);
    if (raw.length > 0) {
      children.push(node(NodeType.BxText, i, nextSpecial, { value: raw }));
    }
    i = nextSpecial;
  }

  diagnostics.push(diagnostic(Codes.BX_SYNTAX, `unclosed element <${name}>`, file, start, text.length - start));
  return { node: null, end: i, diagnostics };
}
