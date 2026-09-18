// Shared 8bitscript.config.ts loading, used by both `8bs build` and `8bs
// check` (and, through them, anything else that needs a project's config
// without duplicating the loader).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LOCALE_NAME, MACHINES, isLocaleName } from '@8bitscript/compiler';

/** Default directory of `<locale>.8bs` message catalogs. */
export const DEFAULT_CATALOG_DIR = 'src/i18n';

// 8bitscript.config.ts is the current name; 8bs.config.ts (every project
// through 0.3.0, including this repo's own examples) still loads so
// existing projects don't break on upgrade. Checked in this order — a
// project with both gets the new name silently, not a conflict, since
// there's nothing to reconcile: whichever loads first wins.
const CONFIG_FILENAMES = ['8bitscript.config.ts', '8bs.config.ts'];

/**
 * The project's 8bitscript.config.ts (or the older 8bs.config.ts), if
 * present. Node 26 imports TypeScript with type stripping, so the config is
 * an ordinary module, not a parsed format.
 *
 * @param {string} dir
 * @param {string} [label] Prefixes a load error, e.g. "8bs build".
 */
export async function loadConfig(dir, label = '8bs') {
  for (const filename of CONFIG_FILENAMES) {
    const path = join(dir, filename);
    if (!existsSync(path)) continue;
    try {
      const module = await import(pathToFileURL(path).href);
      return module.default ?? null;
    } catch (error) {
      process.stderr.write(`${label}: cannot load ${filename}: ${error.message}\n`);
      return null;
    }
  }
  return null;
}

/**
 * Options a project may still carry in its 8bitscript.config.ts that no
 * longer do anything. A build names them rather than ignoring them: a knob
 * that silently stopped working is worse than one that says so, and the
 * project can delete the line knowing what it bought.
 *
 * `restoreOnExit` saved the PET's character-set register on the way in and
 * put it back on the way out, so a machine that booted in graphics/upper
 * case returned to an upper-case `READY.`. The bit is retroactive — it
 * selects the ROM the video hardware reads for every cell already on
 * screen — so restoring it re-rendered the text the program had just
 * drawn, through the set it had switched away from to draw it. It undid
 * the reason it existed. See packages/pet/AGENTS.md.
 */
export const RETIRED_OPTIONS = new Map([
  ['restoreOnExit', 'a program now exits in whatever character set it selected; putting the old one back re-rendered the text it had just drawn'],
]);

/**
 * One message per retired option `config` still sets — empty for the
 * projects that never did, which is all of them but the ones written
 * against 0.5.0.
 *
 * @param {object|null} config
 * @returns {string[]}
 */
export function retiredOptionWarnings(config) {
  if (!config || typeof config !== 'object') return [];
  return [...RETIRED_OPTIONS]
    .filter(([name]) => name in config)
    .map(([name, why]) => `8bitscript.config.ts's ${name} no longer does anything: ${why}`);
}

/**
 * The project's logical frame rate — what `waitFrame()` runs at, the same on every target,
 * independent of --pal (which only selects a real hardware/emulator
 * region, not the logical rate; see packages/compiler/src/mos FRAME_SYNC).
 * Defaults to 60; `#frames(...)` durations and the waitFrame() runtime are
 * both built against whatever this resolves to.
 *
 * @param {object|null} config
 * @returns {{ ok: true, frameRate: number } | { ok: false, error: string }}
 */
export function resolveFrameRate(config) {
  const frameRate = config?.frameRate ?? 60;
  if (!Number.isInteger(frameRate) || frameRate <= 0) {
    return {
      ok: false,
      error: `8bitscript.config.ts's frameRate must be a positive integer, got ${JSON.stringify(config?.frameRate)}`,
    };
  }
  return { ok: true, frameRate };
}

/**
 * `--locale <name>` on `8bs build` and `8bs run`: the locale this one
 * build is for, over whatever the config says (see resolveLocale).
 *
 * @param {string[]} args
 * @returns {{ ok: true, locale: string|undefined, consumed: number[] } | { ok: false, error: string }}
 */
export function localeArg(args) {
  const index = args.indexOf('--locale');
  if (index < 0) return { ok: true, locale: undefined, consumed: [] };
  const name = args[index + 1];
  if (index + 1 >= args.length || name.startsWith('-')) return { ok: false, error: '--locale expects a name, e.g. --locale de' };
  return { ok: true, locale: name, consumed: [index, index + 1] };
}

/**
 * Why `name` cannot be a locale, or null when it can. The shape is the
 * compiler's LOCALE_NAME; a machine's name is refused there too. `tags`
 * are the hardware tags the machine's catalog can put in a file name
 * (`8032`, `expanded`, `on`), which a locale must not be either: the
 * resolver tells `x.pet.8032.8bs` from `x.pet.de.8bs` by which words are
 * which, and one word that is both would make one file mean two things.
 *
 * @param {unknown} name
 * @param {string[]} [tags]
 * @returns {string|null}
 */
export function localeProblem(name, tags = []) {
  if (typeof name !== 'string') return `a locale is a name in quotes, got ${JSON.stringify(name)}`;
  if (!LOCALE_NAME.test(name)) {
    return `'${name}' is not a locale name: two to eight lower-case letters, with an optional -region (de, en, pt-br, zh-hans)`;
  }
  if (MACHINES.includes(name)) return `'${name}' is a machine's name, not a locale`;
  if (tags.includes(name)) return `'${name}' is a hardware tag on this machine's catalog, not a locale — a file named x.${name}.8bs would mean two things`;
  return null;
}

/**
 * Locale `.8bs` basenames in `dir` that pass `isLocaleName`.
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
    .filter((name) => name.endsWith('.8bs') && !name.endsWith('.8bx'))
    .map((name) => name.slice(0, -4))
    .filter((name) => isLocaleName(name) && !name.includes('.'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Whether this project has a catalog directory with at least one locale file.
 *
 * @param {object|null} config
 * @param {string} [projectDir]
 */
export function catalogsPresent(config, projectDir = process.cwd()) {
  const dir = join(projectDir, config?.i18n?.catalog ?? DEFAULT_CATALOG_DIR);
  return discoverCatalogLocales(dir).length > 0;
}

/**
 * The project's `i18n` block: catalog directory, locales, charset, and
 * default/fallback names. A project with neither the block nor a catalog
 * directory is `{ ok: true, i18n: undefined }`.
 *
 * @param {object|null} config
 * @param {{ projectDir?: string, tags?: string[] }} [choice]
 * @returns {{ ok: true, i18n: object|undefined } | { ok: false, error: string }}
 */
export function resolveI18n(config, { projectDir = process.cwd(), tags = [] } = {}) {
  const block = config?.i18n;
  const catalogRel = block?.catalog ?? DEFAULT_CATALOG_DIR;
  if (block?.catalog !== undefined && typeof block.catalog !== 'string') {
    return { ok: false, error: `8bitscript.config.ts's i18n.catalog must be a path in quotes, got ${JSON.stringify(block.catalog)}` };
  }
  const catalogDir = join(projectDir, catalogRel);
  const discovered = discoverCatalogLocales(catalogDir);
  if (!block && discovered.length === 0) return { ok: true, i18n: undefined };

  const charset = block?.charset ?? 'transliterate';
  if (charset !== 'transliterate' && charset !== 'strict') {
    return { ok: false, error: `8bitscript.config.ts's i18n.charset must be 'transliterate' or 'strict', got ${JSON.stringify(block.charset)}` };
  }

  const checkName = (where, value) => {
    const problem = localeProblem(value, tags);
    return problem ? `${where}: ${problem}` : null;
  };

  if (block?.defaultLocale !== undefined) {
    const problem = checkName("8bitscript.config.ts's i18n.defaultLocale", block.defaultLocale);
    if (problem) return { ok: false, error: problem };
  }
  if (block?.fallbackLocale !== undefined) {
    const problem = checkName("8bitscript.config.ts's i18n.fallbackLocale", block.fallbackLocale);
    if (problem) return { ok: false, error: problem };
  }

  let locales;
  if (block?.locales !== undefined) {
    if (!Array.isArray(block.locales) || block.locales.some((name) => typeof name !== 'string')) {
      return { ok: false, error: "8bitscript.config.ts's i18n.locales must be an array of locale names" };
    }
    for (const name of block.locales) {
      const problem = checkName("8bitscript.config.ts's i18n.locales", name);
      if (problem) return { ok: false, error: problem };
    }
    const listed = [...block.locales];
    const missing = listed.filter((name) => !discovered.includes(name));
    const extra = discovered.filter((name) => !listed.includes(name));
    if (missing.length > 0) {
      return { ok: false, error: `8bitscript.config.ts's i18n.locales names '${missing.join("', '")}', but ${catalogRel}/${missing[0]}.8bs is missing` };
    }
    if (extra.length > 0) {
      return { ok: false, error: `${catalogRel}/${extra[0]}.8bs is a catalog file that i18n.locales does not list` };
    }
    locales = listed;
  } else {
    locales = discovered;
  }

  const defaultLocale = block?.defaultLocale ?? 'en';
  const fallbackLocale = block?.fallbackLocale ?? defaultLocale;
  if (locales.length > 0 && !locales.includes(defaultLocale)) {
    return { ok: false, error: `8bitscript.config.ts's i18n.defaultLocale '${defaultLocale}' has no ${catalogRel}/${defaultLocale}.8bs` };
  }
  if (locales.length > 0 && !locales.includes(fallbackLocale)) {
    return { ok: false, error: `8bitscript.config.ts's i18n.fallbackLocale '${fallbackLocale}' has no ${catalogRel}/${fallbackLocale}.8bs` };
  }

  return {
    ok: true,
    i18n: {
      catalogDir,
      catalog: catalogRel,
      locales,
      defaultLocale,
      fallbackLocale,
      charset,
    },
  };
}

/**
 * The locale a build is for, if it is for one. Nearest wins: the command
 * line's `--locale` (or a `release` entry's `locale`, which is the same
 * request written down), else the target's `locale` under `targets`, else
 * the project's `locale`, else `i18n.defaultLocale`, else `'en'` when a
 * catalog directory exists. No locale at all is the default for projects
 * that never heard of locales: nothing that ends in `.<locale>` is read.
 *
 * @param {object|null} config
 * @param {{ target?: string, override?: string, tags?: string[], projectDir?: string }} [choice]
 * @returns {{ ok: true, locale: string|undefined } | { ok: false, error: string }}
 */
export function resolveLocale(config, { target, override, tags = [], projectDir } = {}) {
  const targetLocale = (target && config?.targets && !Array.isArray(config.targets)) ? config.targets[target]?.locale : undefined;
  const candidates = [
    ['--locale', override],
    [`8bitscript.config.ts's targets.${target}.locale`, targetLocale],
    ["8bitscript.config.ts's locale", config?.locale],
    ["8bitscript.config.ts's i18n.defaultLocale", config?.i18n?.defaultLocale],
  ];
  for (const [where, value] of candidates) {
    if (value === undefined) continue;
    const problem = localeProblem(value, tags);
    if (problem) return { ok: false, error: `${where}: ${problem}` };
    return { ok: true, locale: value };
  }
  if (catalogsPresent(config, projectDir ?? process.cwd())) {
    return { ok: true, locale: 'en' };
  }
  return { ok: true, locale: undefined };
}

/** Whether a locale name has the shape one must — for callers that only need a yes or no. */
export { isLocaleName };
