// A loop's own `@unroll`: a demoscene program's explicit request to
// fully unroll a counted loop past the automatic string-copy heuristic's
// small cap (optimize.mjs's MAX_UNROLL, 32) — trading code size for the
// cycles a 6502-family `JMP`/branch back to the top of the loop costs
// every iteration. `@unroll` is validated here, in the linker, for the
// same reason HARDWARE_HAZARD is (hazards.mjs): it needs every const and
// `#fact(...)` already inlined to know whether a loop's bound is even a
// number, and by how much. `8bs check` and the editor analyse a file
// without a machine, so a `for` marked `@unroll` whose bound depends on
// a fact cannot be validated there — the same build-time-only rule
// hazards.mjs's own header states.
//
// This module only checks; it does not unroll. The actual substitution
// is optimize.mjs's optimizeStatement, later, in each backend's build()
// — by the time it asks matchCountedFor about an `@unroll` loop, this
// check has already run and passed, so the substitution never has to
// fail on a loop this file has waved through. Ir/index.mjs's
// forStatement() is the third and earliest check: it fails outright on
// any decorator name but `unroll`, or on `@unroll` given an argument
// (not supported yet — a plain `@unroll` fully unrolls, however many
// iterations that is) — questions answerable from the syntax alone, with
// no machine and no linked program needed.

import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { matchCountedFor, containsJump, UNROLL_DECORATOR_MAX } from './optimize.mjs';

/**
 * Walk the linked program's functions for a `for` marked `@unroll`
 * (ir/index.mjs sets `unroll: true` on the node), reporting each one
 * that is not a plain counted loop 8BitScript knows how to substitute a
 * constant `i` into, whose bound is not a positive number within
 * UNROLL_DECORATOR_MAX, or whose body breaks or continues.
 *
 * @param {object} ir            the linked IR (every const and `#fact` already inlined)
 * @param {Map<object, string>} fileOf  each function to the file it came from
 * @param {object[]} diagnostics
 */
export function checkUnrollDecorators(ir, fileOf, diagnostics) {
  const report = (node, file, message) => diagnostics.push(diagnostic(
    Codes.UNROLL_INVALID, message, file, node.start ?? 0, node.length ?? 0,
  ));

  const visit = (s, file) => {
    if (s.kind !== 'for' || !s.unroll) return;
    // Checked before matchCountedFor, not after: matchCountedFor refuses a
    // jumping body itself (the same rule the automatic string-copy unroll
    // needs), folding "has a jump" and "is not a countable shape" into one
    // null. @unroll wants those told apart — a loop that breaks is
    // otherwise perfectly countable, and the message should say which
    // rule it fell on.
    if (containsJump(s.body)) {
      report(s, file, '@unroll cannot unroll a loop whose body breaks or continues — that jump has nowhere to go once the loop is gone');
      return;
    }
    // Unbounded here on purpose: a loop past UNROLL_DECORATOR_MAX is a
    // plain counted loop (it would pass at a lower cap), so it earns the
    // specific "too many iterations" message below rather than being
    // folded into "not a plain counted loop" by matchCountedFor's own
    // silent cap.
    const counted = matchCountedFor(s, Infinity);
    if (!counted) {
      report(s, file, '@unroll needs a plain counted loop — let i: T = 0; i < N; i++, N a compile-time value — this one is not shaped like that');
      return;
    }
    if (counted.count > UNROLL_DECORATOR_MAX) {
      report(s, file, `@unroll's loop runs ${counted.count} times, past the ${UNROLL_DECORATOR_MAX} this compiler will unroll in one loop — split it, or drop @unroll and let it loop`);
    }
  };
  const walk = (body, file) => {
    for (const s of body) {
      if (s.kind === 'if') { walk(s.then, file); if (s.else) walk(s.else, file); }
      else if (s.kind === 'while' || s.kind === 'block') walk(s.body, file);
      else if (s.kind === 'for') { visit(s, file); walk(s.body, file); }
    }
  };
  for (const fn of ir.functions) walk(fn.body, fileOf.get(fn) ?? '');
}
