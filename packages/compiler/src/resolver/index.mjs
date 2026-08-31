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
 * Check every import in a file and report the ones that do not resolve.
 *
 * Deliberately narrow: it diagnoses only what docs/packages.md actually
 * specifies. A bare specifier with a subpath (`@scope/name/thing`) and a
 * relative specifier without a `.8bs` extension are both unspecified, so
 * neither is reported rather than guessing at a rule.
 *
 * @param {object[]} tokens
 * @param {string} file  Absolute path of the importing file.
 * @returns {object[]} diagnostics
 */
export function resolveImports(tokens, file) {
  if (!file || !isAbsolute(file)) return [];
  const fromDir = dirname(file);
  const diagnostics = [];

  for (const { specifier, start, length } of findImports(tokens)) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      if (!specifier.endsWith('.8bs')) continue;
      const target = resolvePath(fromDir, specifier);
      if (!existsSync(target)) {
        diagnostics.push(
          diagnostic(
            Codes.UNRESOLVED_RELATIVE_IMPORT,
            `cannot find module '${specifier}'`,
            file, start, length,
          ),
        );
      }
      continue;
    }

    if (!BARE_PACKAGE.test(specifier)) continue;

    const packageDir = findPackageDir(fromDir, specifier);
    if (!packageDir) {
      diagnostics.push(
        diagnostic(
          Codes.UNRESOLVED_PACKAGE,
          `cannot find package '${specifier}'. Is it installed?`,
          file, start, length,
        ),
      );
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    } catch {
      manifest = null;
    }

    const entry = manifest?.['8bitscript']?.entry;
    if (typeof entry !== 'string') {
      diagnostics.push(
        diagnostic(
          Codes.NOT_AN_8BS_PACKAGE,
          `'${specifier}' is not an 8BitScript package: its package.json has no "8bitscript".entry field`,
          file, start, length,
        ),
      );
      continue;
    }

    if (!existsSync(resolvePath(packageDir, entry))) {
      diagnostics.push(
        diagnostic(
          Codes.MISSING_PACKAGE_ENTRY,
          `'${specifier}' declares entry '${entry}', which does not exist`,
          file, start, length,
        ),
      );
    }
  }

  return diagnostics;
}
