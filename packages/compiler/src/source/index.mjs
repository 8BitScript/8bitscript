// Source kinds: `.8bs` (8BitScript) and `.8bx` (8BitX — core + 8BX composition).
//
// Resolution, CLI entry paths, and the lexer all ask here which extension a
// path carries so twins never mix kinds (main.c64.8bx beside main.8bx, not
// main.c64.8bs).

/** @type {readonly ['.8bs', '.8bx']} */
export const SOURCE_EXTENSIONS = Object.freeze(['.8bs', '.8bx']);

/**
 * @param {string} path
 * @returns {'.8bs' | '.8bx' | null}
 */
export function sourceKindOf(path) {
  for (const ext of SOURCE_EXTENSIONS) {
    if (path.endsWith(ext)) return ext;
  }
  return null;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isSourceFile(path) {
  return sourceKindOf(path) !== null;
}

/**
 * Remove a trailing `.8bs` or `.8bx`. Paths without either are returned unchanged.
 *
 * @param {string} path
 * @returns {string}
 */
export function stripSourceExtension(path) {
  const ext = sourceKindOf(path);
  return ext ? path.slice(0, -ext.length) : path;
}
