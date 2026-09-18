// Project import aliases — `@lib/game/rules.8bs` → a directory named in
// 8bitscript.config.ts's `imports` block, resolved from the config file's
// directory rather than from the importing file.
import { resolve as resolvePath } from 'node:path';

import { isSourceFile } from '../source/index.mjs';

/** A single-segment @-prefix: `@lib`, `@ui`. */
const ALIAS_PREFIX = /^@[^/\s]+$/;

/**
 * Turn a config `imports` object into absolute directory paths.
 *
 * @param {unknown} imports
 * @param {string} projectDir  Directory containing 8bitscript.config.ts.
 * @returns {{ ok: true, importAliases: Readonly<Record<string, string>> } | { ok: false, error: string }}
 */
export function resolveImportAliases(imports, projectDir) {
  if (imports === undefined || imports === null) {
    return { ok: true, importAliases: Object.freeze({}) };
  }
  if (typeof imports !== 'object' || Array.isArray(imports)) {
    return { ok: false, error: "8bitscript.config.ts's imports must be an object of @prefix → directory path" };
  }
  const importAliases = {};
  for (const [prefix, rel] of Object.entries(imports)) {
    if (!ALIAS_PREFIX.test(prefix)) {
      return {
        ok: false,
        error: `8bitscript.config.ts's imports key ${JSON.stringify(prefix)} must be a single @-prefix with no / (e.g. '@lib')`,
      };
    }
    if (typeof rel !== 'string' || rel.length === 0 || rel.startsWith('/') || rel.includes('..')) {
      return {
        ok: false,
        error: `8bitscript.config.ts's imports.${prefix} must be a relative directory path without ..`,
      };
    }
    importAliases[prefix] = resolvePath(projectDir, rel);
  }
  return { ok: true, importAliases: Object.freeze(importAliases) };
}

/**
 * The longest configured prefix `specifier` starts with (`@lib/…`), or null.
 *
 * @param {string} specifier
 * @param {Record<string, string>} importAliases
 */
export function longestAliasPrefix(specifier, importAliases) {
  let best = null;
  let bestLen = 0;
  for (const prefix of Object.keys(importAliases)) {
    const needle = `${prefix}/`;
    if (specifier.startsWith(needle) && prefix.length > bestLen) {
      best = prefix;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * The relative `.8bs`/`.8bx` path after an alias prefix, or null when the
 * specifier does not name a source file.
 *
 * @param {string} specifier
 * @param {string} prefix
 */
export function aliasedSubpath(specifier, prefix) {
  const rest = specifier.slice(prefix.length + 1);
  return isSourceFile(rest) ? rest : null;
}
