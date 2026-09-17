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

/**
 * What a locale is spelled as, in a file name (`strings.de.8bs`) and in
 * `#locale("de")`: two to eight lower-case letters, with an optional `-`
 * and a two-to-eight-character lower-case region or script (`de`, `en`,
 * `pt-br`, `zh-hans`) — BCP 47's shape, lower-cased so the file name is
 * the same on every filesystem. The resolver's MACHINES are excluded by
 * isLocaleName, and the CLI refuses a name that is one of a catalog's
 * hardware tags, so `x.pet.8032.8bs` and `x.pet.de.8bs` can always be
 * told apart by the build that reads them.
 */
export const LOCALE_NAME = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/;

/**
 * Every machine a program can be built for — the one list, which the
 * resolver re-exports (see its MACHINES for what the names are used for).
 * It lives here, beside the extensions, because a locale name has to be
 * checked against it (isLocaleName) from code that never touches a disk.
 */
export const MACHINES = Object.freeze([
  'vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web',
]);

/** Whether `name` could be a locale: LOCALE_NAME's shape, and not a machine. */
export function isLocaleName(name) {
  return typeof name === 'string' && LOCALE_NAME.test(name) && !MACHINES.includes(name);
}
