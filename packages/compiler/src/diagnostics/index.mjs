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
 * implemented; type errors wait on a binder). 3000s are compilation limits: the
 * construct is valid but the compiler cannot lower it yet, or not for the
 * requested target.
 */
export const Codes = {
  UNTERMINATED_STRING: '8BS1002',
  UNEXPECTED_CHARACTER: '8BS1003',
  UNMATCHED_BRACKET: '8BS1004',
  UNCLOSED_BRACKET: '8BS1005',
  UNTERMINATED_BLOCK_COMMENT: '8BS1006',
  UNTERMINATED_ASM_BLOCK: '8BS1007',
  INVALID_NUMBER: '8BS1008',
  // A decimal literal (`0.5`) used anywhere other than as the sole argument
  // to `seconds(...)` — the only place the language has any float-shaped
  // syntax. foldDurations() (packages/compiler/src/fold) consumes and
  // removes every valid one before check() ever runs, so any that survive
  // to be walked here were misplaced.
  MISPLACED_DECIMAL_LITERAL: '8BS1009',
  SYNTAX_ERROR: '8BS1101',
  VALUE_OUT_OF_RANGE: '8BS1021',
  // `seconds(...)`'s argument shape is wrong — not exactly one integer-or-
  // decimal literal (see foldDurations()).
  INVALID_DURATION_ARGUMENT: '8BS1022',
  // A `seconds(...)` call folded to zero frames at the project's configured
  // frameRate — always a bug, not a benign rounding nicety: it would wrap a
  // countdown like `let ticks: utinyint = seconds(...); ... ticks = ticks - 1;`
  // straight through 0 instead of ticking.
  ZERO_DURATION: '8BS1023',
  // A `seconds(...)` call didn't fold to an exact frame count at the
  // project's configured frameRate — reported so a rate change (e.g. 60 to
  // 50) that silently nudges a duration's real-world length is never
  // invisible.
  INEXACT_DURATION: '8BS1024',

  UNRESOLVED_PACKAGE: '8BS2001',
  NOT_AN_8BS_PACKAGE: '8BS2002',
  MISSING_PACKAGE_ENTRY: '8BS2003',
  UNRESOLVED_RELATIVE_IMPORT: '8BS2004',
  NO_SUCH_EXPORT: '8BS2005',
  DUPLICATE_BINDING: '8BS2006',
  UNRESOLVED_NAME: '8BS2007',
  MISSING_NATIVE_SOURCE: '8BS2008',
  // `seconds` is reserved for the built-in duration constructor
  // (packages/compiler/src/fold) — a user declaring or importing a binding
  // by that name would otherwise be silently reinterpreted by the fold pass
  // rather than getting a clear diagnostic.
  RESERVED_BUILTIN_NAME: '8BS2009',

  NOT_COMPILABLE: '8BS3001',
  NOT_ON_THIS_TARGET: '8BS3002',
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
