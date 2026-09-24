// A local 8BitScript checkout used instead of the published `@8bitscript/*`
// packages in node_modules. The consumer's package.json stays on published
// versions — rewriting those to `link:`/`file:` is how the wrong tree
// gets committed. This is the same idea as an editor's TypeScript SDK
// path: point the tool at a tree, do not mutate the project's manifest.
//
// Three ways to name the tree, first one that is set wins:
//   --checkout <dir>
//   EIGHTBITSCRIPT_CHECKOUT
//   <project>/.8bitscript/toolchain.json  `{ "checkout": "<path>" }`
//
// A tree counts as a checkout when it has `pnpm-workspace.yaml` listing
// `packages/*` and `packages/cli/bin/8bs.mjs`. The resolver then prefers
// `<checkout>/packages/<name>` for `@8bitscript/<name>` before walking
// node_modules; loadCatalog reads the same directories.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const TOOLCHAIN_FILE = 'toolchain.json';
export const PROJECT_DIRNAME = '.8bitscript';

/** @type {string|null} */
let active = null;

/** The checkout the current `8bs` command is using, or null. */
export function getActiveCheckout() {
  return active;
}

/** Remember the checkout for this process (catalogs, then compile). */
export function setActiveCheckout(dir) {
  active = dir ?? null;
}

/**
 * Whether `dir` is an 8BitScript monorepo checkout.
 *
 * @param {string} dir
 */
export function isCheckout(dir) {
  if (!dir) return false;
  const workspace = join(dir, 'pnpm-workspace.yaml');
  const cli = join(dir, 'packages', 'cli', 'bin', '8bs.mjs');
  if (!existsSync(workspace) || !existsSync(cli)) return false;
  try {
    return readFileSync(workspace, 'utf8').includes('packages/*');
  } catch {
    return false;
  }
}

/**
 * `@8bitscript/cli` → `<checkout>/packages/cli` when that package.json
 * exists. Unscoped names and anything else are not in this tree.
 *
 * @param {string} checkout
 * @param {string} name
 * @returns {string|null}
 */
export function packageDirInCheckout(checkout, name) {
  const match = /^@8bitscript\/([^/]+)$/.exec(name);
  if (!match) return null;
  const dir = join(checkout, 'packages', match[1]);
  return existsSync(join(dir, 'package.json')) ? dir : null;
}

/** `<project>/.8bitscript/toolchain.json`. */
export function toolchainPath(projectDir) {
  return join(projectDir, PROJECT_DIRNAME, TOOLCHAIN_FILE);
}

/**
 * `{ checkout }` from the project's toolchain file, or null.
 *
 * @param {string} projectDir
 * @returns {{ checkout?: string }|null}
 */
export function readToolchainFile(projectDir) {
  const path = toolchainPath(projectDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const checkout = typeof parsed.checkout === 'string' && parsed.checkout !== ''
      ? parsed.checkout
      : undefined;
    return checkout ? { checkout } : {};
  } catch {
    return { error: `cannot parse ${path}` };
  }
}

/**
 * Write `{ checkout }` (or drop the key) into the project's toolchain file.
 *
 * @param {string} projectDir
 * @param {string|null} checkout
 */
export function writeToolchainFile(projectDir, checkout) {
  const path = toolchainPath(projectDir);
  const current = readToolchainFile(projectDir);
  if (current?.error) throw new Error(current.error);
  const next = { ...(current && typeof current === 'object' ? current : {}) };
  if (checkout) next.checkout = checkout;
  else delete next.checkout;
  if (Object.keys(next).length === 0) {
    try {
      writeFileSync(path, '{}\n');
    } catch (error) {
      if (error.code === 'ENOENT') {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '{}\n');
        return path;
      }
      throw error;
    }
    return path;
  }
  const text = `${JSON.stringify(next, null, 2)}\n`;
  try {
    writeFileSync(path, text);
  } catch (error) {
    if (error.code === 'ENOENT') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    } else {
      throw error;
    }
  }
  return path;
}

/**
 * `--checkout <dir>` positions, so callers can drop them from positionals.
 *
 * @param {string[]} args
 * @returns {{ ok: true, flag: string|undefined, consumed: Set<number> } | { ok: false, error: string }}
 */
export function checkoutArgs(args) {
  const consumed = new Set();
  let flag;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--checkout') continue;
    if (args[i + 1] === undefined) return { ok: false, error: '--checkout expects a directory' };
    flag = args[i + 1];
    consumed.add(i).add(i + 1);
  }
  return { ok: true, flag, consumed };
}

/**
 * Resolve the checkout for one command, first source that is set.
 *
 * @param {string} projectDir
 * @param {{ flag?: string, env?: NodeJS.ProcessEnv }} [choice]
 * @returns {{ ok: true, checkout: string|null } | { ok: false, error: string }}
 */
export function resolveCheckout(projectDir, { flag, env = process.env } = {}) {
  const file = readToolchainFile(projectDir);
  if (file?.error) return { ok: false, error: file.error };
  const named = [
    flag,
    env.EIGHTBITSCRIPT_CHECKOUT,
    file?.checkout,
  ].find((value) => typeof value === 'string' && value !== '');
  if (!named) {
    let walk = projectDir;
    while (walk) {
      if (isCheckout(walk)) return { ok: true, checkout: walk };
      const parent = dirname(walk);
      if (parent === walk) break;
      walk = parent;
    }
    return { ok: true, checkout: null };
  }
  const dir = isAbsolute(named) ? named : resolve(projectDir, named);
  if (!isCheckout(dir)) {
    return {
      ok: false,
      error: `'${dir}' is not an 8BitScript checkout (need pnpm-workspace.yaml listing packages/* and packages/cli/bin/8bs.mjs)`,
    };
  }
  return { ok: true, checkout: dir };
}

/**
 * Resolve from argv + cwd, apply it for catalogs, and return consumed
 * indexes so the caller can drop `--checkout` from positionals.
 *
 * @param {string[]} args
 * @param {string} [projectDir]
 */
export function applyCheckoutFromArgs(args, projectDir = process.cwd()) {
  const parsed = checkoutArgs(args);
  if (!parsed.ok) return parsed;
  const resolved = resolveCheckout(projectDir, { flag: parsed.flag });
  if (!resolved.ok) return resolved;
  setActiveCheckout(resolved.checkout);
  return { ok: true, checkout: resolved.checkout, consumed: parsed.consumed };
}
