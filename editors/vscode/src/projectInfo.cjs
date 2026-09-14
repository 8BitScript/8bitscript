// What the project-details panel and the sidebar's package list show:
// package manager, lockfile, `@8bitscript/*` versions, install roots.
// Free of the vscode API so node --test can drive it.
const fs = require('fs');
const path = require('path');

const { isCheckout, resolveCheckoutRoot } = require('./checkout.cjs');

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

function readPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Declared `@8bitscript/*` versions in a directory's package.json.
 *
 * @param {string} dir
 * @returns {Record<string, string>}
 */
function eightBitScriptVersions(dir) {
  const pkg = readPackage(dir);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const versions = {};
  for (const [name, spec] of Object.entries(deps)) {
    if (name.startsWith('@8bitscript/') && typeof spec === 'string') versions[name] = spec;
  }
  return versions;
}

/**
 * The lockfile that decided the package manager, walking upward.
 *
 * @param {string} startDir
 * @returns {{ file: string, manager: 'pnpm'|'npm'|'yarn'|'bun' } | null}
 */
function lockfileFor(startDir) {
  let dir = startDir;
  for (;;) {
    for (const [file, manager] of LOCKFILES) {
      if (fs.existsSync(path.join(dir, file))) return { file: path.join(dir, file), manager };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The one install the side bar offers: the 8BitScript tree, never each
 * example or app. A workspace checkout, an explicit setting, or a clone
 * the editor owns. Missing means **Install** clones into `managed`.
 *
 * @param {{ folders?: string[], setting?: string|null, managed?: string|null }} options
 */
function toolchainStatus({ folders = [], setting = null, managed = null } = {}) {
  const resolved = resolveCheckoutRoot({ folders, setting, managed });
  if (resolved) {
    return {
      kind: 'toolchain',
      dir: resolved.dir,
      origin: resolved.origin,
      label: '8BitScript',
      detail: resolved.origin === 'workspace' ? 'this workspace'
        : resolved.origin === 'managed' ? 'installed for this editor'
        : 'local checkout',
      packageManager: lockfileFor(resolved.dir)?.manager ?? 'pnpm',
      installed: fs.existsSync(path.join(resolved.dir, 'node_modules')),
      action: 'update',
      clone: false,
    };
  }

  return {
    kind: 'toolchain',
    dir: managed,
    origin: 'missing',
    label: '8BitScript',
    detail: 'not installed',
    packageManager: 'pnpm',
    installed: false,
    action: 'install',
    clone: true,
  };
}

/**
 * Whether `dir` is `root` or a path under it.
 *
 * @param {string} dir
 * @param {string | null} root
 */
function pathInside(dir, root) {
  if (!dir || !root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Workspace programs (2048, not hello-world, not Studio) each get their
 * own Update. Examples and apps are launched, not installed, from here;
 * a program that lives inside the 8BitScript checkout is covered by the
 * toolchain row.
 *
 * @param {{
 *   projects?: { dir: string, name: string, title?: string, kind?: string, shipped?: boolean, packageManager: string, installed: boolean }[],
 *   checkoutDir?: string|null,
 * }} options
 */
function programStatusRows({ projects = [], checkoutDir = null } = {}) {
  return projects
    .filter((project) => (
      project.kind === 'project'
      && !project.shipped
      && !isCheckout(project.dir)
      && !pathInside(project.dir, checkoutDir)
    ))
    .map((project) => {
      const versions = eightBitScriptVersions(project.dir);
      const published = versions['@8bitscript/cli'] ?? Object.values(versions)[0] ?? null;
      return {
        kind: 'program',
        dir: project.dir,
        origin: 'workspace',
        label: project.title || project.name,
        detail: published ?? '',
        packageManager: project.packageManager ?? lockfileFor(project.dir)?.manager ?? 'pnpm',
        installed: project.installed,
        action: project.installed ? 'update' : 'install',
        clone: false,
      };
    });
}

/**
 * The side bar's install rows: the 8BitScript tree, then each workspace
 * program. Examples and shipped apps are not listed.
 *
 * @param {{
 *   folders?: string[],
 *   setting?: string|null,
 *   managed?: string|null,
 *   projects?: object[],
 * }} options
 */
function installRoots(options = {}) {
  const toolchain = toolchainStatus(options);
  const checkoutDir = toolchain.clone ? null : toolchain.dir;
  return [toolchain, ...programStatusRows({ projects: options.projects, checkoutDir })];
}

/**
 * How the toolchain for one project is being reached.
 *
 * @param {{ checkout?: string|null, publishedVersion?: string|null }} options
 */
function toolchainLabel({ checkout = null, publishedVersion = null } = {}) {
  if (checkout && isCheckout(checkout)) return `local ${path.basename(checkout)}`;
  if (publishedVersion) return `published ${publishedVersion}`;
  return 'published packages';
}

module.exports = {
  eightBitScriptVersions,
  installRoots,
  lockfileFor,
  pathInside,
  programStatusRows,
  readPackage,
  toolchainLabel,
  toolchainStatus,
};
