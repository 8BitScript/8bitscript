const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const { registerDoctorView } = require('../src/doctorView.cjs');
const { ALL_DOCTOR_EMULATOR_IDS, DOCTOR_EMULATORS } = require('../src/projects.cjs');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'media', 'doctor.js'), 'utf8');
const VIEW = fs.readFileSync(path.join(ROOT, 'src', 'doctorView.cjs'), 'utf8');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '8bs-doctorview-'));
}

function fakeProject(dir, overrides = {}) {
  return {
    kind: 'project',
    name: 'my-game',
    dir,
    targets: ['c64', 'nes'],
    ...overrides,
  };
}

function fakeProjects(project, doctor = { ready: ['c64'], notInstalled: ['nes'], failed: [] }) {
  return {
    all: project ? [project] : [],
    visible: project ? [project] : [],
    loadDoctor: async () => doctor,
    onDidChange: () => ({ dispose() {} }),
    refresh: () => {},
  };
}

async function openPanel(projects, configure) {
  vscode.__mock.reset();
  if (configure) configure(vscode);
  const context = { subscriptions: [] };
  registerDoctorView(context, projects);
  let created = null;
  const originalCreate = vscode.window.createWebviewPanel;
  vscode.window.createWebviewPanel = (...args) => {
    created = originalCreate(...args);
    return created;
  };
  await vscode.__mock.trigger('8bitscript.doctorSetup');
  vscode.window.createWebviewPanel = originalCreate;
  return created;
}

async function withPanel(project, configure, fn) {
  const panel = await openPanel(fakeProjects(project), configure);
  try {
    await fn(panel);
  } finally {
    panel.__dispose();
  }
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('doctor script is valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(JS, { filename: 'doctor.js' }));
});

test('every element the doctor page reaches for is on the page', () => {
  const ids = [...new Set([...JS.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.length > 0);
  for (const id of ids) assert.match(VIEW, new RegExp(`id="${id}"`), `no #${id}`);
});

test('ready posts every emulator, all selected by default', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), null, async (panel) => {
      panel.webview.__fire({ type: 'ready' });
      await tick();
      const state = panel.posted.at(-1);
      assert.equal(state.type, 'state');
      assert.equal(state.selected, null);
      assert.equal(state.total, ALL_DOCTOR_EMULATOR_IDS.length);
      assert.equal(state.emulators.length, DOCTOR_EMULATORS.length);
      const vice = state.emulators.find((emu) => emu.id === 'vice');
      assert.equal(vice.status, 'ready');
      const fceux = state.emulators.find((emu) => emu.id === 'fceux');
      assert.equal(fceux.status, 'missing');
      const stella = state.emulators.find((emu) => emu.id === 'stella');
      assert.equal(stella.installable, true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unchecking one emulator writes the remaining ids', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), null, async (panel) => {
      panel.webview.__fire({ type: 'ready' });
      await tick();
      panel.webview.__fire({ type: 'toggle', id: 'vice', checked: false });
      await tick();
      const stored = vscode.__mock.configStore.get('doctorEmulators');
      assert.ok(Array.isArray(stored));
      assert.ok(!stored.includes('vice'));
      assert.equal(stored.length, ALL_DOCTOR_EMULATOR_IDS.length - 1);
      const state = panel.posted.at(-1);
      assert.deepEqual(state.selected, stored);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Check all stores null; Check none stores []; This project maps targets', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), (vs) => {
      vs.__mock.configStore.set('project', dir);
    }, async (panel) => {
      panel.webview.__fire({ type: 'none' });
      await tick();
      assert.deepEqual(vscode.__mock.configStore.get('doctorEmulators'), []);
      panel.webview.__fire({ type: 'all' });
      await tick();
      assert.equal(vscode.__mock.configStore.get('doctorEmulators'), null);
      panel.webview.__fire({ type: 'project' });
      await tick();
      assert.deepEqual(vscode.__mock.configStore.get('doctorEmulators'), ['vice', 'fceux']);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Run doctor and Install selected start 8bitscript.doctor', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), null, async (panel) => {
      panel.webview.__fire({ type: 'run' });
      await tick();
      panel.webview.__fire({ type: 'install' });
      await tick();
      const started = vscode.__mock.executedCommands.filter((c) => c.id === '8bitscript.doctor');
      assert.equal(started.length, 2);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
