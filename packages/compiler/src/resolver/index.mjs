// Module resolution.
//
// This is the one layer that touches the filesystem, which is why it lives
// apart from the lexer and the checker: those are pure functions over text, and
// keeping them that way means they stay trivially testable and can never fail
// because of a broken dependency on disk.
//
// It works on tokens rather than the AST on purpose: imports sit at the top of
// a file, and a syntax error further down should never stop them being checked.
// Token scanning degrades gracefully where a parse does not.
//
// The contract implemented here is the one specified in docs/packages.md: a
// bare specifier resolves through node_modules to a package whose package.json
// carries an "8bitscript" entry field, and Node itself is never asked to
// understand a .8bs file.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { TokenKind } from '../lexer/index.mjs';

/** A bare specifier naming exactly one package: `name` or `@scope/name`. */
const BARE_PACKAGE = /^(?:@[^/\s]+\/[^/\s]+|[^@./\s][^/\s]*)$/;

/**
 * Extract every `import ... from "specifier"` and bare `import "specifier"`.
 *
 * Token-level, because there is no parser. The scan is bounded: it gives up at
 * a `;` or at any keyword that cannot continue an import, so a typo cannot pair
 * an `import` with a string much further down the file.
 *
 * @param {object[]} tokens
 * @returns {{ specifier: string, start: number, length: number }[]}
 */
export function findImports(tokens) {
  const t = tokens.filter((tok) => tok.kind !== TokenKind.Comment);
  const STOP = new Set(['let', 'const', 'function', 'export', 'import', 'return']);
  const found = [];

  for (let i = 0; i < t.length; i += 1) {
    if (t[i].kind !== TokenKind.Keyword || t[i].text !== 'import') continue;

    for (let j = i + 1; j < t.length; j += 1) {
      const tok = t[j];
      if (tok.text === ';') break;
      if (tok.kind === TokenKind.Keyword && STOP.has(tok.text)) break;

      if (tok.kind === TokenKind.String) {
        // `import "x"` is fine; `import { a } from "x"` must have passed `from`.
        const direct = j === i + 1;
        const viaFrom = t.slice(i + 1, j).some((x) => x.text === 'from');
        if (direct || viaFrom) {
          const raw = tok.text;
          const quote = raw[0];
          // An unterminated string already reported 8BS1002; a second
          // diagnostic on the same span would just be noise.
          if (raw.length >= 2 && raw.endsWith(quote)) {
            found.push({ specifier: raw.slice(1, -1), start: tok.start, length: tok.length });
          }
        }
        break;
      }
    }
  }

  return found;
}

/** Walk up from a directory looking for `node_modules/<name>`. */
function findPackageDir(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * One machine's entry value: a relative path into the package, or a bare
 * specifier delegating to another package (resolved from the package's own
 * directory, so its own dependencies serve the delegation).
 */
function resolveEntryValue(specifier, packageDir, value, options, seen) {
  if (typeof value !== 'string') {
    return {
      code: Codes.NOT_AN_8BS_PACKAGE,
      message: `'${specifier}' has a malformed "8bitscript".entry value`,
    };
  }
  if (value.startsWith('.')) {
    const target = resolvePath(packageDir, value);
    if (!existsSync(target)) {
      return { code: Codes.MISSING_PACKAGE_ENTRY, message: `'${specifier}' declares entry '${value}', which does not exist` };
    }
    return { path: target };
  }
  if (seen.has(packageDir)) {
    return { code: Codes.MISSING_PACKAGE_ENTRY, message: `'${specifier}' delegates its entry in a cycle` };
  }
  seen.add(packageDir);
  const delegated = resolveSpecifier(value, join(packageDir, 'package.json'), options, seen);
  if (!delegated) {
    return {
      code: Codes.NOT_AN_8BS_PACKAGE,
      message: `'${specifier}' delegates its entry to '${value}', which is not a resolvable specifier`,
    };
  }
  return delegated;
}

/**
 * An entry object keyed by machine — `{ "vic20": …, "c64": … }` — is how a
 * package provides a target-conditional implementation. With a machine in
 * hand, that machine's branch resolves (a missing branch is `8BS3002`: the
 * package genuinely has nothing for this target). Without one — `8bs check`
 * and the editor analyse files, not builds — every branch is validated, so a
 * broken branch is reported before anyone builds for that machine.
 */
function resolveConditionalEntry(specifier, packageDir, entry, options, seen) {
  const { machine } = options;
  if (machine) {
    const value = entry[machine];
    if (value === undefined) {
      return {
        code: Codes.NOT_ON_THIS_TARGET,
        message: `'${specifier}' has no entry for the ${machine} target (targets: ${Object.keys(entry).join(', ')})`,
      };
    }
    return resolveEntryValue(specifier, packageDir, value, options, seen);
  }

  for (const [branchMachine, value] of Object.entries(entry)) {
    const resolved = resolveEntryValue(
      specifier, packageDir, value,
      { ...options, machine: branchMachine }, new Set(seen),
    );
    if (resolved?.code) {
      return { code: resolved.code, message: `for the ${branchMachine} target: ${resolved.message}` };
    }
  }
  // Every branch is sound, but there is no single file to name without a
  // machine: `path: null` is "valid, and target-dependent".
  return { path: null };
}

/**
 * Resolve one import specifier to the absolute path of the module it names.
 *
 * Deliberately narrow: it implements only what docs/packages.md actually
 * specifies. A bare specifier with a subpath (`@scope/name/thing`) and a
 * relative specifier without a `.8bs` extension are both unspecified, so both
 * return `null` — not resolved, not an error — rather than guessing at a rule.
 *
 * @param {string} specifier
 * @param {string} fromFile  Absolute path of the importing file.
 * @param {{ machine?: 'vic20'|'c64'|'web' }} [options]
 *   The machine being built for, if one is known; conditional package
 *   entries resolve to that machine's branch.
 * @returns {{ path: string|null } | { code: string, message: string } | null}
 */
export function resolveSpecifier(specifier, fromFile, options = {}, seen = new Set()) {
  const fromDir = dirname(fromFile);

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    if (!specifier.endsWith('.8bs')) return null;
    const target = resolvePath(fromDir, specifier);
    if (!existsSync(target)) {
      return { code: Codes.UNRESOLVED_RELATIVE_IMPORT, message: `cannot find module '${specifier}'` };
    }
    return { path: target };
  }

  if (!BARE_PACKAGE.test(specifier)) return null;

  const packageDir = findPackageDir(fromDir, specifier);
  if (!packageDir) {
    return { code: Codes.UNRESOLVED_PACKAGE, message: `cannot find package '${specifier}'. Is it installed?` };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  } catch {
    manifest = null;
  }

  const entry = manifest?.['8bitscript']?.entry;
  if (typeof entry === 'string') {
    const target = resolvePath(packageDir, entry);
    if (!existsSync(target)) {
      return { code: Codes.MISSING_PACKAGE_ENTRY, message: `'${specifier}' declares entry '${entry}', which does not exist` };
    }
    return { path: target };
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    return resolveConditionalEntry(specifier, packageDir, entry, options, seen);
  }

  return {
    code: Codes.NOT_AN_8BS_PACKAGE,
    message: `'${specifier}' is not an 8BitScript package: its package.json has no "8bitscript".entry field`,
  };
}

/**
 * Check every import in a file and report the ones that do not resolve.
 *
 * A thin consumer of resolveSpecifier: same rules, but reported as
 * diagnostics on the specifier's span, which is what `8bs check` and the
 * editor show.
 *
 * @param {object[]} tokens
 * @param {string} file  Absolute path of the importing file.
 * @returns {object[]} diagnostics
 */
export function resolveImports(tokens, file) {
  if (!file || !isAbsolute(file)) return [];
  const diagnostics = [];

  for (const { specifier, start, length } of findImports(tokens)) {
    const resolved = resolveSpecifier(specifier, file);
    if (resolved && resolved.code) {
      diagnostics.push(diagnostic(resolved.code, resolved.message, file, start, length));
    }
  }

  return diagnostics;
}
