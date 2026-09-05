// Project discovery for the sidebar view.
//
// An 8BitScript project is a directory with an `8bs.config.ts` in it. That
// file is the manifest: the CLI already reads it for the entry file and the
// list of systems the program builds for, so the editor uses the same marker
// rather than a second list that would have to be kept in step with it. A
// package.json alone is not enough — every package in packages/ and this
// extension itself have one, and none of them is a program to run.
//
// A project is one of three kinds, and the view keeps them apart: the
// workspace's own programs; the proofs of concept under
// examples/proof-of-concept/ in the 8bitscript repository, which exist to
// exercise the toolchain; and the apps that ship with the toolchain —
// packages whose package.json carries an `8bitscript.app` field, Studio
// being the first — found beside the CLI package the toolchain came from.
//
// This module is deliberately free of the `vscode` API so it can be tested
// with plain `node --test`. The view (projectsView.cjs) does the file search
// with the editor's own glob and hands the results here.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = '8bs.config.ts';

/** Every target the toolchain knows, in the order the view lists them. */
const ALL_TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

/**
 * Targets that are a machine model with an NTSC/PAL choice. The PET is a
 * machine model but has no region: its refresh is the model's, chosen by
 * `--profile` (3032 ~60Hz, 4032/8032 50Hz), so `--pal` is never passed
 * for it — `8bs run pet --pal` would only print a note saying as much.
 */
const MACHINE_TARGETS = new Set(['vic20', 'c64', 'c128', 'atari8', 'nes', 'mega65']);

const DEFAULT_ENTRY = 'src/main.8bs';

/** The directory under examples/ that holds the proofs of concept. */
const PROOFS_DIR = 'proof-of-concept';

/** The three kinds of project, in the order the view lists their sections. */
const KINDS = [
  { id: 'project', label: 'Projects' },
  { id: 'proof', label: 'Proofs of concept' },
  { id: 'app', label: 'Apps' },
];

const BINARY = process.platform === 'win32' ? '8bs.cmd' : '8bs';

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
 * Read `entry` and `targets` out of an 8bs.config.ts.
 *
 * The config is a TypeScript module, which the editor host cannot import; but
 * its documented shape is two literal keys, so a textual read is enough and
 * costs no process spawn per project. Anything the read cannot make sense of
 * falls back to the CLI's own defaults — every target, `src/main.8bs` — which
 * is exactly what the CLI does when the key is absent. An unlisted target then
 * fails at `8bs build` with the CLI's message rather than silently here.
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
  if (targetsMatch) {
    const listed = quotedStrings(targetsMatch[1]).filter((t) => ALL_TARGETS.includes(t));
    if (listed.length > 0) targets = ALL_TARGETS.filter((t) => listed.includes(t));
  }

  return { entry, targets };
}

/**
 * Find the `8bs` binary that applies to a directory, walking upward.
 *
 * In a monorepo the toolchain belongs to the project, not to the folder the
 * editor has open: examples/proof-of-concept/borders/node_modules/.bin/8bs is the one that
 * runs examples/proof-of-concept/borders, even when the repository root is the workspace.
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
 * Which kind of project a directory holds. An app declares itself in its
 * package.json; a proof of concept is placed — `examples/proof-of-concept/
 * <name>` — so the repository's own checkout and a consumer that found the
 * same directory through its toolchain agree on what it is.
 *
 * @param {string} dir
 * @param {object | null} pkg
 * @returns {'project' | 'proof' | 'app'}
 */
function kindOf(dir, pkg) {
  if (appManifest(pkg)) return 'app';
  const parent = path.dirname(dir);
  if (path.basename(parent) === PROOFS_DIR && path.basename(path.dirname(parent)) === 'examples') return 'proof';
  return 'project';
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

/**
 * The package manager that owns a project: the nearest lockfile going
 * upward decides, since in a workspace the lockfile lives at the root.
 * pnpm is the default because it is what this toolchain is built with.
 *
 * @param {string} startDir
 * @returns {'pnpm' | 'npm' | 'yarn'}
 */
function packageManagerFor(startDir) {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
    const parent = path.dirname(dir);
    if (parent === dir) return 'pnpm';
    dir = parent;
  }
}

/**
 * @typedef {object} Project
 * @property {string} name        package.json name, or the directory name
 * @property {string} title       an app's display name from its manifest, else the name
 * @property {'project' | 'proof' | 'app'} kind what the project is to the view
 * @property {string} description package.json description, or ''
 * @property {string} dir         absolute project directory
 * @property {string} configPath  absolute path of its 8bs.config.ts
 * @property {string} entry       absolute path of the entry .8bs file
 * @property {string[]} targets   systems it builds for, in ALL_TARGETS order
 * @property {string | null} toolchain absolute path of its `8bs`, if installed
 * @property {boolean} installed  its declared dependencies have a node_modules
 * @property {'pnpm' | 'npm' | 'yarn'} packageManager what `install` should run
 * @property {boolean} [shipped]  found beside the toolchain rather than in the workspace
 */

/**
 * Build a Project from the path of its config file.
 *
 * @param {string} configPath
 * @returns {Project}
 */
function loadProject(configPath) {
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
  };
}

/**
 * Load every project from a list of config paths, sorted by directory so the
 * order is stable between refreshes regardless of what the search returned.
 *
 * @param {string[]} configPaths
 * @returns {Project[]}
 */
function loadProjects(configPaths) {
  const unique = [...new Set(configPaths.map((p) => path.resolve(p)))];
  return unique.sort().map(loadProject);
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
 * (npm, or a hand-made link) is honoured as a second route.
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

/**
 * The proofs of concept that ship with the toolchain, if it came from a
 * checkout of the 8bitscript repository: the repo keeps them at
 * examples/proof-of-concept, two directories up from packages/cli. A
 * published package would not carry them; the `<cli>/examples` candidate is
 * where they would go if one ever did.
 *
 * @param {string | null} toolchain absolute path of a project's `8bs`
 * @returns {string | null} the proofs directory, or null when there is none
 */
function findProofsDir(toolchain) {
  const cliDir = cliPackageDir(toolchain);
  if (!cliDir) return null;
  for (const candidate of [
    path.join(cliDir, 'examples', PROOFS_DIR),
    path.resolve(cliDir, '..', '..', 'examples', PROOFS_DIR),
  ]) {
    if (listProjectConfigs(candidate).length > 0) return candidate;
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
    .map((name) => path.join(dir, name, CONFIG_FILE))
    .filter((config) => fs.existsSync(config));
}

/**
 * Load the proofs of concept under a directory, marked as shipped so the
 * view can tell them apart from the workspace's own projects.
 *
 * @param {string} dir
 * @returns {Project[]}
 */
function loadProofs(dir) {
  return loadProjects(listProjectConfigs(dir)).map((project) => ({ ...project, shipped: true }));
}

/**
 * The apps that ship with the toolchain: every package with an
 * `8bitscript.app` field and an 8bs.config.ts, looked for in the two places
 * the CLI's dependencies live — its own node_modules/@8bitscript when it
 * was installed, and its sibling packages/ in a checkout. Both are searched
 * and the results de-duplicated through their real paths, since in a
 * checkout the first is a link to the second.
 *
 * An app is launched with the toolchain that found it: an installed app
 * sits inside pnpm's store, where walking upward for a `.bin/8bs` finds
 * nothing.
 *
 * @param {string | null} toolchain absolute path of a project's `8bs`
 * @returns {Project[]}
 */
function loadApps(toolchain) {
  const cliDir = cliPackageDir(toolchain);
  if (!cliDir) return [];
  const dirs = new Set();
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
      if (appManifest(readPackage(dir)) && fs.existsSync(path.join(dir, CONFIG_FILE))) dirs.add(dir);
    }
  }
  return [...dirs].sort().map((dir) => {
    const project = loadProject(path.join(dir, CONFIG_FILE));
    return { ...project, shipped: true, toolchain: project.toolchain ?? toolchain };
  });
}

/**
 * Add shipped projects to a list without repeating one the workspace already
 * has — the repository itself lists its proofs of concept and apps as
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
 * Split a list into its kinds, in KINDS order, for the view's sections.
 * Returns null when every project is the same kind — a workspace of plain
 * projects should not grow a section level it has no use for.
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

/** Projects that can run on one system. */
function runnableOn(projects, system) {
  return projects.filter((project) => project.targets.includes(system));
}

/** Every system at least one project targets, each with its projects. */
function bySystem(projects) {
  return ALL_TARGETS
    .map((target) => ({ target, projects: runnableOn(projects, target) }))
    .filter((group) => group.projects.length > 0);
}

/** Where docs/setup/llvm-mos.md tells people to unpack the SDK. */
const DEFAULT_LLVM_MOS_HOME = path.join(os.homedir(), '.local', 'opt', 'llvm-mos');

/**
 * The LLVM-MOS SDK directory the Commodore targets need, or null.
 *
 * The CLI reads $LLVM_MOS_HOME and nothing else, which is right for a
 * terminal. An editor task runs the shell non-interactively, so an `export`
 * in ~/.zshrc or ~/.bashrc never reaches it and `8bs doctor` reports the SDK
 * missing from a machine where it works fine at the prompt. The view closes
 * that gap before starting the task: an explicit setting wins, then whatever
 * the editor's own environment carries, then the documented install location
 * if the SDK is actually there. Nothing resolved means the task runs with the
 * environment untouched, so doctor still says what is wrong.
 *
 * @param {{ setting?: string | null, env?: NodeJS.ProcessEnv, defaultHome?: string }} [options]
 * @returns {string | null}
 */
function resolveLlvmMosHome({ setting = null, env = process.env, defaultHome = DEFAULT_LLVM_MOS_HOME } = {}) {
  const hasBin = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, 'bin'));
  const configured = typeof setting === 'string' && setting.trim() !== '' ? setting.trim() : null;
  // An explicit setting is passed on even when it is wrong, so doctor names
  // it instead of silently reporting whatever the fallback found.
  if (configured) return configured;
  if (hasBin(env.LLVM_MOS_HOME)) return env.LLVM_MOS_HOME;
  if (hasBin(defaultHome)) return defaultHome;
  return env.LLVM_MOS_HOME || null;
}

/**
 * The `8bs` arguments for one action, on one target where the action takes one.
 *
 * @param {'run' | 'build' | 'doctor'} action
 * @param {string} [target]        required for run and build
 * @param {'ntsc' | 'pal'} [region] ignored for targets without a machine model
 * @returns {string[]}
 */
function commandArgs(action, target, region = 'ntsc') {
  if (action !== 'run' && action !== 'build') return [action];
  const args = action === 'build' ? ['build', '--target', target] : ['run', target];
  if (region === 'pal' && MACHINE_TARGETS.has(target)) args.push('--pal');
  return args;
}

module.exports = {
  ALL_TARGETS,
  BINARY,
  CONFIG_FILE,
  DEFAULT_ENTRY,
  MACHINE_TARGETS,
  KINDS,
  PROOFS_DIR,
  byKind,
  bySystem,
  cliPackageDir,
  commandArgs,
  findProofsDir,
  findToolchain,
  isInstalled,
  kindOf,
  loadApps,
  loadProofs,
  ofKind,
  packageManagerFor,
  loadProject,
  loadProjects,
  parseConfig,
  resolveLlvmMosHome,
  runnableOn,
  withShipped,
};
