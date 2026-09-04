// @8bitscript/compiler — the public surface other packages consume.
//
// The dependency direction is one-way and load-bearing: the CLI and the
// language server both depend on this package, and this package knows nothing
// about either of them, or about any editor. Analysis lives here so that
// `8bs check`, the editor, and CI all report the same errors from the same
// implementation.
import { tokenize } from './src/lexer/index.mjs';
import { parse } from './src/parser/index.mjs';
import { check } from './src/checker/index.mjs';
import { foldDurations } from './src/fold/index.mjs';
import { resolveImports } from './src/resolver/index.mjs';

export { tokenize, TokenKind, KEYWORDS, TYPE_NAMES } from './src/lexer/index.mjs';
export { parse } from './src/parser/index.mjs';
export { NodeType, walk } from './src/ast/index.mjs';
export { check } from './src/checker/index.mjs';
export { foldDurations } from './src/fold/index.mjs';
export { lower } from './src/ir/index.mjs';
export { link } from './src/linker/index.mjs';
export {
  MACHINES, findImports, isVariantPath, resolveImports, resolveSpecifier, variantOf,
} from './src/resolver/index.mjs';
export { Codes, diagnostic, positionAt } from './src/diagnostics/index.mjs';
export {
  PRIMITIVE_INTEGER_TYPES,
  INTEGER_TYPE_NAMES,
  INTEGER_RANGES,
  resolveIntegerType,
} from './src/types/index.mjs';
export { getHoverInfo, getCompletions } from './src/intellisense/index.mjs';

/**
 * Analyse one source file and return every diagnostic it produces.
 *
 * This is the single entry point for "what is wrong with this file". It never
 * throws: source is assumed to be mid-edit, and a dependency on disk is assumed
 * to be possibly broken.
 *
 * Import resolution is opt-in because it is the only part that touches the
 * filesystem, and it needs a real absolute path to resolve against. Callers
 * working with an unsaved buffer leave it off.
 *
 * @param {string} text
 * @param {string} file
 * @param {{ resolveImports?: boolean, frameRate?: number }} [options]
 *   `frameRate` (default 60) is the project's logical frame() rate — see
 *   8bs.config.ts — that every `seconds(...)` call folds against, mirroring
 *   link()'s option of the same name so `8bs check`/the editor and a real
 *   build agree on what a duration means.
 * @returns {object[]} diagnostics, in source order
 */
export function analyze(text, file = '<unknown>', options = {}) {
  const { tokens, diagnostics: lexical } = tokenize(text, file);
  const { ast, diagnostics: syntax } = parse(tokens, text, file);

  // Folding runs before check(), same ordering as the linker: a
  // seconds(...) call needs to already be a plain IntegerLiteral by the
  // time the width-fit rule walks the tree.
  const folding = foldDurations(ast, file, options.frameRate);
  const all = [...lexical, ...syntax, ...folding, ...check(ast, file)];
  // Import resolution stays on tokens rather than the AST, deliberately: a
  // syntax error on line 30 should not stop line 1's import from being checked.
  if (options.resolveImports) all.push(...resolveImports(tokens, file));
  return all.sort((a, b) => a.start - b.start);
}
