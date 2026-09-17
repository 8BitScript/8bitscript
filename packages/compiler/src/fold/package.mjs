// `#package("version")` reads the program's own package.json — the nearest
// one above the file the call is written in, the way Node resolves a
// module's package. Nearest-above-the-file rather than the project root
// the CLI runs from: a module inside `@8bitscript/ui` that asks for its
// version gets the ui package's, and `8bs check` and the editor, which
// have a file but no build, resolve exactly as a build does. Read every
// time, not cached: the language server lives across a version bump, and
// a walk of a few stat() calls per `#package(...)` is nothing.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The fields a program may read. Anything else is refused by name. */
export const PACKAGE_FIELDS = ['name', 'version'];

/**
 * The nearest package.json at or above `dir`, parsed, or null when there is
 * none up to the filesystem root.
 *
 * @param {string} dir
 * @returns {{ path: string, json: object }|{ path: string, error: string }|null}
 */
export function nearestPackage(dir) {
  let current = resolve(dir);
  while (true) {
    const candidate = join(current, 'package.json');
    if (existsSync(candidate)) {
      try {
        return { path: candidate, json: JSON.parse(readFileSync(candidate, 'utf8')) };
      } catch (error) {
        return { path: candidate, error: error.message };
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
