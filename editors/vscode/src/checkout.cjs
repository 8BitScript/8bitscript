// A local 8BitScript checkout, as the editor sees it. Same rules as
// packages/cli/src/checkout.mjs — a tree, not a rewrite of package.json —
// kept in CommonJS so the extension can test this without importing ESM.
const fs = require('fs');
const path = require('path');

const TOOLCHAIN_FILE = 'toolchain.json';
const PROJECT_DIRNAME = '.8bitscript';
/** Directory name under the extension's globalStorage for a cloned tree. */
const MANAGED_CHECKOUT = 'checkout';
const REPO_CLONE_URL = 'https://github.com/8BitScript/8bitscript.git';
const REPO_CLONE_BRANCH = 'trunk';

/** `<storageRoot>/checkout` — a clone the editor owns, not a workspace folder. */
function managedCheckoutDir(storageRoot) {
  return storageRoot ? path.join(storageRoot, MANAGED_CHECKOUT) : null;
}

/**
 * The 8BitScript tree to use: an open workspace folder that is this
 * monorepo first (so opening the repo always beats a leftover editor
 * clone), then an explicit `8bitscript.checkout` setting, then a clone
 * the editor owns under globalStorage.
 *
 * @param {{ folders?: string[], setting?: string|null, managed?: string|null }} options
 * @returns {{ dir: string, origin: 'setting'|'workspace'|'managed' } | null}
 */
function resolveCheckoutRoot({ folders = [], setting = null, managed = null } = {}) {
  const workspace = findCheckout(folders);
  if (workspace) return { dir: workspace, origin: 'workspace' };
  if (setting && isCheckout(setting)) return { dir: setting, origin: 'setting' };
  if (managed && isCheckout(managed)) return { dir: managed, origin: 'managed' };
  return null;
}

/**
 * `--checkout` for a run or the language server: the workspace repo if
 * it is open, else the setting if it names a checkout. The editor-owned
 * clone is not injected here — it is how Studio and the examples are
 * found, and becomes `--checkout` only after Use local 8BitScript.
 *
 * @param {{ folders?: string[], setting?: string|null }} options
 * @returns {string | null}
 */
function runCheckout({ folders = [], setting = null } = {}) {
  return resolveCheckoutRoot({ folders, setting, managed: null })?.dir ?? null;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Clone or fast-forward the editor-owned checkout, then `pnpm install`
 * **in that tree** — never in its parent (globalStorage).
 *
 * @param {{ git: string, pnpm: string, dest: string, have: boolean }} options
 * @returns {{ cwd: string, line: string, pull: boolean }}
 */
function managedUpdateCommand({ git, pnpm, dest, have }) {
  const g = shQuote(git);
  const p = shQuote(pnpm);
  const d = shQuote(dest);
  if (have) {
    return { cwd: dest, line: `${g} pull --ff-only && ${p} install`, pull: true };
  }
  return {
    cwd: path.dirname(dest),
    line: `${g} clone --depth 1 --branch ${REPO_CLONE_BRANCH} ${shQuote(REPO_CLONE_URL)} ${d} && ${p} install --dir ${d}`,
    pull: false,
  };
}

/**
 * Whether `dir` is an 8BitScript monorepo checkout: `pnpm-workspace.yaml`
 * lists `packages/*`, and `packages/cli/bin/8bs.mjs` is there.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isCheckout(dir) {
  if (!dir) return false;
  const workspace = path.join(dir, 'pnpm-workspace.yaml');
  const cli = path.join(dir, 'packages', 'cli', 'bin', '8bs.mjs');
  if (!fs.existsSync(workspace) || !fs.existsSync(cli)) return false;
  try {
    return fs.readFileSync(workspace, 'utf8').includes('packages/*');
  } catch {
    return false;
  }
}

/** `<checkout>/packages/cli/bin/8bs.mjs`, or null. */
function checkoutCli(dir) {
  if (!isCheckout(dir)) return null;
  return path.join(dir, 'packages', 'cli', 'bin', '8bs.mjs');
}

/**
 * The first directory in `dirs` that is a checkout, or null.
 *
 * @param {string[]} dirs
 * @returns {string | null}
 */
function findCheckout(dirs) {
  for (const dir of dirs) {
    if (isCheckout(dir)) return dir;
  }
  return null;
}

function toolchainPath(projectDir) {
  return path.join(projectDir, PROJECT_DIRNAME, TOOLCHAIN_FILE);
}

/**
 * `{ checkout }` from a project's toolchain file, or null when missing.
 *
 * @param {string} projectDir
 * @returns {{ checkout?: string, error?: string } | null}
 */
function readToolchainFile(projectDir) {
  const file = toolchainPath(projectDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const checkout = typeof parsed.checkout === 'string' && parsed.checkout !== ''
      ? parsed.checkout
      : undefined;
    return checkout ? { checkout } : {};
  } catch {
    return { error: `cannot parse ${file}` };
  }
}

/**
 * Write or clear `{ checkout }` in `<project>/.8bitscript/toolchain.json`.
 *
 * @param {string} projectDir
 * @param {string | null} checkout
 * @returns {string} the file written
 */
function writeToolchainFile(projectDir, checkout) {
  const file = toolchainPath(projectDir);
  const current = readToolchainFile(projectDir);
  if (current?.error) throw new Error(current.error);
  const next = { ...(current && typeof current === 'object' && !current.error ? current : {}) };
  if (checkout) next.checkout = checkout;
  else delete next.checkout;
  const text = `${JSON.stringify(next, null, 2)}\n`;
  try {
    fs.writeFileSync(file, text);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return file;
}

/**
 * Resolve a project's checkout: an explicit workspace setting first, then
 * this clone's toolchain.json. Relative paths are from the project.
 *
 * @param {string} projectDir
 * @param {string} [setting] workspace `8bitscript.checkout`
 * @returns {string | null}
 */
function resolveProjectCheckout(projectDir, setting) {
  if (setting && isCheckout(setting)) return setting;
  const file = readToolchainFile(projectDir);
  if (!file?.checkout) return null;
  const dir = path.isAbsolute(file.checkout) ? file.checkout : path.resolve(projectDir, file.checkout);
  return isCheckout(dir) ? dir : null;
}

module.exports = {
  MANAGED_CHECKOUT,
  PROJECT_DIRNAME,
  REPO_CLONE_BRANCH,
  REPO_CLONE_URL,
  TOOLCHAIN_FILE,
  checkoutCli,
  findCheckout,
  isCheckout,
  managedCheckoutDir,
  managedUpdateCommand,
  resolveCheckoutRoot,
  runCheckout,
  readToolchainFile,
  resolveProjectCheckout,
  toolchainPath,
  writeToolchainFile,
};
