// Project discovery for the sidebar view.
//
// An 8BitScript project is a directory with an `8bs.config.ts` in it. That
// file is the manifest: the CLI already reads it for the entry file and the
// list of systems the program builds for, so the editor uses the same marker
// rather than a second list that would have to be kept in step with it. A
// package.json alone is not enough — every package in packages/ and this
// extension itself have one, and none of them is a program to run.
//
// This module is deliberately free of the `vscode` API so it can be tested
// with plain `node --test`. The view (projectsView.cjs) does the file search
// with the editor's own glob and hands the results here.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = '8bs.config.ts';

/** Every target the toolchain knows, in the order the view lists them. */
const ALL_TARGETS = ['vic20', 'c64', 'web'];

/** Targets that are a machine model, and so have an NTSC/PAL choice. */
const MACHINE_TARGETS = new Set(['vic20', 'c64']);

const DEFAULT_ENTRY = 'src/main.8bs';

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
 * editor has open: examples/hello-vic/node_modules/.bin/8bs is the one that
 * runs examples/hello-vic, even when the repository root is the workspace.
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

/**
 * @typedef {object} Project
 * @property {string} name        package.json name, or the directory name
 * @property {string} description package.json description, or ''
 * @property {string} dir         absolute project directory
 * @property {string} configPath  absolute path of its 8bs.config.ts
 * @property {string} entry       absolute path of the entry .8bs file
 * @property {string[]} targets   systems it builds for, in ALL_TARGETS order
 * @property {string | null} toolchain absolute path of its `8bs`, if installed
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
  return {
    name: (pkg && typeof pkg.name === 'string' && pkg.name) || path.basename(dir),
    description: (pkg && typeof pkg.description === 'string' && pkg.description) || '',
    dir,
    configPath,
    entry: path.resolve(dir, entry),
    targets,
    toolchain: findToolchain(dir),
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
 * The example projects that ship with the toolchain, if it came from a
 * checkout of the 8bitscript repository.
 *
 * A project that depends on the repository — as a workspace link, a `file:`
 * dependency, or a submodule — has node_modules/@8bitscript/cli linked to
 * <repo>/packages/cli, and the repo keeps its examples two directories up
 * from there. The package link is followed rather than the bin, because pnpm
 * writes .bin/8bs as a shell shim rather than a symlink, so the bin's real
 * path says nothing about where the package lives. A published package would
 * not carry the examples; the `<cli>/examples` candidate is where they would
 * go if one ever did.
 *
 * @param {string | null} toolchain absolute path of a project's `8bs`
 * @returns {string | null} the examples directory, or null when there is none
 */
function findExamplesDir(toolchain) {
  if (!toolchain) return null;
  const nodeModules = path.dirname(path.dirname(toolchain));
  const packageDirs = [
    path.join(nodeModules, '@8bitscript', 'cli'),
    // .../packages/cli/bin/8bs.mjs -> .../packages/cli, when the bin is a
    // real symlink (npm, or a hand-made link) rather than a shim.
    (() => {
      try {
        return path.dirname(path.dirname(fs.realpathSync(toolchain)));
      } catch {
        return null;
      }
    })(),
  ];
  for (const packageDir of packageDirs) {
    if (!packageDir) continue;
    let cliDir;
    try {
      cliDir = fs.realpathSync(packageDir);
    } catch {
      continue;
    }
    for (const candidate of [path.join(cliDir, 'examples'), path.resolve(cliDir, '..', '..', 'examples')]) {
      if (listExampleConfigs(candidate).length > 0) return candidate;
    }
  }
  return null;
}

/** Config paths of the projects directly under an examples directory. */
function listExampleConfigs(dir) {
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
 * Load the example projects under a directory, marked so the view can tell
 * them apart from the workspace's own projects.
 *
 * @param {string} dir
 * @returns {Project[]}
 */
function loadExamples(dir) {
  return loadProjects(listExampleConfigs(dir)).map((project) => ({ ...project, example: true }));
}

/**
 * Add example projects to a list without repeating one the workspace already
 * has — the repository itself lists its examples as ordinary projects.
 *
 * @param {Project[]} projects
 * @param {Project[]} examples
 * @returns {Project[]}
 */
function withExamples(projects, examples) {
  const seen = new Set(projects.map((p) => p.dir));
  return [...projects, ...examples.filter((e) => !seen.has(e.dir))];
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
  bySystem,
  commandArgs,
  findExamplesDir,
  findToolchain,
  loadExamples,
  loadProject,
  loadProjects,
  parseConfig,
  resolveLlvmMosHome,
  runnableOn,
  withExamples,
};
