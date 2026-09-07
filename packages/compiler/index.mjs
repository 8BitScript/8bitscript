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
import { foldCompileTime } from './src/fold/index.mjs';
import { lower } from './src/ir/index.mjs';
import { resolveImports } from './src/resolver/index.mjs';

export { tokenize, TokenKind, KEYWORDS, TYPE_NAMES } from './src/lexer/index.mjs';
export { parse } from './src/parser/index.mjs';
export { NodeType, walk } from './src/ast/index.mjs';
export { check } from './src/checker/index.mjs';
export { foldCompileTime, DURATION_CLOCKS, DURATION_UNITS, SYSTEMS } from './src/fold/index.mjs';
export {
  FACTS, PROGRAM_FACTS, factConstName, factPlaceholder, factProblems,
  requiresProblems, unmetRequirements,
} from './src/fold/facts.mjs';
export { lower, entryOf } from './src/ir/index.mjs';
export { link, memoryOf } from './src/linker/index.mjs';
export {
  MACHINES, findImports, isVariantPath, resolveImports, resolveSpecifier, variantOf, tagsOf,
} from './src/resolver/index.mjs';
export { Codes, diagnostic, positionAt } from './src/diagnostics/index.mjs';
export {
  PRIMITIVE_INTEGER_TYPES,
  INTEGER_TYPE_NAMES,
  INTEGER_RANGES,
  resolveIntegerType,
  storageBytes,
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
 * Lowering runs too, and its diagnostics are part of the answer: "this
 * construct is not compilable yet" is exactly what someone needs to see
 * while typing, not at the end of a build. It is a pure AST-to-IR pass with
 * no filesystem in it, so the only thing it cannot report on its own is
 * anything that needs the other modules — an unresolved name, a namespace
 * member that doesn't exist — which the linker reports at build time.
 *
 * @param {string} text
 * @param {string} file
 * @param {{ resolveImports?: boolean, frameRate?: number, machine?: string, facts?: object }} [options]
 *   `machine` is the target when one is known; without it `#system()` and
 *   `#fact(...)` fold to placeholders and are valid-but-target-dependent,
 *   as a `.<machine>.8bs` import is. `facts` is the machine's hardware
 *   fact sheet, wanted whenever `machine` is given and a fact is read. `frameRate` (default 60) is the project's logical frame rate — see
 *   8bs.config.ts — that every `#frames(...)` call folds against, mirroring
 *   link()'s option of the same name so `8bs check`/the editor and a real
 *   build agree on what a duration means.
 * @returns {object[]} diagnostics, in source order
 */
export function analyze(text, file = '<unknown>', options = {}) {
  const { tokens, diagnostics: lexical } = tokenize(text, file);
  const { ast, diagnostics: syntax } = parse(tokens, text, file);

  // Folding runs before check(), same ordering as the linker: a
  // #frames(...) call needs to already be a plain IntegerLiteral by the
  // time the width-fit rule walks the tree.
  const folding = foldCompileTime(ast, file, { frameRate: options.frameRate, machine: options.machine, facts: options.facts });
  const all = [...lexical, ...syntax, ...folding, ...check(ast, file, text)];
  // A few rules — the template layout above all — are deliberately run by
  // both check() and lower(), so that `check()` alone is a complete
  // AST-level answer and `lower()` alone can never drop a construct
  // silently. One problem is still reported once (the linker dedupes the
  // same way for the same reason).
  const seen = new Set(all.map((d) => `${d.code}@${d.start}+${d.length}`));
  for (const d of lower(ast, file, text).diagnostics) {
    if (!seen.has(`${d.code}@${d.start}+${d.length}`)) all.push(d);
  }
  // Import resolution stays on tokens rather than the AST, deliberately: a
  // syntax error on line 30 should not stop line 1's import from being checked.
  if (options.resolveImports) all.push(...resolveImports(tokens, file));
  return all.sort((a, b) => a.start - b.start);
}
