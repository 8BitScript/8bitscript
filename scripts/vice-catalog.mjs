#!/usr/bin/env node
// What VICE itself says it can do, as JSON — the menu a machine package's
// hardware catalog is picked from.
//
// A machine package declares its own hardware by hand (`"8bitscript".hardware`
// in its package.json: the REU, the SID, the control ports — see
// packages/cli/src/hardware.mjs). Those declarations carry emulator flags,
// and a flag copied by hand is a flag that can drift from the VICE that is
// actually installed. This script is the other direction: it asks VICE for
// its whole option surface and writes it down, so a catalog entry can be
// checked against the real thing instead of against memory.
//
// It is a *reference*, not an input. Nothing in the build reads the output.
// The facts, tags and probes that make an option mean something to a program
// are human decisions and stay hand-written; what VICE can tell us is the
// mechanism — the flag's name, whether it takes a value, which values are
// legal, what they are called, and what the default is.
//
//   node scripts/vice-catalog.mjs              # x64sc (the C64)
//   node scripts/vice-catalog.mjs x64sc x128   # several
//   node scripts/vice-catalog.mjs --all        # every VICE binary the
//                                              # machine packages name
//
// Two sources are joined, because neither is enough on its own:
//
//   <binary> -help        every command-line option, its argument shape, and
//                         a line of documentation that — for about a seventh
//                         of them — spells out the legal values and their
//                         human names: `-drive8type` hands over `1541: CBM
//                         1541, 1571: CBM 1571, ...` ready to read.
//   <binary> -dumpconfig  every *resource* with the value it defaults to.
//                         The help text never states a default, and a default
//                         is exactly what a catalog needs to know: VICE ships
//                         `Drive8Type=1542` (a 1541-II), so a catalog that
//                         wants a plain 1541 has to say so out loud.
//
// The two name things differently — `-drive8type` against `Drive8Type` — and
// are joined case- and punctuation-insensitively. Options that are actions
// rather than settings (`-help`, `-autostart`, `-limitcycles`) have no
// resource by design and are marked `action: true` so they do not read as
// failures to match.
//
// Re-runnable and deterministic: same VICE in, same bytes out. Re-run it when
// the installed VICE changes and the diff is what that upgrade did.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'scripts', 'vice');

/**
 * Every VICE binary a machine package names, read from the packages
 * themselves rather than listed here — `packages/cli/test/hardware.test.mjs`
 * holds the CLI to the same rule ("viceEmulators and targetEmulators are the
 * catalogs, not a second table"), and a generator that checks catalogs
 * against VICE has no business keeping a copy of the one thing it could
 * look up. Read straight off disk, so this runs with nothing built.
 *
 * @returns {string[]}
 */
function viceBinaries() {
  const packages = join(ROOT, 'packages');
  const found = new Set();
  for (const name of readdirSync(packages)) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(packages, name, 'package.json'), 'utf8'));
    } catch { continue; }
    const emulator = pkg['8bitscript']?.emulator ?? {};
    if (emulator.family === 'vice' && emulator.binary) found.add(emulator.binary);
  }
  // A plain string comparator, spelled out: these are binary names
  // ('x64sc', 'xpet', 'xvic'), so default's lexicographic sort was already
  // the right order — a linter that cannot see that from a bare .sort()
  // still gets an unambiguous answer this way.
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Options that *do* something instead of setting something: they have no
 * resource behind them, so an unmatched join is the right answer rather than
 * a miss. Kept as a list because VICE gives no other way to tell them apart.
 */
const ACTIONS = new Set([
  'help', '?', 'h', 'version', 'features', 'default', 'config', 'addconfig',
  'dumpconfig', 'chdir', 'limitcycles', 'console', 'seed', 'core', 'autostart',
  'autoload', 'logfile', 'loglimit', 'silent', 'verbose', 'debug', 'keybuf',
  'restore', 'exitscreenshot', 'exitscreenshotvicii',
]);

/** Run a binary and hand back stdout+stderr, without throwing on a non-zero exit. */
function run(binary, args) {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    // VICE exits non-zero after -help on some builds and still prints
    // everything; the output is what matters, not the status.
    if (error.stdout) return error.stdout;
    throw error;
  }
}

/** The name VICE knows a thing by, stripped to letters and digits for joining. */
const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The legal values a help line spells out, or null.
 *
 * Two shapes appear, and only these two:
 *
 *   `(0: no drive, 1541: CBM 1541, ...)`  a value and its human name — the
 *                                         useful one, and what a label in a
 *                                         catalog can be written from.
 *   `(c64/c64c/c64old, ntsc, drean)`      bare names, no labels: the reader
 *                                         is expected to know what a `drean`
 *                                         is. Recorded with a null label so
 *                                         the gap is visible rather than
 *                                         filled in with a guess.
 *
 * @param {string} doc the option's line of documentation
 * @returns {Record<string, string|null>|null}
 */
export function parseValues(doc) {
  // From the first `(` to the *last* `)`, because a label may have brackets
  // of its own: `-controlport1device` lists `3: Mouse (1351), 4: Mouse
  // (NEOS), ...` and a pattern that stopped at the first `)` would read one
  // device where VICE offers forty-two. Whether what comes back is really a
  // list is decided below, by whether it holds `key:` pairs at all.
  // The first `(` to the *last* `)`, found with plain string search rather
  // than a `.+` regex between the two literals: SonarQube (javascript:S8786)
  // flags that shape as super-linear on backtracking, and indexOf/lastIndexOf
  // says exactly the same thing — first open, last close — in one pass each,
  // with no backtracking possible at all.
  const openParen = doc.indexOf('(');
  const closeParen = doc.lastIndexOf(')');
  const labelled = openParen !== -1 && closeParen > openParen ? [null, doc.slice(openParen + 1, closeParen)] : null;
  if (labelled) {
    // Scanned as boundaries rather than split on commas, because VICE's own
    // text cannot be relied on to put one in: `-kernalrev` reads
    // `(0/jap: japanese 1: rev. 1, 2: rev. 2, ...)` — the comma after
    // `japanese` is missing, and a split would hand `1: rev. 1` back as part
    // of the Japanese kernal's label. Finding every `key:` instead and taking
    // the text between them recovers all seven revisions from the same line.
    // Every quantifier here is capped (VICE never prints an option key or
    // the run of whitespace/commas around one anywhere near these lengths)
    // so a worst case is bounded work, not backtracking that grows with the
    // input (javascript:S8786).
    const boundary = /([A-Za-z0-9_/-]{1,64})[ \t]{0,16}[:=][ \t]{0,16}/g;
    const found = [...labelled[1].matchAll(boundary)];
    const values = {};
    for (let i = 0; i < found.length; i += 1) {
      const start = found[i].index + found[i][0].length;
      const end = i + 1 < found.length ? found[i + 1].index : labelled[1].length;
      const label = labelled[1].slice(start, end).replace(/[,\s]{1,32}$/, '').trim();
      // A key may be written as aliases — `39/gs`, `100/4064`, `0/jap`. The
      // first is the one VICE prints back, and the rest are recorded beside
      // it so a catalog can spell it either way and still be checked.
      const [name, ...aliases] = found[i][1].split('/');
      if (!label) continue;
      values[name] = aliases.length > 0 ? `${label} (also ${aliases.join(', ')})` : label;
    }
    // Two alternatives at least. A single labelled pair is an annotation on a
    // number rather than a choice between values — `-autostart-delay
    // (0: use default)`, `-drive8rpm (30000: 300rpm)` — and calling it an
    // enumeration would offer a one-item dropdown in place of a field to type
    // a number into. The note stays readable in `doc`.
    if (Object.keys(values).length > 1) return values;
  }
  // A bare list needs at least one slash to be a list rather than an aside:
  // `(c64/c64c/c64old, ntsc/newntsc, drean, jap)`.
  const bare = doc.match(/\(([A-Za-z0-9_-]+(?:[/,]\s*[A-Za-z0-9_-]+)+)\)/);
  if (bare && bare[1].includes('/')) {
    const values = {};
    for (const name of bare[1].split(/[/,]/).map((part) => part.trim()).filter(Boolean)) {
      values[name] = null;
    }
    if (Object.keys(values).length > 1) return values;
  }
  return null;
}

/**
 * `<binary> -help`, as one entry per option name.
 *
 * A help entry is an option on one line and a tab-indented line of
 * documentation under it. An option appears twice when it is a switch: VICE
 * writes `-foo` to turn a thing on and `+foo` to turn it off, which is one
 * setting with two spellings and is recorded as one entry.
 */
export function parseHelp(text) {
  const lines = text.split('\n');
  const options = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    // VICE is not consistent about its argument hints: most are in angle
    // brackets (`-drive8type <Type>`) but twenty-nine are bare
    // (`-controlport1device Device`, `-monitorfont font-description`).
    // Requiring the brackets drops those lines on the floor, and the control
    // ports are among them — hardware the C64's catalog already fits.
    // Every quantifier capped — an option name, its hint and the whitespace
    // around them are all one short line of VICE's own --help text, nowhere
    // near these lengths — so a worst case is bounded work, not the
    // backtracking `\S+`/`\s+`/lazy-`*` next to each other would otherwise
    // let grow with the input (javascript:S8786).
    const match = lines[i].match(/^([-+])(\S{1,64})(?:[ \t]{1,16}(<[^>]{0,256}>|[^\s<][^\n]{0,256}?))?[ \t]{0,16}$/);
    if (!match) continue;
    const [, sign, name, arg] = match;
    const doc = (lines[i + 1] ?? '').startsWith('\t') ? lines[i + 1].trim() : '';
    const entry = options.get(name) ?? { name, signs: new Set(), arg: null, doc: '' };
    entry.signs.add(sign);
    if (arg) entry.arg = arg;
    // The `-` spelling carries the real description; `+` is usually
    // "Do not ..." and would lose the enumerated values if it won.
    if (doc && (sign === '-' || !entry.doc)) entry.doc = doc;
    options.set(name, entry);
  }
  return options;
}

/** `<binary> -dumpconfig`, as resource → its default, with the quotes off strings. */
export function parseResources(text) {
  const resources = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, name, raw] = match;
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (!resources.has(name)) resources.set(name, value);
  }
  return resources;
}

/** The VICE version from its boot banner, or null if it never said. */
export function parseVersion(text) {
  return text.match(/VICE Version ([0-9][^\s*]*)/)?.[1] ?? null;
}

/** Everything one VICE binary can be told to do. */
function describe(binary) {
  const help = parseHelp(run(binary, ['-help']));

  // -dumpconfig has to actually start the machine, so it is the run that
  // also prints the version banner. One launch, both answers.
  const dump = join(OUT_DIR, `.${binary}.vicerc`);
  mkdirSync(OUT_DIR, { recursive: true });
  const booted = run(binary, ['-default', '-dumpconfig', dump, '-limitcycles', '1']);
  const resources = parseResources(readFileSync(dump, 'utf8'));
  // VICE can only write the resources to a file, so the file is scratch:
  // read once and taken away, leaving the JSON as the only output.
  rmSync(dump, { force: true });

  const byNormalized = new Map([...resources.keys()].map((name) => [normalize(name), name]));

  const options = {};
  const counts = {
    total: 0, toggle: 0, enum: 0, range: 0, value: 0, action: 0, joined: 0, settings: 0,
  };

  for (const name of [...help.keys()].sort((a, b) => a.localeCompare(b))) {
    const entry = help.get(name);
    const action = ACTIONS.has(name.toLowerCase());
    const values = parseValues(entry.doc);
    // `<0-9>` in the argument hint, or `(0..3)` in the documentation —
    // `-sidextra` states its bounds only the second way.
    const range = entry.arg?.match(/^<(-?\d+)\s*-\s*(-?\d+)>$/)
      ?? entry.doc.match(/\((-?\d+)\s*\.\.\s*(-?\d+)\)/);
    const toggle = !entry.arg && entry.signs.has('-') && entry.signs.has('+');

    let kind;
    if (toggle) kind = 'toggle';
    else if (values) kind = 'enum';
    else if (range) kind = 'range';
    else kind = 'value';

    // VICE names a flag and the resource behind it the same way about a
    // third of the time (`-sidmodel` / `SidModel`). The rest are either an
    // action with no resource at all, or the same word with a noun stuck on
    // the end — `-kernal` sets `KernalName`, `-acia1` sets `Acia1Enable`.
    // Those suffixes are tried in order and the rule that matched is
    // recorded, so a join can be audited rather than trusted.
    let resource = byNormalized.get(normalize(name)) ?? null;
    let resourceVia = resource ? 'name' : null;
    if (!resource) {
      for (const suffix of ['name', 'enable', 'filename', 'image', 'file']) {
        const found = byNormalized.get(normalize(name) + suffix);
        if (found) { resource = found; resourceVia = suffix; break; }
      }
    }

    counts.total += 1;
    counts[kind] += 1;
    if (action) counts.action += 1;
    else {
      counts.settings += 1;
      if (resource) counts.joined += 1;
    }

    options[name] = {
      kind,
      doc: entry.doc,
      // How the flag is written on a command line: `-reu`, and `+reu` to
      // turn it back off where VICE offers that.
      flag: `-${name}`,
      off: toggle ? `+${name}` : null,
      // The argument's own hint, as VICE writes it: `<Model>`, `<0-9>`.
      arg: entry.arg,
      values,
      range: range ? { min: Number(range[1]), max: Number(range[2]) } : null,
      // The resource this flag sets, and what it is when nothing sets it.
      // Null for an action, and null where the names are too far apart to
      // join — never guessed.
      resource,
      resourceVia,
      default: resource ? resources.get(resource) : null,
      action,
      // Which part of the machine this belongs to. Left null: grouping the
      // surface is a reading of it, and a wrong grouping checked in is worse
      // than none. Filled in as the catalog grows into it.
      family: null,
    };
  }

  return {
    binary,
    viceVersion: parseVersion(booted),
    options,
    counts,
    resourceCount: resources.size,
  };
}

// Only when run as a command. Imported — by its test, which has no VICE to
// ask — the module is just the four parsers.
const RUN_DIRECTLY = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

const args = RUN_DIRECTLY ? process.argv.slice(2) : [];
const binaries = !RUN_DIRECTLY ? [] : args.includes('--all')
  ? viceBinaries()
  : (args.filter((arg) => !arg.startsWith('--')).length > 0
    ? args.filter((arg) => !arg.startsWith('--'))
    : ['x64sc']);

for (const binary of binaries) {
  let described;
  try {
    described = describe(binary);
  } catch (error) {
    process.stderr.write(`${binary}: not on PATH or would not answer (${error.message})\n`);
    process.exitCode = 1;
    continue;
  }
  const { counts, resourceCount, ...rest } = described;
  const out = join(OUT_DIR, `${binary}.json`);
  // `counts` sits at the top so a reader sees the shape before the surface,
  // and a diff of it is the one-line summary of what a VICE upgrade changed.
  writeFileSync(out, `${JSON.stringify({
    binary: rest.binary,
    viceVersion: rest.viceVersion,
    resources: resourceCount,
    counts,
    options: rest.options,
  }, null, 2)}\n`);
  const joinable = counts.settings;
  process.stdout.write(
    `${binary}: VICE ${rest.viceVersion ?? '?'} — ${counts.total} options `
    + `(${counts.toggle} toggle, ${counts.enum} enum, ${counts.range} range, ${counts.value} value; `
    + `${counts.action} actions), ${counts.joined}/${joinable} settings joined to a resource `
    + `(${Math.round((counts.joined / joinable) * 100)}%) → ${out.slice(ROOT.length + 1)}\n`,
  );
}
