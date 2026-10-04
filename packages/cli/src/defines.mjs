// Values a build is handed: `--define NAME=VALUE` on the command line, a
// program's `define: { NAME: value }` in 8bitscript.config.8bs, and the
// `#define("NAME", default)` the program reads them with (the compiler's
// fold pass, packages/compiler/src/fold/index.mjs). This file is the CLI's
// half: parsing what a person typed, validating what a config declares,
// and the typo guard — a name handed to a program that never reads it is an
// error naming the nearest name it does read, because a `--define SEDD=42`
// that silently did nothing is the kind of bug that costs an afternoon.
import { DEFINE_NAME, defineKind } from '@8bitscript/compiler';

/**
 * One value, as typed after `NAME=`: `true`/`false` are booleans, a whole
 * number (decimal or 0x hex) is a number, and anything else is a string —
 * `"…"` in double quotes forces a string out of something that would
 * otherwise read as a number or a flag (`--define CODE='"007"'`).
 *
 * @param {string} raw
 * @returns {number|boolean|string}
 */
export function parseDefineValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  if (/^0x[0-9a-f]+$/i.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

/**
 * Every `--define NAME=VALUE` in a command's arguments, in the shape the
 * other argument readers use: the values, and the indices they took so the
 * caller can merge them into one `consumed` set. Repeatable; a later one for
 * the same name wins, as flags do.
 *
 * @param {string[]} args
 * @returns {{ ok: true, defines: Record<string, number|boolean|string>, consumed: number[] } | { ok: false, error: string }}
 */
export function defineArgs(args) {
  const defines = {};
  const consumed = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--define') continue;
    if (index + 1 >= args.length || args[index + 1].startsWith('-')) {
      return { ok: false, error: '--define expects NAME=VALUE, e.g. --define SEED=42' };
    }
    const spec = args[index + 1];
    const at = spec.indexOf('=');
    if (at <= 0) return { ok: false, error: `--define ${spec}: expected NAME=VALUE, e.g. --define SEED=42` };
    const name = spec.slice(0, at);
    if (!DEFINE_NAME.test(name)) {
      return { ok: false, error: `--define ${name}: a define's name is capital letters, digits and '_', starting with a letter (SEED, START_CREDITS)` };
    }
    defines[name] = parseDefineValue(spec.slice(at + 1));
    consumed.push(index, index + 1);
  }
  return { ok: true, defines, consumed };
}

/**
 * A program's `define` block, checked: name → a value, or `{ value,
 * description? }`. The value is a whole number (not negative), a boolean, or
 * a string, which is also what `#define` accepts as a default.
 *
 * @param {unknown} block
 * @param {string} at   where the block is, for an error ("…'s programs.slot5x5.define")
 * @returns {{ ok: true, define: Array<{ name: string, value: number|boolean|string, kind: string, description: string|null }> } | { ok: false, error: string }}
 */
export function resolveDefineBlock(block, at) {
  if (block === undefined) return { ok: true, define: [] };
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return { ok: false, error: `${at} must be an object of NAME → value, e.g. { SEED: 10, FORCE_BONUS: true }` };
  }
  const define = [];
  for (const [name, entry] of Object.entries(block)) {
    if (!DEFINE_NAME.test(name)) {
      return { ok: false, error: `${at}.${name}: a define's name is capital letters, digits and '_', starting with a letter (SEED, START_CREDITS)` };
    }
    const detailed = entry && typeof entry === 'object' && !Array.isArray(entry);
    const value = detailed ? entry.value : entry;
    const description = detailed ? entry.description : undefined;
    const fine = (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || typeof value === 'boolean' || typeof value === 'string';
    if (!fine) {
      return { ok: false, error: `${at}.${name} must be a whole number, true or false, or a string (or { value, description }), got ${JSON.stringify(value)}` };
    }
    if (description !== undefined && typeof description !== 'string') {
      return { ok: false, error: `${at}.${name}.description must be a string` };
    }
    define.push({ name, value, kind: defineKind(value), description: description ?? null });
  }
  return { ok: true, define };
}

/** The Levenshtein distance between two short names. */
function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/**
 * The name in `candidates` nearest to `name`, when one is near enough to be
 * a typo of it (within a third of the length, at least one edit), or null.
 *
 * @param {string} name
 * @param {string[]} candidates
 * @returns {string|null}
 */
export function nearestName(name, candidates) {
  let best = null;
  let bestDistance = Math.max(1, Math.floor(name.length / 3)) + 1;
  for (const candidate of candidates) {
    const d = distance(name, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * The values a build is handed: the program's own `define` block, over
 * which the command line's `--define`s win.
 *
 * @param {{ define?: Array<{ name: string, value: number|boolean|string }> }} program
 * @param {Record<string, number|boolean|string>} [handed]
 * @returns {Record<string, number|boolean|string>}
 */
export function effectiveDefines(program, handed = {}) {
  const configured = Object.fromEntries((program.define ?? []).map(({ name, value }) => [name, value]));
  return { ...configured, ...handed };
}

/**
 * Check what was handed against what the program reads. A name on the
 * command line that no `#define` reads is an error (the typo guard); a name
 * only the config declares is a warning, because the config may be shared
 * across targets whose code does not all read it.
 *
 * @param {{ name: string, define?: Array<{ name: string }> }} program
 * @param {Array<{ name: string }>} sites   the `#define` calls the program reads (link()'s defineSites)
 * @param {Record<string, number|boolean|string>} handed   `--define`
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkDefines(program, sites, handed = {}) {
  const read = sites.map((site) => site.name);
  const errors = [];
  const warnings = [];
  const describeRead = read.length > 0 ? `it reads ${read.join(', ')}` : "it reads no #define at all";
  for (const name of Object.keys(handed)) {
    if (read.includes(name)) continue;
    const near = nearestName(name, read);
    errors.push(`--define ${name}: program '${program.name}' has no #define("${name}", …) — ${describeRead}${near ? `; did you mean ${near}?` : ''}`);
  }
  for (const { name } of program.define ?? []) {
    if (read.includes(name) || Object.hasOwn(handed, name)) continue;
    const near = nearestName(name, read);
    warnings.push(`programs.${program.name}.define names ${name}, which no #define in the program reads — ${describeRead}${near ? `; did you mean ${near}?` : ''}`);
  }
  return { errors, warnings };
}
