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
// carries an "8bitscript" entry field, a package subpath (`@scope/name/thing`)
// resolves through that package's "8bitscript".exports map, and Node itself
// is never asked to understand a .8bs file.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { TokenKind } from '../lexer/index.mjs';

/** A bare specifier naming exactly one package: `name` or `@scope/name`. */
const BARE_PACKAGE = /^(?:@[^/\s]+\/[^/\s]+|[^@./\s][^/\s]*)$/;

/**
 * A package name followed by a subpath: `name/thing`, `@scope/name/thing`,
 * or deeper. Group 1 is the package, group 2 the subpath — the key the
 * package's `"8bitscript".exports` map is looked up by, as `./thing`, the
 * same shape Node's own "exports" field uses so nobody learns a second one.
 */
const PACKAGE_SUBPATH = /^((?:@[^/\s]+\/)?[^@./\s][^/\s]*)\/([^\s]+)$/;

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
 *
 * With a hardware tag as well — one of the tags the build's hardware
 * carries (`8032` on a PET built as an 8032, `expanded` on a VIC-20 with
 * 8K or more) — the twin is one level more specific:
 * `geometry.pet.8032.8bs`, the tag after the machine's name. It is looked
 * for first, and a machine's plain twin is what every other build of that
 * machine gets.
 */
export function variantOf(path, machine, tag) {
  const stem = path.slice(0, -'.8bs'.length);
  return tag ? `${stem}.${machine}.${tag}.8bs` : `${stem}.${machine}.8bs`;
}

/**
 * The hardware tags a build carries, from the options a caller passes:
 * `tags` outright, or the older single `profile`, which is one tag.
 */
export function tagsOf(options = {}) {
  if (Array.isArray(options.tags)) return options.tags;
  return options.profile ? [options.profile] : [];
}

/**
 * Whether a path already names one machine's version — `x.nes.8bs` — or
 * one hardware tag's: `x.pet.8032.8bs`. A tag is one word (letters,
 * digits, `_`, `-`), so `x.pet.8032.8bs` is recognised and `x.data.8bs` is
 * not: `data` is no machine.
 */
export function isVariantPath(path) {
  const stem = path.slice(0, -'.8bs'.length);
  return MACHINES.some((machine) => stem.endsWith(`.${machine}`)
    || new RegExp(`\\.${machine}\\.[A-Za-z0-9_-]+$`).test(stem));
}

/**
 * Every system-specific twin of `path` that exists beside it — a machine's
 * (`x.nes.8bs`) or a tag's (`x.pet.8032.8bs`) — as `{ machine, tag }`
 * pairs, `tag` undefined for a machine's plain twin. One directory
 * listing, filtered by name, rather than a probe per machine per possible
 * tag: the tags are not the resolver's to know.
 */
function variantsPresent(path) {
  const stem = basename(path, '.8bs');
  let entries;
  try {
    entries = readdirSync(dirname(path));
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.startsWith(`${stem}.`) || !entry.endsWith('.8bs')) continue;
    const suffix = entry.slice(stem.length + 1, -'.8bs'.length).split('.');
    if (!MACHINES.includes(suffix[0])) continue;
    if (suffix.length === 1) found.push({ machine: suffix[0] });
    else if (suffix.length === 2 && /^[A-Za-z0-9_-]+$/.test(suffix[1])) found.push({ machine: suffix[0], tag: suffix[1] });
  }
  return found;
}

/**
 * Pick the file a `.8bs` path actually means, given the machine — and the
 * hardware tags its build carries — in hand.
 *
 * With a machine: a tag's variant if exactly one of the build's tags has
 * one, else the machine's, else the plain file. Two tags each with a
 * variant of their own is `8BS3004`: the file has two versions that both
 * claim this build, and the resolver will not guess. With none of those,
 * but with *other* machines' or tags' variants present, the file
 * genuinely has nothing for this target — `8BS3002`, the same code a
 * conditional package entry gives for a machine it has no branch for,
 * because it is the same situation spelled in filenames. Without a
 * machine (`8bs check` and the editor analyse files, not builds): the
 * plain file if it exists, else `path: null` — "valid, and
 * target-dependent" — if any variant does.
 *
 * A path that already names a machine's or a tag's version
 * (`x.nes.8bs`, `x.pet.8032.8bs`) is taken literally: it is the explicit
 * form, and stacking another suffix on it would mean nothing.
 *
 * Returns `null` when nothing exists at all, so the caller can report the
 * missing file with the code that fits how the path was named.
 */
function chooseVariant(specifier, path, machine, tags = []) {
  const base = existsSync(path);
  if (isVariantPath(path)) return base ? { path } : null;
  if (machine) {
    const forTags = tags.filter((tag) => existsSync(variantOf(path, machine, tag)));
    if (forTags.length > 1) {
      return {
        code: Codes.AMBIGUOUS_VARIANT,
        message: `'${specifier}' has a version for each of this build's '${forTags.join("' and '")}' hardware — `
          + 'one file cannot serve two tags at once; give the build one of them, or one file both',
      };
    }
    if (forTags.length === 1) return { path: variantOf(path, machine, forTags[0]) };
    const variant = variantOf(path, machine);
    if (existsSync(variant)) return { path: variant };
    if (base) return { path };
    const others = variantsPresent(path);
    if (others.length > 0) {
      const names = [...new Set(others.map((v) => (v.tag ? `${v.machine} (${v.tag})` : v.machine)))];
      const here = tags.length > 0 ? `${machine} target's ${tags.join(', ')} hardware` : `${machine} target`;
      return {
        code: Codes.NOT_ON_THIS_TARGET,
        message: `'${specifier}' has no version for the ${here} (targets: ${names.join(', ')})`,
      };
    }
    return null;
  }
  if (base) return { path };
  if (variantsPresent(path).length > 0) return { path: null };
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
 * A package's `"8bitscript".exports` map: the subpaths it offers besides its
 * entry, each a relative path into the package — `{ "./screen": "./src/
 * screen.8bs" }` makes `@scope/name/screen` resolve to that file. This is
 * how a target package such as @8bitscript/c64 offers its `screen` and
 * `text` implementations to the portable @8bitscript/screen and
 * @8bitscript/text packages, whose machine-keyed entries delegate to
 * `@8bitscript/c64/screen` and so on: the per-machine code stays inside the
 * machine's own package, next to the registers it is built on.
 *
 * The exported file follows the same filename rule every other .8bs path
 * does (`screen.8bs` with a `screen.nes.8bs` beside it — see chooseVariant),
 * and the package's native sources ride along with it, since it is that
 * package's code being linked. A subpath the map has no key for is
 * `8BS2011`: the package is sound, it just does not offer that; a key whose
 * file does not exist is `8BS2003`, like a missing entry.
 */
function resolveSubpath(specifier, name, packageDir, manifest, subpath, options) {
  const key = `./${subpath}`;
  const exports = manifest?.['8bitscript']?.exports;
  if (exports !== undefined && (typeof exports !== 'object' || exports === null || Array.isArray(exports))) {
    return {
      code: Codes.NOT_AN_8BS_PACKAGE,
      message: `'${name}' has a malformed "8bitscript".exports value: expected an object of './subpath' keys to relative paths`,
    };
  }
  const value = exports?.[key];
  if (value === undefined) {
    const offered = exports ? Object.keys(exports) : [];
    return {
      code: Codes.NO_SUCH_SUBPATH,
      message: offered.length > 0
        ? `'${name}' does not export '${key}' (exports: ${offered.join(', ')})`
        : `'${name}' does not export '${key}': its package.json has no "8bitscript".exports field`,
    };
  }
  if (typeof value !== 'string' || !value.startsWith('.')) {
    return {
      code: Codes.NOT_AN_8BS_PACKAGE,
      message: `'${name}' has a malformed "8bitscript".exports value for '${key}': expected a relative path`,
    };
  }
  const target = resolvePath(packageDir, value);
  const chosen = chooseVariant(specifier, target, options.machine, tagsOf(options));
  if (!chosen) {
    return { code: Codes.MISSING_PACKAGE_ENTRY, message: `'${name}' exports '${key}' as '${value}', which does not exist` };
  }
  if (chosen.code) return chosen;
  const sources = nativeSourcesOf(name, packageDir, manifest);
  if (sources.code) return sources;
  return { path: chosen.path, native: sources.native };
}

/**
 * One machine's entry value: a relative path into the package, or a bare
 * specifier delegating to another package — its entry, or one of its
 * subpaths (`@8bitscript/c64/screen`) — resolved from the package's own
 * directory, so its own dependencies serve the delegation. A relative
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
 * specifies — a relative `.8bs` path, a bare package name (its entry), or a
 * package subpath (an `"8bitscript".exports` key). A relative specifier
 * without a `.8bs` extension is unspecified, so it returns `null` — not
 * resolved, not an error — rather than guessing at a rule.
 *
 * @param {string} specifier
 * @param {string} fromFile  Absolute path of the importing file.
 * @param {{ machine?: string, tags?: string[], profile?: string }} [options]
 *   The machine being built for (one of MACHINES), if one is known;
 *   conditional package entries resolve to that machine's branch, and a
 *   `.8bs` file with a `.<machine>.8bs` twin resolves to the twin. With
 *   the build's hardware tags as well (`tags`; the older `profile` is one
 *   tag), a `.<machine>.<tag>.8bs`
 *   twin is taken before the machine's own (see variantOf).
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
    const chosen = chooseVariant(specifier, target, options.machine, tagsOf(options));
    if (!chosen) {
      return { code: Codes.UNRESOLVED_RELATIVE_IMPORT, message: `cannot find module '${specifier}'` };
    }
    return chosen;
  }

  const subpath = PACKAGE_SUBPATH.exec(specifier);
  if (!subpath && !BARE_PACKAGE.test(specifier)) return null;
  const name = subpath ? subpath[1] : specifier;

  const packageDir = findPackageDir(fromDir, name);
  if (!packageDir) {
    return { code: Codes.UNRESOLVED_PACKAGE, message: `cannot find package '${name}'. Is it installed?` };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  } catch {
    manifest = null;
  }

  if (subpath) {
    if (!manifest?.['8bitscript']) {
      return {
        code: Codes.NOT_AN_8BS_PACKAGE,
        message: `'${name}' is not an 8BitScript package: its package.json has no "8bitscript" field`,
      };
    }
    return resolveSubpath(specifier, name, packageDir, manifest, subpath[2], options);
  }

  const entry = manifest?.['8bitscript']?.entry;
  if (typeof entry === 'string') {
    // A package's entry follows the same filename rule a relative import
    // does: `./src/index.8bs` with an `index.nes.8bs` beside it is the NES
    // version of the package, without the manifest having to say so.
    const target = resolvePath(packageDir, entry);
    const chosen = chooseVariant(specifier, target, options.machine, tagsOf(options));
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
