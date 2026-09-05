// The `seconds(...)` compile-time duration fold.
//
// `seconds(x)` — x an integer or decimal literal — folds to a plain
// IntegerLiteral holding however many ticks of some *clock* that duration
// takes. The optional second argument names the clock; there is one so far,
// `FRAMES`, and it is the default, so `seconds(0.5)` and
// `seconds(0.5, FRAMES)` are the same call: however many frames —
// waitFrame() calls — half a second is at the project's configured
// `frameRate` (8bs.config.ts, default 60; see packages/backend-6502's
// FRAME_SYNC and packages/cli/src/web-runtime.mjs, which both pace
// waitFrame() at that same rate). The clock argument exists so a program
// can say *how* a duration is measured once there is more than one way to
// measure it — a future clock is one more entry in DURATION_CLOCKS below,
// not a new builtin. Runs between parse() and
// check(), so the existing literal-fits-the-declared-width rule
// (VALUE_OUT_OF_RANGE) fires on the *folded* value for free — `seconds(100)`
// in a `utinyint` gets that diagnostic with no separate rule needed here.
//
// Deliberately narrow, the same way the checker's literal-width rule is: it
// only ever recognises a call whose callee is literally the identifier
// `seconds`, with one literal argument and, optionally, one bare clock
// identifier after it. This is not general
// constant folding (`let x: u8 = 200 + 100` still isn't folded anywhere in
// the compiler) — `seconds` and the clock names are special, reserved
// names (see checker/index.mjs's RESERVED_BUILTIN_NAMES), not ordinary
// functions or constants a binder could someday resolve and inline.
//
// Every arithmetic step below is exact BigInt division — never a `Number`
// or `parseFloat` intermediate — so a duration's real-world length is never
// silently perturbed by floating-point rounding.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType, walk } from '../ast/index.mjs';

const BUILTIN_NAME = 'seconds';

/**
 * The clocks a `seconds(...)` duration can be measured in, keyed by the bare
 * identifier a program writes as the second argument. Each entry turns an
 * exact rational number of seconds (`numerator/denominator`, both BigInt)
 * into an exact rational number of that clock's ticks — still a fraction,
 * so the one rounding step (and its ZERO_DURATION / INEXACT_DURATION
 * diagnostics) happens in foldSecondsCall() identically for every clock.
 *
 * `describe(options)` names the rate the fold happened at, for diagnostics.
 *
 * Adding a clock means adding an entry here and writing it a hover in
 * intellisense/index.mjs. The checker reserves every name in this table
 * (its RESERVED_BUILTIN_NAMES spreads DURATION_CLOCKS), so reservation is
 * automatic — nothing else in the compiler needs to know.
 */
export const DURATION_CLOCKS = new Map([
  ['FRAMES', {
    // Logical frames: waitFrame() calls, `frameRate` of them a second.
    ticks: (numerator, denominator, { frameRate }) => ({
      numerator: numerator * BigInt(frameRate),
      denominator,
    }),
    unit: 'frame',
    describe: ({ frameRate }) => `this project's frameRate (${frameRate})`,
  }],
]);

/** The clock `seconds(x)` uses when no second argument names one. */
export const DEFAULT_DURATION_CLOCK = 'FRAMES';

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
// never separately flagged as misplaced, and a clock identifier is never
// handed to the linker to fail to resolve. Every exit from foldSecondsCall()
// goes through here for exactly that reason.
function replaceWithTickCount(n, value) {
  delete n.callee;
  delete n.args;
  n.type = NodeType.IntegerLiteral;
  n.value = value;
  n.raw = 'seconds(...)';
  n.radix = 10;
}

function foldSecondsCall(n, file, frameRate, diagnostics) {
  const args = n.args ?? [];
  const [argument, clockArgument] = args;
  const isLiteralArgument = args.length >= 1 && args.length <= 2 && (
    argument?.type === NodeType.IntegerLiteral || argument?.type === NodeType.DecimalLiteral
  );
  const isClockShape = args.length === 1 || clockArgument?.type === NodeType.Identifier;

  if (!isLiteralArgument || !isClockShape) {
    diagnostics.push(diagnostic(
      Codes.INVALID_DURATION_ARGUMENT,
      'seconds(...) takes one integer or decimal literal and, optionally, the clock to measure it in, '
        + 'e.g. seconds(1), seconds(0.5), or seconds(0.5, FRAMES)',
      file, n.start, n.length,
    ));
    replaceWithTickCount(n, 0);
    return;
  }

  const clockName = clockArgument ? clockArgument.name : DEFAULT_DURATION_CLOCK;
  const clock = DURATION_CLOCKS.get(clockName);
  if (!clock) {
    diagnostics.push(diagnostic(
      Codes.UNKNOWN_DURATION_CLOCK,
      `'${clockName}' is not a clock seconds(...) can be measured in — `
        + `the clocks are ${[...DURATION_CLOCKS.keys()]
          .map((name) => (name === DEFAULT_DURATION_CLOCK ? `${name} (the default)` : name)).join(', ')}`,
      file, clockArgument.start, clockArgument.length,
    ));
    replaceWithTickCount(n, 0);
    return;
  }

  const options = { frameRate };
  const seconds = {
    numerator: BigInt(argument.type === NodeType.IntegerLiteral ? argument.value : argument.numerator),
    denominator: BigInt(argument.type === NodeType.IntegerLiteral ? 1 : argument.denominator),
  };
  const ticks = clock.ticks(seconds.numerator, seconds.denominator, options);
  const { value, exact } = roundFraction(ticks.numerator, ticks.denominator);
  const written = clockArgument ? `seconds(${argument.raw}, ${clockName})` : `seconds(${argument.raw})`;

  if (value === 0n) {
    diagnostics.push(diagnostic(
      Codes.ZERO_DURATION,
      `${written} rounds to 0 ${clock.unit}s at ${clock.describe(options)} — `
        + `every seconds(...) call must round to at least one ${clock.unit}`,
      file, n.start, n.length,
    ));
  } else if (!exact) {
    diagnostics.push(diagnostic(
      Codes.INEXACT_DURATION,
      `${written} is not exact at ${clock.describe(options)} — `
        + `rounded to ${value} ${clock.unit}${value === 1n ? '' : 's'}`,
      file, n.start, n.length, 'warning',
    ));
  }

  replaceWithTickCount(n, Number(value));
}

/**
 * Fold every `seconds(...)` call in `ast` into a plain IntegerLiteral,
 * mutating the tree in place, and flag any decimal literal found outside a
 * valid `seconds(...)` argument (the language has no other float syntax).
 * The clock a call names (or defaults to) decides what the integer counts —
 * see DURATION_CLOCKS.
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
