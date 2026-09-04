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
 * Every machine a program can be built for — the names `8bs build --target`
 * accepts, the keys a target-conditional entry is written in, and the
 * suffixes a system-specific source file carries (see variantOf). The CLI
 * reads this list rather than keeping its own, so a new target is added in
 * exactly one place.
 */
export const MACHINES = Object.freeze([
  'vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web',
]);

/**
 * The system-specific twin of a `.8bs` path: `main.8bs` on the NES is
 * `main.nes.8bs`, the machine's name slotted in before the extension. The
 * portable file keeps the plain name; a machine that needs its own version
 * of that file gets the suffixed one beside it, and a build for that
 * machine picks it up without anything else having to name it. Any file in
 * the graph can have one — the entry, a module it imports, a package's
 * entry — because the rule is about files, not about configuration.
 */
export function variantOf(path, machine) {
  return `${path.slice(0, -'.8bs'.length)}.${machine}.8bs`;
}

/** Whether a path already names one machine's version: `x.nes.8bs`. */
export function isVariantPath(path) {
  const stem = path.slice(0, -'.8bs'.length);
  return MACHINES.some((machine) => stem.endsWith(`.${machine}`));
}

/**
 * Pick the file a `.8bs` path actually means, given the machine in hand.
 *
 * With a machine: its variant if one exists, else the plain file. With
 * neither, but with *other* machines' variants present, the file genuinely
 * has nothing for this target — `8BS3002`, the same code a conditional
 * package entry gives for a machine it has no branch for, because it is the
 * same situation spelled in filenames. Without a machine (`8bs check` and
 * the editor analyse files, not builds): the plain file if it exists, else
 * `path: null` — "valid, and target-dependent" — if any variant does.
 *
 * A path that already names a machine's version (`x.nes.8bs`) is taken
 * literally: it is the explicit form, and stacking another suffix on it
 * would mean nothing.
 *
 * Returns `null` when nothing exists at all, so the caller can report the
 * missing file with the code that fits how the path was named.
 */
function chooseVariant(specifier, path, machine) {
  const base = existsSync(path);
  if (isVariantPath(path)) return base ? { path } : null;
  if (machine) {
    const variant = variantOf(path, machine);
    if (existsSync(variant)) return { path: variant };
    if (base) return { path };
    const others = MACHINES.filter((m) => existsSync(variantOf(path, m)));
    if (others.length > 0) {
      return {
        code: Codes.NOT_ON_THIS_TARGET,
        message: `'${specifier}' has no version for the ${machine} target (targets: ${others.join(', ')})`,
      };
    }
    return null;
  }
  if (base) return { path };
  if (MACHINES.some((m) => existsSync(variantOf(path, m)))) return { path: null };
  return null;
}

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
 * A package's `"8bitscript".native` list: files that are not 8BitScript
 * but belong in the build anyway — hand-written 6502 assembly, or data such
 * as @8bitscript/nes's CHR-ROM font, which no .8bs construct can express
 * yet. Paths are relative to the package and resolved here to absolute ones;
 * the linker collects them across the module graph and the 6502 backend
 * hands them to LLVM-MOS alongside the generated C. A package that ships
 * only .8bs simply has no such field. Every listed file must exist: a
 * package whose manifest names a file it does not ship is `8BS2008`,
 * reported at resolution time for the same reason a missing entry is —
 * before anything is built against it.
 */
function nativeSourcesOf(specifier, packageDir, manifest) {
  const native = manifest?.['8bitscript']?.native;
  if (native === undefined) return { native: [] };
  if (!Array.isArray(native) || native.some((v) => typeof v !== 'string')) {
    return {
      code: Codes.NOT_AN_8BS_PACKAGE,
      message: `'${specifier}' has a malformed "8bitscript".native value: expected an array of relative paths`,
    };
  }
  const resolved = [];
  for (const value of native) {
    const target = resolvePath(packageDir, value);
    if (!existsSync(target)) {
      return {
        code: Codes.MISSING_NATIVE_SOURCE,
        message: `'${specifier}' declares native source '${value}', which does not exist`,
      };
    }
    resolved.push(target);
  }
  return { native: resolved };
}

/**
 * One machine's entry value: a relative path into the package, or a bare
 * specifier delegating to another package (resolved from the package's own
 * directory, so its own dependencies serve the delegation). A relative
 * entry carries its own package's native sources; a delegation carries the
 * delegated package's, since that is whose code is actually being linked.
 */
function resolveEntryValue(specifier, packageDir, value, options, seen, native = []) {
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
    return { path: target, native };
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
function resolveConditionalEntry(specifier, packageDir, entry, options, seen, native) {
  const { machine } = options;
  if (machine) {
    const value = entry[machine];
    if (value === undefined) {
      return {
        code: Codes.NOT_ON_THIS_TARGET,
        message: `'${specifier}' has no entry for the ${machine} target (targets: ${Object.keys(entry).join(', ')})`,
      };
    }
    return resolveEntryValue(specifier, packageDir, value, options, seen, native);
  }

  for (const [branchMachine, value] of Object.entries(entry)) {
    const resolved = resolveEntryValue(
      specifier, packageDir, value,
      { ...options, machine: branchMachine }, new Set(seen), native,
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
 * @param {{ machine?: string }} [options]
 *   The machine being built for (one of MACHINES), if one is known;
 *   conditional package entries resolve to that machine's branch, and a
 *   `.8bs` file with a `.<machine>.8bs` twin resolves to the twin.
 * @returns {{ path: string|null, native?: string[] } | { code: string, message: string } | null}
 *   `native` — absolute paths of the resolved package's `"8bitscript".native`
 *   files (see nativeSourcesOf) — rides along with a package resolution;
 *   a relative import has none.
 */
export function resolveSpecifier(specifier, fromFile, options = {}, seen = new Set()) {
  const fromDir = dirname(fromFile);

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    if (!specifier.endsWith('.8bs')) return null;
    const target = resolvePath(fromDir, specifier);
    // `./hardware.8bs` on the NES is `./hardware.nes.8bs` when that file
    // exists beside it — see chooseVariant.
    const chosen = chooseVariant(specifier, target, options.machine);
    if (!chosen) {
      return { code: Codes.UNRESOLVED_RELATIVE_IMPORT, message: `cannot find module '${specifier}'` };
    }
    return chosen;
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
    // A package's entry follows the same filename rule a relative import
    // does: `./src/index.8bs` with an `index.nes.8bs` beside it is the NES
    // version of the package, without the manifest having to say so.
    const target = resolvePath(packageDir, entry);
    const chosen = chooseVariant(specifier, target, options.machine);
    if (!chosen) {
      return { code: Codes.MISSING_PACKAGE_ENTRY, message: `'${specifier}' declares entry '${entry}', which does not exist` };
    }
    if (chosen.code) return chosen;
    const sources = nativeSourcesOf(specifier, packageDir, manifest);
    if (sources.code) return sources;
    return { path: chosen.path, native: sources.native };
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const sources = nativeSourcesOf(specifier, packageDir, manifest);
    if (sources.code) return sources;
    return resolveConditionalEntry(specifier, packageDir, entry, options, seen, sources.native);
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
