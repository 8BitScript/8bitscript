// The three choices the side bar's dropdowns control, kept as ordinary
// settings so they also show up in the Settings editor, survive restarts, and
// can be set per workspace. Everything that runs a project reads them from
// here, so the Run button on any row means the same thing the dropdowns say.
const vscode = require('vscode');

const { ALL_TARGETS } = require('./projects.cjs');

const SECTION = '8bitscript';

const VIEW_MODES = [
  { id: 'runnable', label: 'Runnable on the selected system' },
  { id: 'byProject', label: 'By project' },
  { id: 'bySystem', label: 'By system' },
];

/** @returns {'ntsc' | 'pal'} */
function getRegion() {
  return config().get('region') === 'pal' ? 'pal' : 'ntsc';
}

/** @returns {'vic20' | 'c64' | 'web'} */
function getSystem() {
  const value = config().get('system');
  return ALL_TARGETS.includes(value) ? value : ALL_TARGETS[0];
}

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

/** Whether the example projects shipped with the toolchain are listed. */
function getShowExamples() {
  return config().get('showExamples') === true;
}
const setShowExamples = (show) => update('showExamples', show);

/** An explicit directory of example projects, when the setting names one. */
function getExamplesPath() {
  const value = config().get('examplesPath');
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** True when a change event touches any of the three settings. */
function affectsAny(event) {
  return ['region', 'system', 'projectsView'].some((key) =>
    event.affectsConfiguration(`${SECTION}.${key}`),
  );
}

function regionLabel(region) {
  return region === 'pal' ? 'PAL' : 'NTSC';
}

module.exports = {
  VIEW_MODES,
  affectsAny,
  getExamplesPath,
  getRegion,
  getShowExamples,
  getSystem,
  getViewMode,
  regionLabel,
  setRegion,
  setShowExamples,
  setSystem,
  setViewMode,
};
