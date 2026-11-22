// The front end in Rust, behind one wasm module (`../../wasm/front.wasm`).
//
// `tokenize` and `parse` keep the signatures and result shapes of
// `lexer/index.mjs` and `parser/index.mjs`, so a caller swaps the import and
// nothing else. The module is built from `crates/front-wasm` and committed.
// Wraps front.wasm. Imported by compiler/index.mjs, intellisense and the CLI's migrate.
import { readFileSync } from 'node:fs';

export const TokenKind = {
  Comment: 'comment',
  String: 'string',
  Template: 'template',
  Number: 'number',
  Identifier: 'identifier',
  Keyword: 'keyword',
  Type: 'type',
  Decorator: 'decorator',
  CompileTime: 'compileTime',
  AsmBlock: 'asm',
  Punctuation: 'punctuation',
  Operator: 'operator',
  BxTagOpen: 'bxTagOpen',
  BxTagEnd: 'bxTagEnd',
  BxSelfClose: 'bxSelfClose',
  BxClosingTagOpen: 'bxClosingTagOpen',
  BxText: 'bxText',
  // `assert!`, `assert_eq!`, `assert_ne!`, `panic!`, and `@scope` after `use`.
  Macro: 'macro',
  Scope: 'scope',
};

/** Words the lexer makes keyword tokens: the keywords and the reserved words (`crates/lexer`). */
export const KEYWORDS = new Set([
  'as', 'asm6502', 'break', 'const', 'continue', 'crate', 'else', 'false', 'fn', 'for', 'if',
  'in', 'let', 'loop', 'match', 'mod', 'mut', 'pub', 'return', 'self', 'super', 'true', 'use',
  'while',
  'enum', 'impl', 'struct', 'trait', 'static', 'type',
]);

export const TYPE_NAMES = new Set([
  'tinyint', 'utinyint', 'smallint', 'usmallint', 'mediumint', 'umediumint', 'int', 'uint',
  'i8', 'u8', 'i16', 'u16', 'i24', 'u24', 'i32', 'u32',
  'bool', 'void', 'string', 'ptr', 'array', 'volatile',
]);

/**
 * Tokens that leave a value in place, so a following `<` is a comparison
 * (in `.8bx`, not a tag). The caller must already have skipped comments.
 *
 * @param {{ kind: string, text: string } | undefined | null} tok
 */
export function isOperandToken(tok) {
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
    default:
      return false;
  }
}

/**
 * Raw text between `.8bx` tags: each line trimmed, blank lines dropped, the
 * rest joined with one space. `""` when nothing is left.
 *
 * @param {string} raw
 */
export function normalizeBxText(raw) {
  return raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join(' ');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @type {WebAssembly.Exports | undefined} */
let exportsOf;

function wasm() {
  if (!exportsOf) {
    const module = new WebAssembly.Module(readFileSync(new URL('../../wasm/front.wasm', import.meta.url)));
    exportsOf = new WebAssembly.Instance(module, {}).exports;
  }
  return exportsOf;
}

/**
 * One call into the module: JSON in, JSON out, both buffers freed.
 *
 * @param {'front_tokenize' | 'front_parse' | 'front_check'} name
 * @param {object} request
 */
export function callFront(name, request) {
  const api = wasm();
  const bytes = encoder.encode(JSON.stringify(request));
  const input = api.front_alloc(bytes.length);
  // Memory may have grown during the allocation: take the buffer after it.
  new Uint8Array(api.memory.buffer, input, bytes.length).set(bytes);
  let packed;
  try {
    packed = api[name](input, bytes.length);
  } catch (error) {
    // A trap (or an unknown export) leaves the module's memory in an unknown
    // state: drop it so the next call starts from a fresh instance.
    exportsOf = undefined;
    throw error;
  }
  api.front_free(input, bytes.length);
  const ptr = Number(packed >> 32n);
  const len = Number(packed & 0xffffffffn);
  const text = decoder.decode(new Uint8Array(api.memory.buffer, ptr, len));
  api.front_free(ptr, len);
  const reply = JSON.parse(text);
  if (reply.error !== undefined) throw new Error(`front end: ${reply.error}`);
  return reply;
}

/**
 * The last `front_parse` reply. `tokenize` and `parse` of one file cost one
 * call: whichever runs first fills the entry and each takes its part once,
 * so a caller that mutates a tree never sees the next caller's copy change.
 *
 * @type {{ text: string, file: string, sourceKind: string, tokens?: object[], ast?: object,
 *   diagnostics?: object[], lexerDiagnostics?: object[] } | undefined}
 */
let cache;

/** @param {string} text @param {string} file @param {string} sourceKind */
function fill(text, file, sourceKind, part) {
  if (!cache || cache.text !== text || cache.file !== file || cache.sourceKind !== sourceKind
    || cache[part] === undefined) {
    cache = { text, file, sourceKind, ...callFront('front_parse', { file, text, sourceKind }) };
  }
  const value = cache[part];
  cache[part] = undefined;
  return value;
}

/**
 * @param {string} text
 * @param {string} [file]
 * @param {{ sourceKind?: '.8bs'|'.8bx' }} [options]
 * @returns {{ tokens: object[], diagnostics: object[] }}
 */
export function tokenize(text, file = '<unknown>', options = {}) {
  const sourceKind = options.sourceKind ?? '.8bs';
  const tokens = fill(text, file, sourceKind, 'tokens');
  const diagnostics = cache?.lexerDiagnostics ?? [];
  if (cache) cache.lexerDiagnostics = undefined;
  return { tokens, diagnostics };
}

/**
 * `tokens` is ignored: the module lexes `text` itself.
 *
 * @param {object[]} _tokens
 * @param {string} text
 * @param {string} [file]
 * @param {{ sourceKind?: '.8bs'|'.8bx' }} [options]
 * @returns {{ ast: object, diagnostics: object[] }}
 */
export function parse(_tokens, text, file = '<unknown>', options = {}) {
  const sourceKind = options.sourceKind ?? '.8bs';
  const ast = fill(text, file, sourceKind, 'ast');
  const diagnostics = cache?.diagnostics ?? [];
  if (cache) cache.diagnostics = undefined;
  return { ast, diagnostics };
}

/**
 * Proof for one converted file: does the AST of `newText` equal `oldAst`
 * after the normalizer? `{ equal, differences: [{ path, old, new }] }`.
 *
 * @param {{ file: string, sourceKind?: '.8bs'|'.8bx', oldAst: object, newText: string }} request
 */
export function check({ file, sourceKind = '.8bs', oldAst, newText }) {
  return callFront('front_check', { file, sourceKind, oldAst, newText });
}
