// The `frames(...)` compile-time duration fold.
//
// `frames(x, unit)` — x an integer or decimal literal, `unit` the word
// saying what x is measured in — folds to a plain IntegerLiteral holding
// however many frames — waitFrame() calls — that much time is at the
// project's configured `frameRate` (8bs.config.ts, default 60; see
// packages/backend-6502's FRAME_SYNC and packages/cli/src/web-runtime.mjs,
// which both pace waitFrame() at that same rate). `frames(0.5, seconds)`
// is 30 at the default rate, 25 at a configured 50.
//
// The builtin is named for what comes *out* — a program stores the result
// in a frame counter, so the call reads as the frame count it is — and the
// unit word names what went *in*. The unit is required: `frames(30)` would
// either mean thirty frames (pointless) or silently guess a unit, and
// either way the reader is left doing the conversion in their head, which
// is the one thing this builtin exists to prevent.
//
// Two tables, two directions of growth. DURATION_UNITS is what x can be
// measured in (`seconds`, so far); DURATION_CLOCKS is what a duration can
// be counted out in — one entry per builtin function, `frames` so far. A
// future input unit is one more unit entry; a future output clock is one
// more clock entry, which is also one more builtin name.
//
// The unit word is *contextual*, not reserved: it is only ever looked up by
// spelling in the second-argument slot of a clock call, a slot that cannot
// hold a variable (that is the INVALID_DURATION_ARGUMENT shape rule), so
// `let seconds: uint` elsewhere in the program is an ordinary declaration
// and never collides. Only the clock names — the callees — are reserved
// (see checker/index.mjs's RESERVED_BUILTIN_NAMES, which spreads
// DURATION_CLOCKS), because a callee *can* be a user's function and a
// silently shadowed builtin is worse than a clear diagnostic.
//
// Runs between parse() and check(), so the existing
// literal-fits-the-declared-width rule (VALUE_OUT_OF_RANGE) fires on the
// *folded* value for free — `frames(100, seconds)` in a `utinyint` gets
// that diagnostic with no separate rule needed here. Deliberately narrow,
// the same way the checker's literal-width rule is: this is not general
// constant folding (`let x: u8 = 200 + 100` still isn't folded anywhere in
// the compiler).
//
// Every arithmetic step below is exact BigInt division — never a `Number`
// or `parseFloat` intermediate — so a duration's real-world length is never
// silently perturbed by floating-point rounding.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType, walk } from '../ast/index.mjs';

/**
 * The units a duration literal can be written in, keyed by the bare word a
 * program writes as the second argument: `frames(0.5, seconds)`. Each entry
 * turns the literal (an exact rational `numerator/denominator`, both
 * BigInt) into an exact rational number of seconds, the common currency
 * every clock below is defined against.
 *
 * Adding a unit means adding an entry here and writing it a hover in
 * intellisense/index.mjs. Nothing is reserved: the word is only recognised
 * in that one argument slot.
 */
export const DURATION_UNITS = new Map([
  ['seconds', {
    toSeconds: (numerator, denominator) => ({ numerator, denominator }),
  }],
]);

/**
 * The clocks a duration can be counted out in, keyed by the builtin
 * function name a program calls: `frames(...)`. Each entry turns an exact
 * rational number of seconds into an exact rational number of that clock's
 * ticks — still a fraction, so the one rounding step (and its
 * ZERO_DURATION / INEXACT_DURATION diagnostics) happens in foldClockCall()
 * identically for every clock.
 *
 * `tick` names one tick for diagnostics; `describe(options)` names the rate
 * the fold happened at.
 *
 * Adding a clock means adding an entry here and writing it a hover in
 * intellisense/index.mjs. The checker reserves every name in this table
 * (its RESERVED_BUILTIN_NAMES spreads DURATION_CLOCKS), so reservation is
 * automatic — nothing else in the compiler needs to know.
 */
export const DURATION_CLOCKS = new Map([
  ['frames', {
    // Logical frames: waitFrame() calls, `frameRate` of them a second.
    ticks: (numerator, denominator, { frameRate }) => ({
      numerator: numerator * BigInt(frameRate),
      denominator,
    }),
    tick: 'frame',
    describe: ({ frameRate }) => `this project's frameRate (${frameRate})`,
  }],
]);

function clockCallName(n) {
  if (n.type !== NodeType.CallExpression || n.callee?.type !== NodeType.Identifier) return null;
  return DURATION_CLOCKS.has(n.callee.name) ? n.callee.name : null;
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

// Mutates a folded-away clock CallExpression node into a plain
// IntegerLiteral in place, preserving its original start/length so a
// downstream diagnostic (e.g. VALUE_OUT_OF_RANGE) underlines the whole
// `frames(...)` call rather than a synthetic span. Deleting `callee`/`args`
// also means walk()'s own descent — which reads Object.values(root) *after*
// this visit callback returns — never revisits the argument subtree, so a
// DecimalLiteral consumed by a valid (or invalidly-shaped) clock call is
// never separately flagged as misplaced, and a unit word is never handed to
// the linker to fail to resolve. Every exit from foldClockCall() goes
// through here for exactly that reason.
function replaceWithTickCount(n, clockName, value) {
  delete n.callee;
  delete n.args;
  n.type = NodeType.IntegerLiteral;
  n.value = value;
  n.raw = `${clockName}(...)`;
  n.radix = 10;
}

const exampleCalls = (clockName) => `${clockName}(1, seconds) or ${clockName}(0.5, seconds)`;

function foldClockCall(n, clockName, file, frameRate, diagnostics) {
  const clock = DURATION_CLOCKS.get(clockName);
  const args = n.args ?? [];
  const [argument, unitArgument] = args;
  const isLiteralArgument = argument?.type === NodeType.IntegerLiteral
    || argument?.type === NodeType.DecimalLiteral;
  const isUnitShape = args.length === 2 && unitArgument?.type === NodeType.Identifier;

  if (!isLiteralArgument || !isUnitShape) {
    diagnostics.push(diagnostic(
      Codes.INVALID_DURATION_ARGUMENT,
      `${clockName}(...) takes one integer or decimal literal and the unit it is measured in, `
        + `e.g. ${exampleCalls(clockName)}`,
      file, n.start, n.length,
    ));
    replaceWithTickCount(n, clockName, 0);
    return;
  }

  const unitName = unitArgument.name;
  const unit = DURATION_UNITS.get(unitName);
  if (!unit) {
    diagnostics.push(diagnostic(
      Codes.UNKNOWN_DURATION_UNIT,
      `'${unitName}' is not a unit ${clockName}(...) can measure — `
        + `the units are ${[...DURATION_UNITS.keys()].join(', ')}`,
      file, unitArgument.start, unitArgument.length,
    ));
    replaceWithTickCount(n, clockName, 0);
    return;
  }

  const options = { frameRate };
  const seconds = unit.toSeconds(
    BigInt(argument.type === NodeType.IntegerLiteral ? argument.value : argument.numerator),
    BigInt(argument.type === NodeType.IntegerLiteral ? 1 : argument.denominator),
  );
  const ticks = clock.ticks(seconds.numerator, seconds.denominator, options);
  const { value, exact } = roundFraction(ticks.numerator, ticks.denominator);
  const written = `${clockName}(${argument.raw}, ${unitName})`;

  if (value === 0n) {
    diagnostics.push(diagnostic(
      Codes.ZERO_DURATION,
      `${written} rounds to 0 ${clock.tick}s at ${clock.describe(options)} — `
        + `every ${clockName}(...) call must round to at least one ${clock.tick}`,
      file, n.start, n.length,
    ));
  } else if (!exact) {
    diagnostics.push(diagnostic(
      Codes.INEXACT_DURATION,
      `${written} is not exact at ${clock.describe(options)} — `
        + `rounded to ${value} ${clock.tick}${value === 1n ? '' : 's'}`,
      file, n.start, n.length, 'warning',
    ));
  }

  replaceWithTickCount(n, clockName, Number(value));
}

/**
 * Fold every clock call (`frames(...)`, see DURATION_CLOCKS) in `ast` into
 * a plain IntegerLiteral, mutating the tree in place, and flag any decimal
 * literal found outside a valid clock-call argument (the language has no
 * other float syntax).
 *
 * @param {object} ast    Program node from the parser.
 * @param {string} file
 * @param {number} [frameRate] The project's logical frame rate (default
 *   60; already validated positive-integer by the caller — see
 *   packages/cli/src/config.mjs's resolveFrameRate).
 * @returns {object[]} diagnostics
 */
export function foldDurations(ast, file = '<unknown>', frameRate = 60) {
  const diagnostics = [];
  if (!ast) return diagnostics;

  walk(ast, (n) => {
    const clockName = clockCallName(n);
    if (clockName) {
      foldClockCall(n, clockName, file, frameRate, diagnostics);
      return;
    }
    if (n.type === NodeType.DecimalLiteral) {
      diagnostics.push(diagnostic(
        Codes.MISPLACED_DECIMAL_LITERAL,
        `a decimal literal ('${n.raw}') is only valid as the first argument to `
          + `${[...DURATION_CLOCKS.keys()].map((name) => `${name}(...)`).join(', ')}`,
        file, n.start, n.length,
      ));
    }
  });

  return diagnostics;
}
