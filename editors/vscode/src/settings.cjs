// The choices the launcher makes — the project, the system, its region,
// and the hardware fitted to it — kept as ordinary settings so they also
// show up in the Settings editor, survive restarts, and can be set per
// workspace. Everything that runs a project reads them from here, so the
// Run button means exactly what the panel says it does.
const vscode = require('vscode');

const { ALL_TARGETS } = require('./projects.cjs');
const { normalizeSelection, worstSelection } = require('./hardwareCatalog.cjs');

const SECTION = '8bitscript';

// The region names on the box: NTSC-format machines were sold as the US/
// Canada/Japan model, PAL as the European (and Australian) one. 8bs itself
// only knows "ntsc" and "pal" — these are just what a person remembers the
// dropdown by.
const REGIONS = [
  { id: 'ntsc', label: 'NTSC', place: 'US/Japan', hz: '60Hz' },
  { id: 'pal', label: 'PAL', place: 'Europe', hz: '50Hz' },
];

/** @returns {'ntsc' | 'pal'} */
function getRegion() {
  return config().get('region') === 'pal' ? 'pal' : 'ntsc';
}

/** @returns {string} one of ALL_TARGETS */
function getSystem() {
  const value = config().get('system');
  return ALL_TARGETS.includes(value) ? value : ALL_TARGETS[0];
}

/**
 * The project the launcher acts on: the absolute directory of one, or ''
 * for "whichever the workspace offers first". A path rather than a name,
 * because two workspace folders can hold projects of the same name.
 *
 * @returns {string}
 */
function getProject() {
  const value = config().get('project');
  return typeof value === 'string' ? value : '';
}
const setProject = (dir) => update('project', dir ?? '');

function config() {
  return vscode.workspace.getConfiguration(SECTION);
}

/**
 * Write one of the settings. A workspace-level write when a folder is
 * open, so two repositories can default to different machines; global
 * otherwise, so the choice still sticks in an empty window.
 */
async function update(key, value) {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await config().update(key, value, target);
}

const setRegion = (region) => update('region', region);
const setSystem = (system) => update('system', system);

/**
 * Whether the examples that ship with the toolchain are in the Project
 * dropdown (the `showExamples` setting). On by default: they are in a
 * group of their own under the workspace's projects, and a new project's
 * first run is usually one of them. `Launch Example…` reaches them either
 * way.
 */
function getShowExamples() {
  return config().get('showExamples') !== false;
}
const setShowExamples = (show) => update('showExamples', show);

/** An explicit directory of examples, when the `examplesPath` setting names one. */
function getExamplesPath() {
  const value = config().get('examplesPath');
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The hardware fitted to one system when it is run: `{ profile, options }`
 * from the `hardware` setting, an object keyed by system. Stock when
 * nothing is stored.
 *
 * @param {string} system
 * @returns {{ profile: string|null, options: Record<string, string> }}
 */
function getHardware(system) {
  const all = config().get('hardware');
  return normalizeSelection(all && typeof all === 'object' ? all[system] : undefined);
}

/**
 * What a run actually fits the machine with: the stored selection, or —
 * when nothing is stored — the machine's worst RAM config rather than its
 * catalog stock, so a first run tests a program against the smallest
 * machine it is meant to fit rather than the roomiest one the catalog
 * happens to default to. `target` is the catalog entry from
 * `parseTargets()` (`8bs targets --json`, already asked for whatever else
 * a caller needs it for); with none available yet, this falls back to
 * plain stock the same as `getHardware` alone would.
 *
 * @param {string} system
 * @param {object|null|undefined} target
 * @returns {{ profile: string|null, options: Record<string, string> }}
 */
function getEffectiveHardware(system, target) {
  const stored = getHardware(system);
  if (stored.profile !== null || Object.keys(stored.options).length > 0) return stored;
  return target ? worstSelection(target) : stored;
}

/** Store one system's hardware selection, leaving the others as they are. */
async function setHardware(system, selection) {
  const all = config().get('hardware');
  const next = { ...(all && typeof all === 'object' ? all : {}) };
  const normalized = normalizeSelection(selection);
  if (!normalized.profile && Object.keys(normalized.options).length === 0) delete next[system];
  else next[system] = normalized;
  await update('hardware', next);
}

/** True when a change event touches any of the run settings. */
function affectsAny(event) {
  return ['region', 'system', 'project', 'hardware'].some((key) =>
    event.affectsConfiguration(`${SECTION}.${key}`),
  );
}

/** Just "NTSC" or "PAL"; the panel's own line supplies the context. */
function regionShort(region) {
  return (REGIONS.find((r) => r.id === region) ?? REGIONS[0]).label;
}

module.exports = {
  REGIONS,
  affectsAny,
  getEffectiveHardware,
  getExamplesPath,
  getHardware,
  getProject,
  getRegion,
  getShowExamples,
  getSystem,
  regionShort,
  setHardware,
  setProject,
  setRegion,
  setShowExamples,
  setSystem,
};
