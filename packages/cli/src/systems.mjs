// Named systems — a target plus the hardware already fitted — in three
// places, one shape. The advertised block in 8bitscript.config.ts is
// source the team shares. The other two are JSON a person (or the editor)
// writes: this clone's `.8bitscript/systems.json`, and this machine's
// `~/.config/8bitscript/systems.json`. Controllers already live in that
// home directory for the same reason: personal hardware is not a project's
// source.
//
// Merge order (first name wins): project-personal, user, advertised.
// `8bs run --system 'PET 2001 (4K)'` resolves through that merge, then
// becomes the existing --profile / --hardware / --pal path.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { PROJECT_DIRNAME } from './checkout.mjs';
import { listedTargets, parseSystemsMap, projectSystems } from './hardware.mjs';

export const SYSTEMS_FILE = 'systems.json';

/** ~/.config/8bitscript — same XDG-shaped home the controllers file uses. */
export function userConfigDir(home = homedir()) {
  return join(home, '.config', '8bitscript');
}

export function userSystemsPath(home = homedir()) {
  return join(userConfigDir(home), SYSTEMS_FILE);
}

export function projectSystemsPath(projectDir) {
  return join(projectDir, PROJECT_DIRNAME, SYSTEMS_FILE);
}

/** The advertised `systems` block in 8bitscript.config.ts. */
export function advertisedSystems(config) {
  return projectSystems(config);
}

/**
 * Read `{ systems: { … } }` from a JSON file. Missing is empty, not an error.
 *
 * @param {string} path
 * @param {{ where: string, config?: object|null, origin: 'project'|'user', enforceTargets?: boolean }} options
 */
export function loadSystemsFile(path, { where, config = null, origin, enforceTargets = true }) {
  if (!existsSync(path)) return { ok: true, systems: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { ok: false, error: `${where}: cannot parse ${path}: ${error.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `${where} must be a JSON object with a systems map` };
  }
  if (parsed.systems === undefined) return { ok: true, systems: [] };
  return parseSystemsMap(parsed.systems, { where, config, origin, enforceTargets });
}

/**
 * Write a systems map. Creates the directory.
 *
 * @param {string} path
 * @param {object} declared name → entry
 */
export function writeSystemsFile(path, declared) {
  const text = `${JSON.stringify({ systems: declared }, null, 2)}\n`;
  try {
    writeFileSync(path, text);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return path;
}

/**
 * Entries already in a systems JSON file, as a map (unvalidated), for a
 * save that replaces one name.
 *
 * @param {string} path
 */
export function readSystemsMap(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.systems && typeof parsed.systems === 'object' && !Array.isArray(parsed.systems)) {
      return { ...parsed.systems };
    }
  } catch {
    // A save over a broken file starts a new map rather than refusing.
  }
  return {};
}

/**
 * Merge the three layers. First name wins: project, then user, then
 * advertised. A user system whose target this project does not list is
 * dropped (it still exists for other projects). A project file that
 * names a machine this project does not target is an error.
 *
 * @param {{ config?: object|null, projectDir?: string, projectFile?: string, userFile?: string }} [options]
 */
export function loadMergedSystems({
  config = null,
  projectDir = process.cwd(),
  projectFile = projectSystemsPath(projectDir),
  userFile = userSystemsPath(),
} = {}) {
  const advertised = advertisedSystems(config);
  if (!advertised.ok) return advertised;
  const project = loadSystemsFile(projectFile, {
    where: projectFile,
    config,
    origin: 'project',
    enforceTargets: true,
  });
  if (!project.ok) return project;
  const user = loadSystemsFile(userFile, {
    where: userFile,
    config,
    origin: 'user',
    enforceTargets: false,
  });
  if (!user.ok) return user;

  const listed = listedTargets(config);
  const byName = new Map();
  for (const system of project.systems) {
    byName.set(system.name, system);
  }
  for (const system of user.systems) {
    if (listed && !listed.includes(system.target)) continue;
    if (!byName.has(system.name)) byName.set(system.name, system);
  }
  for (const system of advertised.systems) {
    if (!byName.has(system.name)) byName.set(system.name, system);
  }
  return { ok: true, systems: [...byName.values()] };
}

/**
 * @param {string} name
 * @param {object[]} systems
 */
export function findSystem(name, systems) {
  const found = systems.find((system) => system.name === name);
  if (!found) {
    const known = systems.map((system) => system.name);
    return {
      ok: false,
      error: known.length > 0
        ? `unknown system '${name}'. Systems: ${known.join(', ')}`
        : `unknown system '${name}'. This project has no systems; add one in 8bitscript.config.ts or .8bitscript/systems.json`,
    };
  }
  return { ok: true, system: found };
}

/**
 * A named system's fitting, with CLI `--profile` / `--hardware` on top.
 *
 * @param {object} system
 * @param {{ profile?: string, overrides?: object }} hw
 */
export function systemFitting(system, hw) {
  return {
    target: system.target,
    profile: hw.profile ?? system.profile ?? undefined,
    overrides: { ...system.hardware, ...hw.overrides },
    pal: system.region === 'pal',
  };
}

/**
 * `--system` plus the three layers → the target and fitting a run/build
 * will use. Without `--system`, profile/overrides are the flags alone.
 *
 * @param {{ profile?: string, overrides?: object, system?: string }} hw
 * @param {{ config?: object|null, projectDir?: string, projectFile?: string, userFile?: string }} [options]
 */
export function resolveNamedLaunch(hw, options = {}) {
  if (!hw.system) {
    return { ok: true, profile: hw.profile, overrides: hw.overrides, pal: false, target: undefined, system: undefined };
  }
  const merged = loadMergedSystems({ config: options.config ?? null, ...options });
  if (!merged.ok) return merged;
  const found = findSystem(hw.system, merged.systems);
  if (!found.ok) return found;
  return { ok: true, ...systemFitting(found.system, hw), system: found.system };
}
