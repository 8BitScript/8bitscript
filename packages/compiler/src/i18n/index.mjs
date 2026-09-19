// Message catalogs: `src/i18n/<locale>.8bs` imported as `@8bitscript/i18n/catalog`.
//
// A catalog is exported namespaces of string consts. The selected locale is
// merged with the fallback at link time, placeholders `{name}` must match the
// default locale, and Latin Unicode is transliterated into the portable set
// before anything reaches the machine. One locale, one image.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

import { NodeType } from '../ast/index.mjs';
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { tokenize } from '../lexer/index.mjs';
import { parse } from '../parser/index.mjs';
import { isLocaleName, isSourceFile, sourceKindOf, stripSourceExtension } from '../source/index.mjs';

export const CATALOG_SPECIFIER = '@8bitscript/i18n/catalog';
export const DEFAULT_CATALOG = 'src/i18n';
export const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** The portable screen set — the same rule as checker/index.mjs. */
export const PORTABLE_CHARACTERS = /^[ 0-9A-Za-z!,\-.:?]*$/;

/** Catalog templates may also hold `{name}` placeholders; format strips them. */
export const CATALOG_CHARACTERS = /^[ 0-9A-Za-z!,\-.:?{}]*$/;

/** Latin extras a catalog may spell; width is the replacement's length. */
export const TRANSLITERATIONS = Object.freeze({
  Ä: 'AE', Ö: 'OE', Ü: 'UE',
  ä: 'ae', ö: 'oe', ü: 'ue',
  ß: 'SS',
});

/**
 * `{name}` placeholders in `text`, in source order, unique.
 *
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
export function placeholdersOf(text) {
  if (typeof text !== 'string') return [];
  const names = [];
  const seen = new Set();
  PLACEHOLDER.lastIndex = 0;
  let match;
  while ((match = PLACEHOLDER.exec(text)) !== null) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    names.push(match[1]);
  }
  return names;
}

/**
 * Substitute `{name}` from `params`. Missing or leftover names are an error.
 *
 * @param {string} template
 * @param {Record<string, string>} params
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
export function formatMessage(template, params = {}) {
  const needed = placeholdersOf(template);
  const extra = Object.keys(params).filter((name) => !needed.includes(name));
  const missing = needed.filter((name) => params[name] === undefined);
  if (missing.length > 0) {
    return { ok: false, error: `i18n.format is missing {${missing[0]}}` };
  }
  if (extra.length > 0) {
    return { ok: false, error: `i18n.format was given '${extra[0]}', which is not a placeholder in the template` };
  }
  const text = template.replace(PLACEHOLDER, (_, name) => params[name]);
  return { ok: true, text };
}

/**
 * Map Latin extras into the portable set. Unmapped non-portable characters
 * are listed; mapped text is always returned so length can be measured.
 *
 * @param {string} text
 * @returns {{ text: string, unmapped: string[] }}
 */
export function transliterate(text) {
  const unmapped = [];
  let out = '';
  for (const ch of text) {
    if (CATALOG_CHARACTERS.test(ch)) {
      out += ch;
      continue;
    }
    const mapped = TRANSLITERATIONS[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    unmapped.push(ch);
    out += ch;
  }
  return { text: out, unmapped };
}

/**
 * Locale `.8bs` basenames in `dir`.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function discoverCatalogLocales(dir) {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.8bs'))
    .map((name) => stripSourceExtension(name))
    .filter((name) => isLocaleName(name) && !name.includes('.'))
    // Ordinal, not localeCompare — this order feeds build output and must
    // not depend on the host's locale (see mos/debug.ts's own note).
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Whether `file` is a message catalog: a locale-named `.8bs` in the project's
 * catalog directory, or — without config — in a directory named `i18n`.
 *
 * @param {string} file
 * @param {{ catalogDir?: string }} [i18n]
 */
export function isCatalogFile(file, i18n) {
  if (!file || !isSourceFile(file)) return false;
  const stem = stripSourceExtension(basename(file));
  if (!isLocaleName(stem) || stem.includes('.')) return false;
  const parent = dirname(resolvePath(file));
  if (i18n?.catalogDir) return parent === resolvePath(i18n.catalogDir);
  return basename(parent) === 'i18n';
}

/**
 * Walk up from `fromFile` looking for `src/i18n` with at least one locale file.
 *
 * @param {string} fromFile
 * @returns {string|null}
 */
export function inferCatalogDir(fromFile) {
  if (!fromFile) return null;
  let dir = dirname(fromFile);
  for (;;) {
    const candidate = join(dir, DEFAULT_CATALOG);
    if (discoverCatalogLocales(candidate).length > 0) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Apply the catalog charset to string literals in `ast`. Mutates values.
 * Import specifiers are left alone.
 *
 * @param {object} ast
 * @param {string} file
 * @param {'transliterate'|'strict'} charset
 * @returns {object[]}
 */
export function applyCatalogCharset(ast, file, charset = 'transliterate') {
  const diagnostics = [];
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === NodeType.StringLiteral && parent?.type !== NodeType.ImportDeclaration) {
      const value = node.value ?? '';
      if (charset === 'strict') {
        if (!CATALOG_CHARACTERS.test(value)) {
          const bad = [...value].find((ch) => !CATALOG_CHARACTERS.test(ch));
          diagnostics.push(diagnostic(
            Codes.UNPORTABLE_CHARACTER,
            `'${bad}' is not in the portable character set (space, 0-9, A-Z, a-z, and ! , - . : ?)`,
            file, node.start, node.length,
          ));
        }
        return;
      }
      const mapped = transliterate(value);
      node.value = mapped.text;
      if (mapped.unmapped.length > 0) {
        const bad = mapped.unmapped[0];
        diagnostics.push(diagnostic(
          Codes.UNPORTABLE_CHARACTER,
          `'${bad}' is not in the portable character set and has no Latin transliteration`,
          file, node.start, node.length,
        ));
      }
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item, node);
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        visit(value, node);
      }
    }
  };
  visit(ast, null);
  return diagnostics;
}

/**
 * Exported namespaces of string consts in a catalog AST.
 *
 * @param {object} ast
 * @param {string} file
 * @returns {{ namespaces: Map<string, Map<string, object>>, extras: object[] }}
 */
export function catalogSchema(ast, file) {
  const namespaces = new Map();
  const extras = [];
  for (const node of ast.body ?? []) {
    if (!node) continue;
    if (node.type === NodeType.ImportDeclaration) continue;
    if (node.type === NodeType.NamespaceDeclaration && node.exported && node.name) {
      const members = new Map();
      for (const member of node.members ?? []) {
        if (!member) continue;
        if (
          member.type === NodeType.VariableDeclaration
          && member.kind === 'const'
          && member.typeAnnotation?.name === 'string'
          && member.name
        ) {
          const value = member.initializer?.type === NodeType.StringLiteral ? member.initializer.value : null;
          members.set(member.name.name, {
            value,
            placeholders: placeholdersOf(value),
            start: member.name.start,
            length: member.name.length,
            file,
          });
          continue;
        }
        extras.push({
          message: `a message catalog may export only namespace string consts; '${member.name?.name ?? member.type}' is not one`,
          start: member.start ?? node.start,
          length: member.length ?? node.length,
          file,
        });
      }
      namespaces.set(node.name.name, members);
      continue;
    }
    extras.push({
      message: `a message catalog may export only namespaces of string consts`,
      start: node.start ?? 0,
      length: node.length ?? 0,
      file,
    });
  }
  return { namespaces, extras };
}

function parseCatalogFile(file) {
  const text = readFileSync(file, 'utf8');
  const sourceKind = sourceKindOf(file) ?? '.8bs';
  const { tokens, diagnostics: lexical } = tokenize(text, file, { sourceKind });
  const { ast, diagnostics: syntax } = parse(tokens, text, file, { sourceKind });
  return { file, text, ast, diagnostics: [...lexical, ...syntax] };
}

/**
 * Compare `other` against `baseline` (the default locale). Extra keys and
 * placeholder mismatches are errors; missing keys are filled later.
 *
 * @param {object} baseline
 * @param {object} other
 * @param {string} locale
 * @returns {object[]}
 */
export function compareCatalogSchemas(baseline, other, locale) {
  const diagnostics = [];
  for (const extra of other.extras ?? []) {
    diagnostics.push(diagnostic(Codes.CATALOG, extra.message, extra.file, extra.start, extra.length));
  }
  for (const [ns, members] of other.namespaces) {
    if (!baseline.namespaces.has(ns)) {
      const first = members.values().next().value;
      diagnostics.push(diagnostic(
        Codes.CATALOG_SCHEMA,
        `locale '${locale}' exports namespace '${ns}', which the default locale does not`,
        first?.file ?? other.file, first?.start ?? 0, first?.length ?? 0,
      ));
      continue;
    }
    const expected = baseline.namespaces.get(ns);
    for (const [name, member] of members) {
      if (!expected.has(name)) {
        diagnostics.push(diagnostic(
          Codes.CATALOG_SCHEMA,
          `locale '${locale}' exports ${ns}.${name}, which the default locale does not`,
          member.file, member.start, member.length,
        ));
        continue;
      }
      const want = expected.get(name).placeholders;
      const have = member.placeholders;
      if (want.length !== have.length || want.some((n, i) => n !== have[i])) {
        diagnostics.push(diagnostic(
          Codes.CATALOG_PLACEHOLDER,
          `${ns}.${name} in locale '${locale}' has placeholders {${have.join('}, {') || 'none'}}; the default locale has {${want.join('}, {') || 'none'}}`,
          member.file, member.start, member.length,
        ));
      }
    }
  }
  return diagnostics;
}

function quote8bs(text) {
  return JSON.stringify(text);
}

function emitCatalog(baseline, values) {
  const lines = [
    '// Merged message catalog — selected locale, with missing keys from the fallback.',
    '// Generated by the compiler; do not edit.',
    '',
  ];
  for (const [ns, members] of baseline.namespaces) {
    lines.push(`export namespace ${ns} {`);
    for (const name of members.keys()) {
      const value = values.get(ns)?.get(name) ?? '';
      lines.push(`    const ${name}: string = ${quote8bs(value)};`);
    }
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

function takeValue(member, charset, diagnostics) {
  if (member.value === null) return '';
  if (charset === 'strict') {
    if (!CATALOG_CHARACTERS.test(member.value)) {
      const bad = [...member.value].find((ch) => !CATALOG_CHARACTERS.test(ch));
      diagnostics.push(diagnostic(
        Codes.UNPORTABLE_CHARACTER,
        `'${bad}' is not in the portable character set (space, 0-9, A-Z, a-z, and ! , - . : ?)`,
        member.file, member.start, member.length,
      ));
    }
    return member.value;
  }
  const mapped = transliterate(member.value);
  if (mapped.unmapped.length > 0) {
    diagnostics.push(diagnostic(
      Codes.UNPORTABLE_CHARACTER,
      `'${mapped.unmapped[0]}' is not in the portable character set and has no Latin transliteration`,
      member.file, member.start, member.length,
    ));
  }
  return mapped.text;
}

/**
 * Load every locale in the catalog directory, check schema/placeholders,
 * merge fallback into the selected locale, and emit one portable module.
 *
 * @param {{ locale?: string, i18n?: object }} options
 * @returns {{ ok: boolean, path?: string, text?: string, diagnostics: object[] }}
 */
export function prepareCatalog(options = {}) {
  const diagnostics = [];
  const i18n = options.i18n;
  if (!i18n?.catalogDir) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        Codes.CATALOG,
        `'${CATALOG_SPECIFIER}' needs a message catalog (src/i18n/<locale>.8bs, or i18n.catalog in 8bitscript.config.ts)`,
        options.fromFile ?? '<unknown>', 0, 0,
      )],
    };
  }

  const catalogDir = i18n.catalogDir;
  const defaultLocale = i18n.defaultLocale ?? 'en';
  const fallbackLocale = i18n.fallbackLocale ?? defaultLocale;
  const selectedLocale = options.locale ?? defaultLocale;
  const charset = i18n.charset ?? 'transliterate';
  const locales = i18n.locales?.length ? i18n.locales : discoverCatalogLocales(catalogDir);

  const defaultPath = join(catalogDir, `${defaultLocale}.8bs`);
  if (!existsSync(defaultPath)) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        Codes.CATALOG,
        `message catalog '${defaultPath}' is missing — the default locale '${defaultLocale}' needs a file`,
        options.fromFile ?? defaultPath, 0, 0,
      )],
    };
  }

  const parsed = new Map();
  for (const locale of locales) {
    const path = join(catalogDir, `${locale}.8bs`);
    if (!existsSync(path)) {
      diagnostics.push(diagnostic(
        Codes.CATALOG,
        `message catalog '${path}' is missing`,
        path, 0, 0,
      ));
      continue;
    }
    const module = parseCatalogFile(path);
    diagnostics.push(...module.diagnostics);
    parsed.set(locale, module);
  }
  if (!parsed.has(defaultLocale)) {
    return { ok: false, diagnostics };
  }

  const baselineAst = parsed.get(defaultLocale).ast;
  const baseline = catalogSchema(baselineAst, parsed.get(defaultLocale).file);
  for (const extra of baseline.extras) {
    diagnostics.push(diagnostic(Codes.CATALOG, extra.message, extra.file, extra.start, extra.length));
  }

  for (const [locale, module] of parsed) {
    if (locale === defaultLocale) continue;
    const schema = catalogSchema(module.ast, module.file);
    diagnostics.push(...compareCatalogSchemas(baseline, schema, locale));
  }

  const selected = parsed.get(selectedLocale) ?? parsed.get(fallbackLocale) ?? parsed.get(defaultLocale);
  const fallback = parsed.get(fallbackLocale) ?? parsed.get(defaultLocale);
  const selectedSchema = catalogSchema(selected.ast, selected.file);
  const fallbackSchema = catalogSchema(fallback.ast, fallback.file);

  const values = new Map();
  for (const [ns, members] of baseline.namespaces) {
    const row = new Map();
    for (const [name, def] of members) {
      const fromSelected = selectedSchema.namespaces.get(ns)?.get(name);
      const fromFallback = fallbackSchema.namespaces.get(ns)?.get(name);
      const member = fromSelected ?? fromFallback ?? def;
      if (!fromSelected && !fromFallback && member === def && selectedLocale !== defaultLocale) {
        // Filled from the default locale — the schema allows a missing key.
      }
      row.set(name, takeValue(member, charset, diagnostics));
    }
    values.set(ns, row);
  }

  const selectedPath = existsSync(join(catalogDir, `${selectedLocale}.8bs`))
    ? join(catalogDir, `${selectedLocale}.8bs`)
    : defaultPath;
  const text = emitCatalog(baseline, values);
  const errors = diagnostics.filter((d) => d.severity !== 'warning');
  return { ok: errors.length === 0, path: selectedPath, text, diagnostics };
}

/**
 * Resolve `@8bitscript/i18n/catalog` to the merged selected catalog.
 *
 * @param {string} specifier
 * @param {string} fromFile
 * @param {{ locale?: string, i18n?: object }} options
 * @returns {{ path: string, text: string, catalog: true, diagnostics?: object[] } | { code: string, message: string } | null}
 */
export function resolveCatalogSpecifier(specifier, fromFile, options = {}) {
  if (specifier !== CATALOG_SPECIFIER) return null;
  if (!options.i18n) {
    const catalogDir = inferCatalogDir(fromFile);
    if (!catalogDir) {
      return {
        code: Codes.CATALOG,
        message: `'${CATALOG_SPECIFIER}' needs a message catalog (src/i18n/<locale>.8bs, or i18n.catalog in 8bitscript.config.ts)`,
      };
    }
    options.i18n = {
      catalogDir,
      defaultLocale: 'en',
      fallbackLocale: 'en',
      locales: discoverCatalogLocales(catalogDir),
      charset: 'transliterate',
    };
  }
  const localeKey = options.locale ?? options.i18n.defaultLocale ?? 'en';
  if (!options.i18n.prepared || options.i18n.preparedLocale !== localeKey) {
    options.i18n.prepared = prepareCatalog({ ...options, fromFile });
    options.i18n.preparedLocale = localeKey;
  }
  const prepared = options.i18n.prepared;
  if (!prepared.ok || !prepared.path) {
    const first = prepared.diagnostics?.[0];
    return {
      code: first?.code ?? Codes.CATALOG,
      message: first?.message ?? `'${CATALOG_SPECIFIER}' could not load a message catalog`,
      diagnostics: prepared.diagnostics,
    };
  }
  return { path: prepared.path, text: prepared.text, catalog: true, diagnostics: prepared.diagnostics };
}

/**
 * Whether `file` is this package's `@8bitscript/i18n` entry (any locale twin).
 *
 * @param {string} file
 */
export function isI18nPackageFile(file) {
  if (!file) return false;
  const normalized = file.replaceAll('\\', '/');
  return /\/i18n\/src\/index(?:\.[A-Za-z0-9-]+)?\.8bs$/.test(normalized);
}
