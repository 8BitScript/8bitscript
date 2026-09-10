// The compile-time folds: `#frames(...)`, the duration builtin, `#system()`,
// the machine a build is for, and `#fact(...)`, one fact about it (see
// facts.mjs for the keys and where the values come from).
//
// `#frames(x, unit)` — x an integer or decimal literal, `unit` the word
// saying what x is measured in — folds to a plain IntegerLiteral holding
// however many frames — waitFrame() calls — that much time is at the
// project's configured `frameRate` (8bs.config.ts, default 60; see
// packages/compiler/src/mos FRAME_SYNC and packages/cli/src/web-runtime.mjs,
// which both pace waitFrame() at that same rate). `#frames(0.5, seconds)`
// is 30 at the default rate, 25 at a configured 50.
//
// The `#` is the language's one spelling for "8bitscript evaluates this;
// the target never sees it" (see the lexer's TokenKind.CompileTime): a
// plain `name(...)` always runs on the machine. So nothing is reserved —
// `#frames` is a different token from any `frames` a program declares —
// and a `#name` the compiler doesn't know, or a `#frames` that isn't
// called, is a diagnostic here.
//
// The builtin is named for what comes *out* — a program stores the result
// in a frame counter, so the call reads as the frame count it is — and the
// unit word names what went *in*. The unit is required: `#frames(30)` would
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
// The unit word is *contextual*, not reserved either: it is only ever
// looked up by spelling in the second-argument slot of a clock call, a slot
// that cannot hold a variable (that is the INVALID_DURATION_ARGUMENT shape
// rule), so `let seconds: uint` elsewhere in the program is an ordinary
// declaration and never collides.
//
// Runs between parse() and check(), so the existing
// literal-fits-the-declared-width rule (VALUE_OUT_OF_RANGE) fires on the
// *folded* value for free — `#frames(100, seconds)` in a `utinyint` gets
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
import { FACTS, factPlaceholder } from './facts.mjs';

/**
 * The units a duration literal can be written in, keyed by the bare word a
 * program writes as the second argument: `#frames(0.5, seconds)`. Each entry
 * turns the literal (an exact rational `numerator/denominator`, both
 * BigInt) into an exact rational number of seconds, the common currency
 * every clock below is defined against.
 *
 * Adding a unit means adding an entry here and writing it a hover in
 * intellisense/index.mjs. Nothing is reserved: the word is only recognized
 * in that one argument slot.
 */
export const DURATION_UNITS = new Map([
  ['seconds', {
    toSeconds: (numerator, denominator) => ({ numerator, denominator }),
  }],
]);

/**
 * The clocks a duration can be counted out in, keyed by the compile-time
 * function name a program calls: `#frames(...)` (without the `#`). Each entry turns an exact
 * rational number of seconds into an exact rational number of that clock's
 * ticks — still a fraction, so the one rounding step (and its
 * ZERO_DURATION / INEXACT_DURATION diagnostics) happens in foldClockCall()
 * identically for every clock.
 *
 * `tick` names one tick for diagnostics; `describe(options)` names the rate
 * the fold happened at.
 *
 * Adding a clock means adding an entry here and writing it a hover in
 * intellisense/index.mjs. Nothing is reserved: `#name` is its own token.
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

/**
 * The machines `#system()` can name, keyed by the target name `8bs build
 * --target` accepts, each with the number `#system()` folds to on that
 * machine. `@8bitscript/system`'s `System` namespace lists the same names
 * with the same numbers (its test checks them against this map), so
 * `#system() == System.C64` compares two compile-time numbers. The numbers
 * are arbitrary and stable: a machine keeps its number when others are
 * added, so a file that records one stays readable.
 */
export const SYSTEMS = new Map([
  ['web', 0],
  ['vic20', 1],
  ['c64', 2],
  ['pet', 3],
  ['c128', 4],
  ['atari8', 5],
  ['nes', 6],
  ['cx16', 7],
  ['mega65', 8],
]);

/** The `#name` a compile-time call names, or null for anything else. */
function compileTimeCallName(n) {
  if (n.type !== NodeType.CallExpression || n.callee?.type !== NodeType.Identifier) return null;
  return n.callee.compileTime ? n.callee.name : null;
}

const KNOWN_COMPILE_TIME = () => [...[...DURATION_CLOCKS.keys()].map((name) => `#${name}(...)`), '#system()', '#fact(...)'].join(', ');
const BUILTIN = (name) => DURATION_CLOCKS.has(name) || name === 'system' || name === 'fact';

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
// `#frames(...)` call rather than a synthetic span. Deleting `callee`/`args`
// also means walk()'s own descent — which reads Object.values(root) *after*
// this visit callback returns — never revisits the argument subtree, so a
// DecimalLiteral consumed by a valid (or invalidly-shaped) clock call is
// never separately flagged as misplaced, and a unit word is never handed to
// the linker to fail to resolve. Every exit from foldClockCall() goes
// through here for exactly that reason.
function replaceWithTickCount(n, name, value) {
  delete n.callee;
  delete n.args;
  n.type = NodeType.IntegerLiteral;
  n.value = value;
  n.raw = name === 'system' ? '#system()' : `#${name}(...)`;
  n.radix = 10;
}

// The same, for a fact: a count becomes an IntegerLiteral, a flag a
// BooleanLiteral, so a `bool` const on the sheet takes a flag and the
// checker's literal-fits-the-type rule sees the right kind of literal.
function replaceWithFact(n, key, value) {
  delete n.callee;
  delete n.args;
  if (typeof value === 'boolean') {
    n.type = NodeType.BooleanLiteral;
    n.value = value;
    delete n.radix;
  } else {
    n.type = NodeType.IntegerLiteral;
    n.value = value;
    n.radix = 10;
  }
  n.raw = `#fact(${key})`;
}

const exampleCalls = (name) => {
  if (name === 'system') return '#system()';
  if (name === 'fact') return '#fact(video.columns) or #fact(memory.ram)';
  return `#${name}(1, seconds) or #${name}(0.5, seconds)`;
};

/**
 * The dotted key a `#fact(...)` argument spells — `video.columns` is a
 * member expression of plain identifiers — or null for any other shape.
 * The words are contextual, not reserved: they are only read here, in this
 * one slot, so `let video` elsewhere is an ordinary declaration.
 */
function factKeyOf(argument) {
  if (!argument) return null;
  if (argument.type === NodeType.Identifier) return argument.compileTime ? null : argument.name;
  if (argument.type === NodeType.MemberExpression && argument.property?.type === NodeType.Identifier) {
    const head = factKeyOf(argument.object);
    return head === null ? null : `${head}.${argument.property.name}`;
  }
  return null;
}

/**
 * `#fact(key)`: one fact about the machine this build is for, from the
 * sheet the build was handed (FACTS has the keys; the machine packages'
 * catalogs and the CLI's resolveHardware have the values). With no machine
 * in hand — `8bs check`, the editor — it folds to the key's placeholder
 * (0 or false) and is "valid and target-dependent", as `#system()` is. With
 * a machine but no facts it is a diagnostic: a real build has a real sheet,
 * and the fold will not invent one for it.
 */
function foldFactCall(n, file, machine, facts, diagnostics) {
  const args = n.args ?? [];
  const key = args.length === 1 ? factKeyOf(args[0]) : null;
  if (key === null || !FACTS.has(key)) {
    diagnostics.push(diagnostic(
      Codes.UNKNOWN_FACT,
      key === null
        ? `#fact(...) takes one fact key, written as words — ${exampleCalls('fact')}`
        : `'${key}' is not a fact — the keys are ${[...FACTS.keys()].join(', ')}`,
      file, n.start, n.length,
    ));
    replaceWithFact(n, key ?? '?', 0);
    return;
  }
  if (machine === undefined) {
    replaceWithFact(n, key, factPlaceholder(key));
    return;
  }
  if (facts === undefined) {
    diagnostics.push(diagnostic(
      Codes.NO_HARDWARE_FACTS,
      `#fact(${key}) needs this build's hardware facts, and the ${machine} build was given none — a build resolves its hardware first (8bs build does; link() takes 'facts')`,
      file, n.start, n.length,
    ));
    replaceWithFact(n, key, factPlaceholder(key));
    return;
  }
  const value = Object.hasOwn(facts, key) ? facts[key] : factPlaceholder(key);
  replaceWithFact(n, key, value);
}

/**
 * `#system()`: the machine this build is for, as its number in SYSTEMS.
 * Takes no arguments. With no machine in hand — `8bs check` and the editor
 * analyse files, not builds — it folds to 0 and is simply "valid, and
 * target-dependent", the same answer the resolver gives a `.<machine>.8bs`
 * file then: only a build can say which machine, and only a build needs to.
 */
function foldSystemCall(n, file, machine, diagnostics) {
  if ((n.args ?? []).length > 0) {
    diagnostics.push(diagnostic(
      Codes.SYSTEM_TAKES_NO_ARGUMENTS,
      '#system() takes no arguments: it is the machine this build is for, and the build already knows which',
      file, n.start, n.length,
    ));
    replaceWithTickCount(n, 'system', 0);
    return;
  }
  if (machine === undefined) {
    replaceWithTickCount(n, 'system', 0);
    return;
  }
  const value = SYSTEMS.get(machine);
  if (value === undefined) {
    diagnostics.push(diagnostic(
      Codes.NOT_ON_THIS_TARGET,
      `#system() has no number for '${machine}' — the machines are ${[...SYSTEMS.keys()].join(', ')}`,
      file, n.start, n.length,
    ));
    replaceWithTickCount(n, 'system', 0);
    return;
  }
  replaceWithTickCount(n, 'system', value);
}

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
      `#${clockName}(...) takes one integer or decimal literal and the unit it is measured in, `
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
      `'${unitName}' is not a unit #${clockName}(...) can measure — `
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
  const written = `#${clockName}(${argument.raw}, ${unitName})`;

  if (value === 0n) {
    diagnostics.push(diagnostic(
      Codes.ZERO_DURATION,
      `${written} rounds to 0 ${clock.tick}s at ${clock.describe(options)} — `
        + `every #${clockName}(...) call must round to at least one ${clock.tick}`,
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
 * Fold every compile-time call — `#frames(...)` (see DURATION_CLOCKS) and
 * `#system()` (see SYSTEMS) — in `ast` into a plain IntegerLiteral,
 * mutating the tree in place, and flag any decimal literal found outside a
 * valid clock-call argument (the language has no other float syntax), any
 * `#name` the compiler doesn't evaluate, and any `#frames` or `#system`
 * that isn't called.
 *
 * @param {object} ast    Program node from the parser.
 * @param {string} file
 * @param {{ frameRate?: number, machine?: string, facts?: object }} [options]
 *   `frameRate` is the project's logical frame rate (default 60; already
 *   validated positive-integer by the caller — see
 *   packages/cli/src/config.mjs's resolveFrameRate). `machine` is the
 *   target being built for, or undefined when a file is being checked
 *   rather than built (see foldSystemCall). `facts` is the build's merged
 *   hardware facts, keyed as facts.mjs's FACTS is, that every `#fact(...)`
 *   folds from; required whenever `machine` is given and a fact is read
 *   (see foldFactCall).
 * @returns {object[]} diagnostics
 */
export function foldCompileTime(ast, file = '<unknown>', { frameRate = 60, machine, facts } = {}) {
  const diagnostics = [];
  if (!ast) return diagnostics;

  walk(ast, (n) => {
    const name = compileTimeCallName(n);
    if (name) {
      if (name === 'system') {
        foldSystemCall(n, file, machine, diagnostics);
        return;
      }
      if (name === 'fact') {
        foldFactCall(n, file, machine, facts, diagnostics);
        return;
      }
      if (!DURATION_CLOCKS.has(name)) {
        diagnostics.push(diagnostic(
          Codes.UNKNOWN_COMPILE_TIME_FUNCTION,
          `'#${name}' is not a function the compiler evaluates — the compile-time functions are ${KNOWN_COMPILE_TIME()}`,
          file, n.callee.start, n.callee.length,
        ));
        replaceWithTickCount(n, name, 0);
        return;
      }
      foldClockCall(n, name, file, frameRate, diagnostics);
      return;
    }
    if (n.type === NodeType.Identifier && n.compileTime) {
      // Every called one was consumed above (its callee deleted before walk()
      // descends), so this one is bare: `#frames` with no argument list.
      diagnostics.push(diagnostic(
        Codes.UNKNOWN_COMPILE_TIME_FUNCTION,
        BUILTIN(n.name)
          ? `'#${n.name}' is a compile-time function and must be called: ${exampleCalls(n.name)}`
          : `'#${n.name}' is not a function the compiler evaluates — the compile-time functions are ${KNOWN_COMPILE_TIME()}`,
        file, n.start, n.length,
      ));
      return;
    }
    if (n.type === NodeType.DecimalLiteral) {
      const raw = n.raw;
      diagnostics.push(diagnostic(
        Codes.MISPLACED_DECIMAL_LITERAL,
        `a decimal literal ('${raw}') is only valid as the first argument to ${KNOWN_COMPILE_TIME()}`,
        file, n.start, n.length,
      ));
      // Replaced, like a folded call is, so nothing downstream reports the
      // same mistake a second time in its own words — the language has no
      // float type for lowering to fail on, and it has already been told.
      n.type = NodeType.IntegerLiteral;
      n.value = 0;
      n.radix = 10;
      delete n.numerator;
      delete n.denominator;
    }
  });

  return diagnostics;
}
