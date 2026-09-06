// The diagnostic record every part of the toolchain speaks.
//
// One shape, produced in one place, consumed by both `8bs check` and the
// language server. That is the whole point: the error you see in the editor and
// the error CI fails on are the same object, not two implementations that drift.

/**
 * @typedef {object} Diagnostic
 * @property {string} code     Stable identifier, e.g. "8BS1021".
 * @property {string} message  Human-readable text, no trailing period.
 * @property {string} file     Path or URI the diagnostic belongs to.
 * @property {number} start    Zero-based offset into the source text.
 * @property {number} length   Length of the offending span, in characters.
 * @property {'error'|'warning'} severity
 */

/**
 * Diagnostic codes.
 *
 * 1000s are lexical and syntax problems — things findable without knowing what
 * any name refers to. 2000s are resolution and type errors (resolution is
 * implemented; type errors wait on a binder). 3000s are target limits: the
 * construct is valid but the compiler cannot lower it yet, it is not available
 * on the requested target, or the target refuses it as a hardware hazard.
 */
export const Codes = {
  UNTERMINATED_STRING: '8BS1002',
  UNEXPECTED_CHARACTER: '8BS1003',
  UNMATCHED_BRACKET: '8BS1004',
  UNCLOSED_BRACKET: '8BS1005',
  UNTERMINATED_BLOCK_COMMENT: '8BS1006',
  UNTERMINATED_ASM_BLOCK: '8BS1007',
  INVALID_NUMBER: '8BS1008',
  // A decimal literal (`0.5`) used anywhere other than as the first argument
  // to a duration clock call, `#frames(...)` — the only place the language
  // has any float-shaped syntax. foldDurations() (packages/compiler/src/fold) consumes and
  // removes every valid one before check() ever runs, so any that survive
  // to be walked here were misplaced.
  MISPLACED_DECIMAL_LITERAL: '8BS1009',
  SYNTAX_ERROR: '8BS1101',
  VALUE_OUT_OF_RANGE: '8BS1021',
  // `#frames(...)`'s argument shape is wrong — not one integer-or-decimal
  // literal followed by the bare unit word it is measured in (see
  // foldDurations()). The unit is required: `#frames(30)` is this.
  INVALID_DURATION_ARGUMENT: '8BS1022',
  // A `#frames(...)` call folded to zero frames at the project's configured
  // frameRate — always a bug, not a benign rounding nicety: it would wrap a
  // countdown like `let ticks: utinyint = #frames(...); ... ticks = ticks - 1;`
  // straight through 0 instead of ticking.
  ZERO_DURATION: '8BS1023',
  // A `#frames(...)` call didn't fold to an exact frame count at the
  // project's configured frameRate — reported so a rate change (e.g. 60 to
  // 50) that silently nudges a duration's real-world length is never
  // invisible.
  INEXACT_DURATION: '8BS1024',
  // `#frames(...)`'s second argument names a unit the fold doesn't know —
  // the only one so far is `seconds` (see the fold pass's DURATION_UNITS).
  // Reported at the identifier itself, not the whole call.
  UNKNOWN_DURATION_UNIT: '8BS1025',
  // A string literal (or the text of a template) holds a character outside
  // the portable set — space, `0`-`9`, `A`-`Z`, and `! , - . : ?` — the
  // characters every target's character set can show (the NES ships its own
  // font with exactly these; the Commodore machines are switched to their
  // upper-case set). Reported where the string becomes program data
  // (packages/compiler/src/ir), never for an import specifier.
  UNPORTABLE_CHARACTER: '8BS1026',
  // A string literal longer than 255 bytes: strings are length-prefixed
  // with one byte, and no screen this compiles for has that many cells in
  // a row anyway.
  STRING_TOO_LONG: '8BS1027',
  // A template string (`\`TICK ${ticks}\``) somewhere other than the second
  // argument of a namespace's `print(cell, ...)` — the one place the
  // compiler expands one — or with the wrong shape around it.
  MISPLACED_TEMPLATE: '8BS1028',
  // A `${...}` field the compiler cannot lay out: its width was not given
  // and could not be taken from the expression's type (an imported name, a
  // call across modules), or the value is not something a number field can
  // show (signed, or wider than 16 bits).
  UNPRINTABLE_FIELD: '8BS1029',
  // `#name` — the compile-time spelling — naming a function the compiler
  // doesn't evaluate (`#frames` is the only one), or a compile-time function
  // used without being called (`#frames` on its own).
  UNKNOWN_COMPILE_TIME_FUNCTION: '8BS1030',
  // Assignment (or `++`/`--`) to a `const`: a compile-time constant, inlined
  // wherever it is read, has no storage on the target to assign to. The
  // checker reports a module's own consts; the linker, an imported one.
  ASSIGN_TO_CONST: '8BS1031',
  // `a[7]` on an `array<T, 4>`: a literal index at or past the array's
  // length. Only a literal (or a const) can be checked at compile time; a
  // runtime index is the program's own responsibility, as on the machine.
  INDEX_OUT_OF_RANGE: '8BS1032',
  // `[1, 2, 3]` for an `array<T, 4>`: an array initialiser has exactly as
  // many elements as the type says — the length is part of the type, and
  // the data is laid out at compile time, so nothing can pad or truncate.
  ARRAY_SIZE_MISMATCH: '8BS1033',
  // Names say which side of the compile-time rule they are on: a `const`
  // is UPPER_SNAKE (`OPTION_COUNT`, `BorderColor.BLUE`), a variable starts
  // with a lower-case letter. So a reader knows `LIMIT` is resolved by
  // 8bitscript and `limit` is storage on the machine, without looking up
  // the declaration.
  NAME_CASE: '8BS1034',
  // A call with more arguments than the function has parameters, or fewer
  // than the parameters without a default. A default (`border: utinyint =
  // BorderColor.BLACK`) is a compile-time value 8bitscript fills in at the
  // call, so every call the machine sees is complete.
  WRONG_ARGUMENT_COUNT: '8BS1035',
  // `#system(...)` called with arguments: it takes none (see the fold pass).
  SYSTEM_TAKES_NO_ARGUMENTS: '8BS1036',
  // `#fact(...)` of a key the sheet does not have, or with no key at all
  // (see the fold pass and fold/facts.mjs for the keys).
  UNKNOWN_FACT: '8BS1037',
  // `#fact(...)` in a build that knows its machine but was handed no
  // hardware facts: the fold will not guess a sheet for a real build.
  NO_HARDWARE_FACTS: '8BS1038',

  UNRESOLVED_PACKAGE: '8BS2001',
  NOT_AN_8BS_PACKAGE: '8BS2002',
  MISSING_PACKAGE_ENTRY: '8BS2003',
  UNRESOLVED_RELATIVE_IMPORT: '8BS2004',
  NO_SUCH_EXPORT: '8BS2005',
  DUPLICATE_BINDING: '8BS2006',
  UNRESOLVED_NAME: '8BS2007',
  MISSING_NATIVE_SOURCE: '8BS2008',
  // A declaration or import named after a builtin — `waitFrame`
  // (packages/compiler/src/ir). Compile-time functions (`#frames`) need no
  // reservation: their `#` spelling is a different token from any name. A user binding by that name would otherwise
  // be silently reinterpreted as the builtin rather than getting a clear
  // diagnostic.
  RESERVED_BUILTIN_NAME: '8BS2009',
  // The entry module must export exactly one thing — a function taking no
  // parameters — and that is the program: what a 6502 target's synthesised
  // C `main` calls and what the web host's worker calls. Zero exports, a
  // second export, an exported global or namespace, or a parameterised entry
  // are all this diagnostic. Other modules (packages, libraries) may export
  // whatever they like.
  ENTRY_EXPORTS: '8BS2010',
  // A package subpath — `@scope/name/thing` — that the package's
  // `"8bitscript".exports` map has no entry for (packages/compiler/src/
  // resolver). The package itself is fine; the import asks it for something
  // it does not offer, which is a different failure from a missing entry
  // file (8BS2003) or a package that is not 8BitScript at all (8BS2002).
  NO_SUCH_SUBPATH: '8BS2011',

  NOT_COMPILABLE: '8BS3001',
  NOT_ON_THIS_TARGET: '8BS3002',
  // Two of a build's hardware tags each have their own version of a file,
  // and nothing says which wins (see the resolver's chooseVariant).
  AMBIGUOUS_VARIANT: '8BS3004',
  // A write the requested target's own documentation says can damage the
  // machine — the PET's "killer poke" ($E842 with bit 5 set) is the one
  // entry (packages/compiler/src/linker/hazards.mjs). Reported by the
  // linker, which alone knows the machine and has every const inlined; so
  // it is a build-time diagnostic, not one `8bs check` or the editor show.
  HARDWARE_HAZARD: '8BS3003',
};

/** @returns {Diagnostic} */
export function diagnostic(code, message, file, start, length, severity = 'error') {
  return { code, message, file, start, length, severity };
}

/**
 * Convert an offset into 1-based line and column, for terminal output.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{ line: number, column: number }}
 */
export function positionAt(text, offset) {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      lastBreak = i;
    }
  }
  return { line, column: offset - lastBreak };
}
