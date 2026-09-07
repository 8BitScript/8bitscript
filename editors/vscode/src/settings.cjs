// The choices the side bar's controls make — system, region, view, and
// the hardware fitted per system — kept as ordinary settings so they also
// show up in the Settings editor, survive restarts, and can be set per
// workspace. Everything that runs a project reads them from
// here, so the Run button on any row means the same thing the dropdowns say.
const vscode = require('vscode');

const { ALL_TARGETS } = require('./projects.cjs');
const { normalizeSelection } = require('./hardwareCatalog.cjs');

const SECTION = '8bitscript';

const VIEW_MODES = [
  { id: 'byProject', label: 'By project' },
  { id: 'runnable', label: 'Runnable on the selected system' },
  { id: 'bySystem', label: 'By system' },
];

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
 * The project the Run Settings panel acts on: the absolute directory of
 * one, or '' for "whichever the workspace offers first". A path rather
 * than a name, because two workspace folders can hold projects of the
 * same name.
 *
 * @returns {string}
 */
function getProject() {
  const value = config().get('project');
  return typeof value === 'string' ? value : '';
}
const setProject = (dir) => update('project', dir ?? '');

/** @returns {'runnable' | 'byProject' | 'bySystem'} */
function getViewMode() {
  const value = config().get('projectsView');
  return VIEW_MODES.some((mode) => mode.id === value) ? value : VIEW_MODES[0].id;
}

function config() {
  return vscode.workspace.getConfiguration(SECTION);
}

/**
 * Write one of the three settings. A workspace-level write when a folder is
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
const setViewMode = (mode) => update('projectsView', mode);

/** Whether the examples shipped with the toolchain are listed (the `showExamples` setting). */
function getShowExamples() {
  return config().get('showExamples') === true;
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
  return ['region', 'system', 'project', 'projectsView', 'hardware'].some((key) =>
    event.affectsConfiguration(`${SECTION}.${key}`),
  );
}

function regionLabel(region) {
  const found = REGIONS.find((r) => r.id === region) ?? REGIONS[0];
  return `${found.label} (${found.place})`;
}

/** Just "NTSC" or "PAL", for a spot that already supplies its own parens. */
function regionShort(region) {
  return (REGIONS.find((r) => r.id === region) ?? REGIONS[0]).label;
}

module.exports = {
  REGIONS,
  VIEW_MODES,
  affectsAny,
  getExamplesPath,
  getHardware,
  getProject,
  getRegion,
  getShowExamples,
  getSystem,
  getViewMode,
  regionLabel,
  regionShort,
  setHardware,
  setProject,
  setRegion,
  setShowExamples,
  setSystem,
  setViewMode,
};
