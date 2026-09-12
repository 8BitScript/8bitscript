// Project discovery for the side bar.
//
// An 8BitScript project is a directory with an `8bitscript.config.ts` (or
// the older `8bs.config.ts`) in it. That file is the manifest: the CLI
// already reads it for the entry file and the list of systems the program
// builds for, so the editor uses the same marker rather than a second list
// that would have to be kept in step with it. A package.json alone is not
// enough — every package in packages/ and this extension itself have one,
// and none of them is a program to run.
//
// A project is one of three kinds, and the launcher keeps them apart in
// its dropdown: the workspace's own programs; the examples that ship with
// the toolchain — the projects `@8bitscript/examples` names in its
// package.json's `8bitscript.examples` field; and the apps that ship with
// it — packages whose package.json carries an `8bitscript.app` field,
// Studio being the first. Both shipped kinds are found beside the CLI
// package the toolchain came from, so a project that has installed
// `@8bitscript/cli` has them whether or not it is a checkout of the
// repository.
//
// This module is deliberately free of the `vscode` API so it can be tested
// with plain `node --test`. runner.cjs does the file search with the
// editor's own glob and hands the results here.
const fs = require('fs');
const path = require('path');

// 8bitscript.config.ts is the current name; 8bs.config.ts (every project
// through 0.3.0) still marks a project so existing ones keep working.
// Checked in this order — the same order as the CLI's own loader
// (packages/cli/src/config.mjs), so a directory with both is one project
// under the new name, never two.
const CONFIG_FILENAMES = ['8bitscript.config.ts', '8bs.config.ts'];

// The canonical name, for messages that talk about the file in the abstract.
const CONFIG_FILE = CONFIG_FILENAMES[0];

/**
 * The config file that marks `dir` as a project, in CONFIG_FILENAMES
 * order, or null when neither name is there.
 *
 * @param {string} dir
 * @returns {string | null}
 */
function findConfig(dir) {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every target the launcher offers. RELEASE_MACHINES in the compiler's
 * resolver is the toolchain's own version of this same list, and this is
 * narrowed to match rather than showing machines nothing can be built for
 * yet. The parked ones (atari8, nes, cx16, mega65) come back here machine
 * by machine as their native backends land (atari8, nes, mega65).
 *
 * What each machine OFFERS is never listed here: every option, value and
 * preset comes from `8bs targets --json` (see hardwareCatalog.cjs), so a
 * C64's REU sizes and a VIC-20's RAM expansions arrive on their own the
 * moment the machine is on this list.
 */
const ALL_TARGETS = ['pet', 'c64', 'vic20', 'c128', 'cx16', 'web'];

/**
 * Targets that are a machine model with an NTSC/PAL choice. The PET is a
 * machine model but has no region: its refresh is the model's, chosen by
 * `--profile` (3032 ~60Hz, 4032/8032 50Hz), so `--pal` is never passed for
 * it — `8bs run pet --pal` would only print a note saying as much. The web
 * has no region either. The C64, VIC-20 and C128 do, and one `.prg` runs
 * on both regions, so the Region control is theirs.
 */
const MACHINE_TARGETS = new Set(['vic20', 'c64', 'c128', 'atari8', 'nes', 'mega65']);

/**
 * Targets with no bare emulator to boot without a program — today just
 * `web`, a WASM worker with nothing to run until a program is compiled
 * into it (see `8bs boot`'s own refusal in packages/cli/src/run.mjs).
 * Every other target, PET included, opens its real emulator with nothing
 * loaded — this is deliberately not MACHINE_TARGETS, which answers a
 * different question (does this target take --pal/--ntsc) and excludes
 * the PET on purpose.
 */
const NO_BARE_EMULATOR = new Set(['web']);

const DEFAULT_ENTRY = 'src/main.8bs';

/** The three kinds of project, in the order the launcher groups them. */
const KINDS = [
  { id: 'project', label: 'Projects' },
  { id: 'example', label: 'Examples' },
  { id: 'app', label: 'Apps' },
];

const BINARY = process.platform === 'win32' ? '8bs.cmd' : '8bs';

const { hardwareArgs } = require('./hardwareCatalog.cjs');

// Drop line and block comments so a commented-out key is not read as live.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function quotedStrings(text) {
  const values = [];
  for (const match of text.matchAll(/(['"`])([^'"`]*)\1/g)) values.push(match[2]);
  return values;
}

/**
 * Read `entry` and `targets` out of an 8bitscript.config.ts.
 *
 * The config is a TypeScript module, which the editor host cannot import; but
 * its documented shape is two literal keys, so a textual read is enough and
 * costs no process spawn per project. Anything the read cannot make sense of
 * falls back to the CLI's own defaults — every target, `src/main.8bs` — which
 * is exactly what the CLI does when the key is absent. An unlisted target then
 * fails at `8bs build` with the CLI's message rather than silently here.
 *
 * `targets` is either the array (`['vic20', 'c64']`) or the object form
 * that composes hardware profiles per machine (`{ c64: { profiles: {...} }
 * }`); either way the machines named are the project's targets, in the
 * toolchain's order.
 *
 * @param {string} text
 * @returns {{ entry: string, targets: string[] }}
 */
function parseConfig(text) {
  const source = stripComments(text);

  let entry = DEFAULT_ENTRY;
  const entryMatch = /\bentry\s*:\s*(['"`])([^'"`]+)\1/.exec(source);
  if (entryMatch) entry = entryMatch[2];

  let targets = ALL_TARGETS;
  const targetsMatch = /\btargets\s*:\s*\[([^\]]*)\]/.exec(source);
  const objectMatch = /\btargets\s*:\s*\{/.exec(source);
  if (targetsMatch) {
    const listed = quotedStrings(targetsMatch[1]).filter((t) => ALL_TARGETS.includes(t));
    if (listed.length > 0) targets = ALL_TARGETS.filter((t) => listed.includes(t));
  } else if (objectMatch) {
    const listed = topLevelKeys(source, objectMatch.index + objectMatch[0].length).filter((t) => ALL_TARGETS.includes(t));
    if (listed.length > 0) targets = ALL_TARGETS.filter((t) => listed.includes(t));
  }

  return { entry, targets };
}

/**
 * The keys of an object literal whose body starts at `from` (just after its
 * `{`), at depth one only — `c64` and `web` in `{ c64: { profiles: { loaded:
 * {} } }, web: {} }`, not `profiles` or `loaded`.
 */
function topLevelKeys(source, from) {
  const keys = [];
  let depth = 1;
  let i = from;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') depth -= 1;
    else if (depth === 1) {
      const m = /^\s*(?:(['"`])([^'"`]+)\1|([A-Za-z_$][\w$]*))\s*:/.exec(source.slice(i));
      if (m) {
        keys.push(m[2] ?? m[3]);
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return keys;
}

/**
 * Find the `8bs` binary that applies to a directory, walking upward.
 *
 * In a monorepo the toolchain belongs to the project, not to the folder the
 * editor has open: examples/borders/node_modules/.bin/8bs is the one that
 * runs examples/borders, even when the repository root is the workspace.
 *
 * @param {string} startDir
 * @returns {string | null}
 */
function findToolchain(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', BINARY);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** The `8bitscript.app` manifest of a package, or null when it is not an app. */
function appManifest(pkg) {
  const field = pkg && pkg['8bitscript'];
  const app = field && typeof field === 'object' ? field.app : undefined;
  return app && typeof app === 'object' ? app : null;
}

/**
 * The `8bitscript.examples` manifest of a package — `{ [name]: { title,
 * dir, description } }` — or null when the package ships no examples.
 */
function examplesManifest(pkg) {
  const field = pkg && pkg['8bitscript'];
  const examples = field && typeof field === 'object' ? field.examples : undefined;
  return examples && typeof examples === 'object' && !Array.isArray(examples) ? examples : null;
}

/**
 * Which kind of project a directory holds on its own: an app declares
 * itself in its package.json; everything else is a project. An example is
 * not decided here — it is whatever the examples package's manifest names,
 * and loadExamples() marks it.
 *
 * @param {string} dir
 * @param {object | null} pkg
 * @returns {'project' | 'app'}
 */
function kindOf(dir, pkg) {
  return appManifest(pkg) ? 'app' : 'project';
}

/**
 * Whether a project's dependencies are installed: it declares some, and has
 * a node_modules of its own to hold them. A project with no dependencies is
 * always "installed". Walking up is deliberately not done here — the
 * toolchain may legitimately come from a parent, but a dependency the entry
 * file imports resolves from the project's own node_modules, and a missing
 * one fails inside the compiler with a message about the package, not about
 * the install.
 */
function isInstalled(dir, pkg) {
  const declared = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
  if (declared.length === 0) return true;
  return fs.existsSync(path.join(dir, 'node_modules'));
}

/** Each package manager's lockfile, in the order a directory is checked for them. */
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

/**
 * The package manager that owns a project: the nearest lockfile going
 * upward decides, since in a workspace the lockfile lives at the root.
 * pnpm is the default because it is what this toolchain is built with;
 * npm, yarn and bun are honored when their lockfile is what is there.
 *
 * @param {string} startDir
 * @returns {'pnpm' | 'npm' | 'yarn' | 'bun'}
 */
function packageManagerFor(startDir) {
  let dir = startDir;
  for (;;) {
    for (const [lockfile, manager] of LOCKFILES) {
      if (fs.existsSync(path.join(dir, lockfile))) return manager;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return 'pnpm';
    dir = parent;
  }
}

/**
 * @typedef {object} Project
 * @property {string} name        package.json name, or the directory name
 * @property {string} title       an app's display name from its manifest, else the name
 * @property {'project' | 'example' | 'app'} kind what the project is to the view
 * @property {string} description package.json description, or ''
 * @property {string} dir         absolute project directory
 * @property {string} configPath  absolute path of its config file (either name)
 * @property {string} entry       absolute path of the entry .8bs file
 * @property {string[]} targets   systems it builds for, in ALL_TARGETS order
 * @property {string | null} toolchain absolute path of its `8bs`, if installed
 * @property {boolean} installed  its declared dependencies have a node_modules
 * @property {'pnpm' | 'npm' | 'yarn' | 'bun'} packageManager what `install` should run
 * @property {boolean} [shipped]  found beside the toolchain rather than in the workspace
 */

/**
 * Build a Project from the path of its config file.
 *
 * @param {string} configPath
 * @param {Partial<Project>} [overrides] what a shipping manifest says about
 *   the project — its kind, title and description — when the directory's
 *   own package.json (if any) is not the word on it
 * @returns {Project}
 */
function loadProject(configPath, overrides = {}) {
  const dir = path.dirname(configPath);
  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    // An unreadable config still marks a project; it just gets the defaults.
  }
  const { entry, targets } = parseConfig(text);
  const pkg = readPackage(dir);
  const name = (pkg && typeof pkg.name === 'string' && pkg.name) || path.basename(dir);
  const app = appManifest(pkg);
  return {
    name,
    title: (app && typeof app.title === 'string' && app.title) || name,
    kind: kindOf(dir, pkg),
    description: (pkg && typeof pkg.description === 'string' && pkg.description) || '',
    dir,
    configPath,
    entry: path.resolve(dir, entry),
    targets,
    toolchain: findToolchain(dir),
    installed: isInstalled(dir, pkg),
    packageManager: packageManagerFor(dir),
    ...overrides,
  };
}

/**
 * Load every project from a list of config paths, sorted by directory so the
 * order is stable between refreshes regardless of what the search returned.
 * A directory that came back under both names is one project, under the
 * name earliest in CONFIG_FILENAMES.
 *
 * @param {string[]} configPaths
 * @returns {Project[]}
 */
function loadProjects(configPaths) {
  const byDir = new Map();
  for (const p of configPaths.map((p) => path.resolve(p))) {
    const dir = path.dirname(p);
    const existing = byDir.get(dir);
    if (existing === undefined
      || CONFIG_FILENAMES.indexOf(path.basename(p)) < CONFIG_FILENAMES.indexOf(path.basename(existing))) {
      byDir.set(dir, p);
    }
  }
  return [...byDir.values()].sort((a, b) => a.localeCompare(b)).map((p) => loadProject(p));
}

/**
 * The directory of the `@8bitscript/cli` package a toolchain belongs to,
 * resolved through the link, or null.
 *
 * A project that depends on the repository — as a workspace link, a `file:`
 * dependency, or a submodule — has node_modules/@8bitscript/cli linked to
 * <repo>/packages/cli. The package link is followed rather than the bin,
 * because pnpm writes .bin/8bs as a shell shim rather than a symlink, so the
 * bin's real path says nothing about where the package lives; a real symlink
 * (npm, or a hand-made link) is honored as a second route.
 *
 * @param {string | null} toolchain absolute path of a project's `8bs`
 * @returns {string | null}
 */
function cliPackageDir(toolchain) {
  if (!toolchain) return null;
  const nodeModules = path.dirname(path.dirname(toolchain));
  const candidates = [
    path.join(nodeModules, '@8bitscript', 'cli'),
    (() => {
      try {
        return path.dirname(path.dirname(fs.realpathSync(toolchain)));
      } catch {
        return null;
      }
    })(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const dir = fs.realpathSync(candidate);
      if (readPackage(dir)?.name === '@8bitscript/cli') return dir;
    } catch {
      // not there — try the next route
    }
  }
  return null;
}

/** Config paths of the projects directly under a directory. */
function listProjectConfigs(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .sort()
    .map((name) => findConfig(path.join(dir, name)))
    .filter((config) => config !== null);
}

/**
 * The packages that ship with a toolchain, as real directories: everything
 * in the two places the CLI's dependencies live — its own
 * node_modules/@8bitscript when it was installed, and its sibling
 * packages/ in a checkout. Both are searched and the results de-duplicated
 * through their real paths, since in a checkout the first is a link to the
 * second.
 *
 * @param {string | null} toolchain absolute path of a project's `8bs`
 * @returns {{ dir: string, pkg: object }[]} sorted by directory
 */
function shippedPackages(toolchain) {
  const cliDir = cliPackageDir(toolchain);
  if (!cliDir) return [];
  const found = new Map();
  for (const parent of [path.join(cliDir, 'node_modules', '@8bitscript'), path.dirname(cliDir)]) {
    let names;
    try {
      names = fs.readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      let dir;
      try {
        dir = fs.realpathSync(path.join(parent, name));
      } catch {
        continue;
      }
      const pkg = readPackage(dir);
      if (pkg && !found.has(dir)) found.set(dir, { dir, pkg });
    }
  }
  return [...found.keys()].sort((a, b) => a.localeCompare(b)).map((dir) => found.get(dir));
}

/**
 * The example programs that ship with the toolchain: every project an
 * `8bitscript.examples` manifest names, in the package that carries it
 * (`@8bitscript/examples`, which `@8bitscript/cli` depends on), found the
 * same way the apps are. An example has no package.json of its own — it is
 * a directory inside the examples package — so its name, title and
 * description are the manifest's, and it runs with the toolchain that
 * found it.
 *
 * @param {string | null} toolchain absolute path of a project's `8bs`
 * @returns {Project[]}
 */
function loadExamples(toolchain) {
  const examples = [];
  for (const { dir: packageDir, pkg } of shippedPackages(toolchain)) {
    const manifest = examplesManifest(pkg);
    if (!manifest) continue;
    for (const [name, entry] of Object.entries(manifest)) {
      if (!entry || typeof entry !== 'object' || typeof entry.dir !== 'string') continue;
      const dir = path.resolve(packageDir, entry.dir);
      const configPath = findConfig(dir);
      if (!configPath) continue;
      const project = loadProject(configPath, {
        name,
        title: typeof entry.title === 'string' && entry.title ? entry.title : name,
        kind: 'example',
        description: typeof entry.description === 'string' ? entry.description : '',
        shipped: true,
      });
      examples.push({
        ...project,
        toolchain: project.toolchain ?? toolchain,
        // The examples package's dependencies are the example's; it has
        // none of its own to be missing.
        installed: true,
      });
    }
  }
  return examples;
}

/**
 * The examples under one directory — the `8bitscript.examplesPath` setting,
 * for someone keeping their own set: each subdirectory with an
 * 8bitscript.config.ts (or 8bs.config.ts) is one, marked as shipped so the
 * launcher groups it with the rest.
 *
 * @param {string} dir
 * @returns {Project[]}
 */
function loadExamplesFrom(dir) {
  return listProjectConfigs(dir).map((configPath) => loadProject(configPath, { kind: 'example', shipped: true }));
}

/**
 * The apps that ship with the toolchain: every package with an
 * `8bitscript.app` field and a config file, found beside the CLI.
 *
 * An app is launched with the toolchain that found it: an installed app
 * sits inside pnpm's store, where walking upward for a `.bin/8bs` finds
 * nothing.
 *
 * @param {string | null} toolchain absolute path of a project's `8bs`
 * @returns {Project[]}
 */
function loadApps(toolchain) {
  return shippedPackages(toolchain)
    .filter(({ dir, pkg }) => appManifest(pkg) && findConfig(dir))
    .map(({ dir }) => {
      const project = loadProject(findConfig(dir));
      return { ...project, shipped: true, toolchain: project.toolchain ?? toolchain };
    });
}

/**
 * Add shipped projects to a list without repeating one the workspace already
 * has — the repository itself lists its examples and apps as
 * ordinary projects.
 *
 * @param {Project[]} projects
 * @param {Project[]} shipped
 * @returns {Project[]}
 */
function withShipped(projects, shipped) {
  const seen = new Set(projects.map((p) => p.dir));
  return [...projects, ...shipped.filter((e) => !seen.has(e.dir))];
}

/** Projects of one kind. */
function ofKind(projects, kind) {
  return projects.filter((project) => project.kind === kind);
}

/**
 * Split a list into its kinds, in KINDS order, for the dropdown's groups.
 * Returns null when every project is the same kind — a workspace of plain
 * projects should not grow a group level it has no use for.
 *
 * @param {Project[]} projects
 * @returns {{ kind: string, label: string, projects: Project[] }[] | null}
 */
function byKind(projects) {
  const groups = KINDS
    .map(({ id, label }) => ({ kind: id, label, projects: ofKind(projects, id) }))
    .filter((group) => group.projects.length > 0);
  return groups.length > 1 ? groups : null;
}

/** `text`, trailing whitespace and one trailing comma (if either is there) trimmed, then a single comma and newline put back — plain string methods rather than a trailing `,?\s*$` regex, which SonarQube flags for its own quadratic worst case on a long run of trailing whitespace. */
function withTrailingComma(text) {
  const trimmed = text.trimEnd();
  const bare = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
  return `${bare},\n`;
}

/**
 * Write one system into a config file's `systems` block, and give back
 * the whole file.
 *
 * The config is a TypeScript module, so this is a text edit rather than a
 * serialisation: the file is someone's, comments and all, and the only
 * part of it this touches is the one object it is adding to. It handles
 * the shape every config in this repository has — a `export default { ...
 * }` literal — and returns null for anything else rather than guessing,
 * so a config that computes its targets is opened for the person to paste
 * into instead of being rewritten wrongly.
 *
 * A name already in the block is replaced, so saving twice under one name
 * updates it rather than writing a duplicate key.
 *
 * @param {string} text the current config file
 * @param {string} name what to call the system
 * @param {{ target: string, profile?: string|null, hardware?: object, region?: string|null }} entry
 * @returns {string|null} the new file, or null when the shape is not one to edit
 */
function insertSystem(text, name, entry) {
  const body = entryText(entry);
  // `[ \t]*` rather than `\s*`: a `systems:` that a `//` on the same line
  // has commented out is not a block to add to.
  const block = objectBody(text, /\n[ \t]*systems\s*:\s*\{/);
  if (block) {
    const indent = `${block.indent}  `;
    const without = removeKey(text.slice(block.start, block.end), name);
    const existing = without.trim() === '' ? '' : withTrailingComma(without.replace(/^\n*/, ''));
    return text.slice(0, block.start)
      + `\n${existing}${indent}${quoteKey(name)}: ${body},\n${block.indent}`
      + text.slice(block.end);
  }
  // No block yet: open one at the end of the default export's own object.
  const root = objectBody(text, /export\s+default\s*\{/);
  if (!root) return null;
  const indent = `${root.indent}  `;
  const before = text.slice(root.start, root.end).trimEnd();
  return text.slice(0, root.start)
    + `${before.endsWith(',') || before === '' ? before : `${before},`}\n`
    + `${indent}systems: {\n${indent}  ${quoteKey(name)}: ${body},\n${indent}},\n${root.indent}`
    + text.slice(root.end);
}

/**
 * One named system as it is written in a config — the line insertSystem
 * splices in, and the same line to hand someone when it cannot.
 *
 * @param {string} name
 * @param {{ target: string, profile?: string|null, hardware?: object, region?: string|null }} entry
 */
function systemLine(name, entry) {
  return `${quoteKey(name)}: ${entryText(entry)},`;
}

/** One system as it is written in a config. */
function entryText({ target, profile = null, hardware = {}, region = null }) {
  const parts = [`target: ${quote(target)}`];
  if (profile) parts.push(`profile: ${quote(profile)}`);
  const options = Object.entries(hardware ?? {});
  if (options.length > 0) {
    parts.push(`hardware: { ${options.map(([k, v]) => `${quoteKey(k)}: ${quote(String(v))}`).join(', ')} }`);
  }
  if (region) parts.push(`region: ${quote(region)}`);
  return `{ ${parts.join(', ')} }`;
}

const quote = (value) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
/** A bare identifier stays bare; anything else is quoted, as a person would write it. */
const quoteKey = (key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key));

/**
 * The inside of the object literal a pattern's `{` opens: where its body
 * starts and ends, and the indent of the line the pattern began on.
 * Comments and strings are skipped so a `}` inside either does not close
 * it. Null when the pattern does not match or the braces do not balance.
 */
function objectBody(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const line = text.lastIndexOf('\n', match.index + 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(line))[0];
  let depth = 1;
  // A while loop, not a for: skipping past a comment or a string literal
  // means jumping the cursor ahead by more than one character, which a
  // for loop's own control variable being reassigned in its body is a
  // SonarQube smell (S2310) even though it is exactly the right tool for
  // a hand-rolled scanner — a while loop's own cursor is expected to move
  // however the body needs it to.
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const next = text.indexOf('\n', i);
      if (next < 0) return null;
      i = next + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') {
      depth -= 1;
      if (depth === 0) return { start, end: i, indent };
    }
    i += 1;
  }
  return null;
}

/**
 * A `systems` body with one name's entry taken out, so saving over a name
 * replaces it rather than writing the key twice.
 *
 * The entry's value is scanned for its matching brace rather than matched
 * with a pattern: a system with `hardware: { sid: '8580' }` in it has a
 * nested object, and a regexp that stops at the first `}` would leave half
 * of it behind.
 */
function removeKey(body, name) {
  const key = `(?:${escapeRegExp(quoteKey(name))}|${escapeRegExp(quote(name))}|${escapeRegExp(`"${name}"`)})`;
  const match = new RegExp(`\\n[ \\t]*${key}\\s*:\\s*(?=\\{)`).exec(body);
  if (!match) return body;
  const value = objectBody(body, new RegExp(`\\n[ \\t]*${key}\\s*:\\s*\\{`));
  if (!value) return body;
  let end = value.end + 1;
  if (body[end] === ',') end += 1;
  return body.slice(0, match.index) + body.slice(end);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Projects that can run on one system. */
function runnableOn(projects, system) {
  return projects.filter((project) => project.targets.includes(system));
}

/**
 * The `8bs` arguments for one action, on one target where the action takes one.
 *
 * @param {'run' | 'build' | 'boot' | 'doctor'} action
 * @param {string} [target]        required for run, build and boot
 * @param {'ntsc' | 'pal'} [region] ignored for targets without a machine model
 * @param {{ profile?: string|null, options?: object }} [hardware] the
 *   hardware fitted (the side bar's selection for that system): `--profile`
 *   and `--hardware option=value,...`, as a person would type them
 * @returns {string[]}
 */
function commandArgs(action, target, region = 'ntsc', hardware = undefined) {
  if (action !== 'run' && action !== 'build' && action !== 'boot') return [action];
  // boot takes no entry file at all — nothing is loaded into the machine —
  // so it shares run's own `[action, target]` shape rather than needing one
  // of its own.
  const args = action === 'build' ? ['build', '--target', target] : [action, target];
  if (region === 'pal' && MACHINE_TARGETS.has(target)) args.push('--pal');
  if (hardware) args.push(...hardwareArgs(hardware));
  // Run and build print the size breakdown before the emulator starts (run)
  // or instead of launching one (build). The launcher's Running machines
  // tree reads the same numbers from dist/.8bs-last-<target>.json.
  if (action === 'run' || action === 'build') args.push('--size');
  return args;
}

module.exports = {
  ALL_TARGETS,
  BINARY,
  CONFIG_FILE,
  CONFIG_FILENAMES,
  DEFAULT_ENTRY,
  findConfig,
  MACHINE_TARGETS,
  NO_BARE_EMULATOR,
  KINDS,
  byKind,
  cliPackageDir,
  commandArgs,
  examplesManifest,
  findToolchain,
  isInstalled,
  kindOf,
  loadApps,
  loadExamples,
  loadExamplesFrom,
  insertSystem,
  ofKind,
  systemLine,
  packageManagerFor,
  loadProject,
  loadProjects,
  parseConfig,
  runnableOn,
  withShipped,
};
