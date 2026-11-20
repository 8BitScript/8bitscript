// Named systems in the two JSON layers — this clone and this user.
// The advertised block stays in 8bitscript.config.ts (insertSystem).
// Same file shape as packages/cli/src/systems.mjs; CommonJS so the
// extension can write it without importing the CLI.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PROJECT_DIRNAME } = require('./checkout.cjs');

const SYSTEMS_FILE = 'systems.json';

function userConfigDir(home = os.homedir()) {
  return path.join(home, '.config', '8bitscript');
}

function userSystemsPath(home = os.homedir()) {
  return path.join(userConfigDir(home), SYSTEMS_FILE);
}

function projectSystemsPath(projectDir) {
  return path.join(projectDir, PROJECT_DIRNAME, SYSTEMS_FILE);
}

/**
 * The systems map in a JSON file, unvalidated. Missing or broken is `{}`.
 *
 * @param {string} filePath
 * @returns {Record<string, object>}
 */
function readSystemsMap(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed?.systems && typeof parsed.systems === 'object' && !Array.isArray(parsed.systems)) {
      return { ...parsed.systems };
    }
  } catch {
    // A save over a broken file starts a new map rather than refusing.
  }
  return {};
}

/**
 * Write `{ systems }` and create the directory if needed.
 *
 * @param {string} filePath
 * @param {Record<string, object>} declared
 * @returns {string}
 */
function writeSystemsFile(filePath, declared) {
  const text = `${JSON.stringify({ systems: declared }, null, 2)}\n`;
  try {
    fs.writeFileSync(filePath, text);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
  }
  return filePath;
}

/**
 * One system as the JSON files store it — no origin, no label.
 *
 * @param {{ target: string, profile?: string|null, hardware?: object, region?: string|null }} entry
 */
function systemEntry({ target, profile = null, hardware = {}, region = null }) {
  const entry = { target };
  if (profile) entry.profile = profile;
  const options = hardware && typeof hardware === 'object' ? hardware : {};
  if (Object.keys(options).length > 0) entry.hardware = { ...options };
  if (region) entry.region = region;
  return entry;
}

/**
 * Replace one name in a systems file.
 *
 * @param {string} filePath
 * @param {string} name
 * @param {{ target: string, profile?: string|null, hardware?: object, region?: string|null }} entry
 */
function upsertSystem(filePath, name, entry) {
  const map = readSystemsMap(filePath);
  map[name] = systemEntry(entry);
  return writeSystemsFile(filePath, map);
}

/**
 * Where a save of `name` to `wanted` should land. First name wins in the
 * CLI (project, then user, then advertised), so a save that would collide
 * with a more-specific name updates that layer instead.
 *
 * Advertising a name that already exists as personal is `shadowed`: the
 * host asks before writing the config, because the personal file would
 * still win.
 *
 * @param {string} name
 * @param {'project'|'user'|'advertised'} wanted
 * @param {{ projectNames: Set<string>|string[], userNames: Set<string>|string[] }} existing
 * @returns {{ layer: 'project'|'user'|'advertised', reason?: 'more-specific'|'shadowed' }}
 */
function saveLayer(name, wanted, { projectNames, userNames }) {
  const project = projectNames instanceof Set ? projectNames : new Set(projectNames);
  const user = userNames instanceof Set ? userNames : new Set(userNames);
  if (wanted === 'user' && project.has(name)) {
    return { layer: 'project', reason: 'more-specific' };
  }
  if (wanted === 'advertised' && (project.has(name) || user.has(name))) {
    return { layer: wanted, reason: 'shadowed' };
  }
  return { layer: wanted };
}

/**
 * Names already on each JSON layer, for the collision rule.
 *
 * @param {string} projectDir
 * @param {string} [home]
 */
function layerNames(projectDir, home = os.homedir()) {
  return {
    projectNames: new Set(Object.keys(readSystemsMap(projectSystemsPath(projectDir)))),
    userNames: new Set(Object.keys(readSystemsMap(userSystemsPath(home)))),
  };
}

module.exports = {
  SYSTEMS_FILE,
  layerNames,
  projectSystemsPath,
  readSystemsMap,
  saveLayer,
  systemEntry,
  upsertSystem,
  userConfigDir,
  userSystemsPath,
  writeSystemsFile,
};
