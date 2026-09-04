// The `seconds(...)` compile-time duration fold.
//
// `seconds(x)` — x an integer or decimal literal — folds to a plain
// IntegerLiteral holding however many frame() calls that duration takes at
// the project's configured `frameRate` (8bs.config.ts, default 60; see
// packages/backend-6502's FRAME_SYNC and packages/cli/src/web-runtime.mjs,
// which both pace frame() at that same rate). Runs between parse() and
// check(), so the existing literal-fits-the-declared-width rule
// (VALUE_OUT_OF_RANGE) fires on the *folded* value for free — `seconds(100)`
// in a `utinyint` gets that diagnostic with no separate rule needed here.
//
// Deliberately narrow, the same way the checker's literal-width rule is: it
// only ever recognises a call whose callee is literally the identifier
// `seconds`, with exactly one literal argument. This is not general
// constant folding (`let x: u8 = 200 + 100` still isn't folded anywhere in
// the compiler) — `seconds` is a special, reserved name (see checker/
// index.mjs's RESERVED_BUILTIN_NAMES), not an ordinary function a binder
// could someday resolve and inline.
//
// Every arithmetic step below is exact BigInt division — never a `Number`
// or `parseFloat` intermediate — so a duration's real-world length is never
// silently perturbed by floating-point rounding.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType, walk } from '../ast/index.mjs';

const BUILTIN_NAME = 'seconds';

function isSecondsCall(n) {
  return n.type === NodeType.CallExpression
    && n.callee?.type === NodeType.Identifier
    && n.callee.name === BUILTIN_NAME;
}

/**
 * Round `numerator/denominator` (both BigInt, denominator > 0) to the
 * nearest integer, ties rounding up.
 *
 * @returns {{ value: bigint, exact: boolean }}
 */
function roundFraction(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return { value: quotient, exact: true };
  return { value: remainder * 2n >= denominator ? quotient + 1n : quotient, exact: false };
}

// Mutates a folded-away `seconds(...)` CallExpression node into a plain
// IntegerLiteral in place, preserving its original start/length so a
// downstream diagnostic (e.g. VALUE_OUT_OF_RANGE) underlines the whole
// `seconds(...)` call rather than a synthetic span. Deleting `callee`/`args`
// also means walk()'s own descent — which reads Object.values(root) *after*
// this visit callback returns — never revisits the argument subtree, so a
// DecimalLiteral consumed by a valid (or invalidly-shaped) seconds() call is
// never separately flagged as misplaced.
function replaceWithFrameCount(n, value) {
  delete n.callee;
  delete n.args;
  n.type = NodeType.IntegerLiteral;
  n.value = value;
  n.raw = 'seconds(...)';
  n.radix = 10;
}

function foldSecondsCall(n, file, frameRate, diagnostics) {
  const args = n.args ?? [];
  const argument = args.length === 1 ? args[0] : null;
  const isLiteralArgument = argument && (
    argument.type === NodeType.IntegerLiteral || argument.type === NodeType.DecimalLiteral
  );

  if (!isLiteralArgument) {
    diagnostics.push(diagnostic(
      Codes.INVALID_DURATION_ARGUMENT,
      'seconds(...) takes exactly one integer or decimal literal argument, e.g. seconds(1) or seconds(0.5)',
      file, n.start, n.length,
    ));
    replaceWithFrameCount(n, 0);
    return;
  }

  const numerator = BigInt(
    argument.type === NodeType.IntegerLiteral ? argument.value : argument.numerator,
  );
  const denominator = BigInt(
    argument.type === NodeType.IntegerLiteral ? 1 : argument.denominator,
  );
  const { value, exact } = roundFraction(numerator * BigInt(frameRate), denominator);

  if (value === 0n) {
    diagnostics.push(diagnostic(
      Codes.ZERO_DURATION,
      `seconds(${argument.raw}) rounds to 0 frames at this project's frameRate (${frameRate}) — `
        + 'every seconds(...) call must round to at least one frame',
      file, n.start, n.length,
    ));
  } else if (!exact) {
    diagnostics.push(diagnostic(
      Codes.INEXACT_DURATION,
      `seconds(${argument.raw}) is not exact at this project's frameRate (${frameRate}) — `
        + `rounded to ${value} frame${value === 1n ? '' : 's'}`,
      file, n.start, n.length, 'warning',
    ));
  }

  replaceWithFrameCount(n, Number(value));
}

/**
 * Fold every `seconds(...)` call in `ast` into a plain IntegerLiteral,
 * mutating the tree in place, and flag any decimal literal found outside a
 * valid `seconds(...)` argument (the language has no other float syntax).
 *
 * @param {object} ast    Program node from the parser.
 * @param {string} file
 * @param {number} [frameRate] The project's logical frame() rate (default
 *   60; already validated positive-integer by the caller — see
 *   packages/cli/src/config.mjs's resolveFrameRate).
 * @returns {object[]} diagnostics
 */
export function foldDurations(ast, file = '<unknown>', frameRate = 60) {
  const diagnostics = [];
  if (!ast) return diagnostics;

  walk(ast, (n) => {
    if (isSecondsCall(n)) {
      foldSecondsCall(n, file, frameRate, diagnostics);
      return;
    }
    if (n.type === NodeType.DecimalLiteral) {
      diagnostics.push(diagnostic(
        Codes.MISPLACED_DECIMAL_LITERAL,
        `a decimal literal ('${n.raw}') is only valid as the argument to seconds(...)`,
        file, n.start, n.length,
      ));
    }
  });

  return diagnostics;
}
