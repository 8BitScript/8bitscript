// E20: assigning to a `let` that is not `let mut` (8BS1031).
//
// The new syntax's parser marks a plain `let` with `immutable: true`; the old
// parser never sets it, so on an old-syntax tree this rule finds nothing.
//
// Names resolve by block scope; see `scopes.mjs`, the walk this shares with
// `8bs migrate` (a binding the converter leaves plain must never be stored to
// in this checker's eyes).
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType, walk } from '../ast/index.mjs';
import { scopeStoreTarget, scopeTargetOf, walkScopes } from './scopes.mjs';

/**
 * Whether a `for` is a range `for` (`for i in a..b`), whose update is the
 * loop's own `i++`. The parser builds it as a `ForStatement` with an immutable
 * `let i` and that update, but its init has no `let` keyword, so the init
 * starts at the variable itself; a C-style `for (let i …; …; …)` starts at
 * `let`. Only the range form steps its immutable variable: in the C form a
 * plain `let` that is updated is E20, and `i = 3;` in a range body still is.
 */
function isRangeStep({ init, update }) {
  if (init?.type !== NodeType.VariableDeclaration || init.immutable !== true || !init.name) return false;
  if (init.start !== init.name.start) return false;
  return update?.type === NodeType.UpdateExpression && update.operator === '++'
    && update.argument?.type === NodeType.Identifier && update.argument.name === init.name.name;
}

/**
 * @param {object} ast   Program node from the parser.
 * @param {string} file
 * @returns {object[]} diagnostics
 */
export function checkImmutableLets(ast, file) {
  const diagnostics = [];
  walkScopes(ast, (scope, root) => {
    walk(root, (n) => {
      const target = scopeStoreTarget(n);
      const hit = target && scopeTargetOf(scope, target);
      if (hit?.decl.immutable === true) {
        diagnostics.push(diagnostic(
          Codes.ASSIGN_TO_CONST,
          `'${hit.name.name}' is declared with let, not let mut, and cannot be assigned`,
          file, hit.name.start, hit.name.length,
        ));
      }
    });
  }, { skipUpdate: isRangeStep });
  return diagnostics;
}
