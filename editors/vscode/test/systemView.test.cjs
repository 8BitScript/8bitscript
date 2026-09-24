const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const { registerSystemView } = require('../src/systemView.cjs');
const { ALL_TARGETS } = require('../src/projects.cjs');
const { parseTargets } = require('../src/hardwareCatalog.cjs');
const { projectSystemsPath, readSystemsMap, userSystemsPath } = require('../src/systemsStore.cjs');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'media', 'system.js'), 'utf8');
const HARDWARE = fs.readFileSync(path.join(ROOT, 'media', 'hardware.js'), 'utf8');
const VIEW = fs.readFileSync(path.join(ROOT, 'src', 'systemView.cjs'), 'utf8');

const SAMPLE = JSON.stringify({
  targets: [{
    id: 'c64',
    title: 'Commodore 64',
    emulator: 'x64sc',
    region: true,
    options: {
      port1: {
        label: 'Control port 1',
        default: 'none',
        values: { none: { label: 'Nothing' }, mouse1351: { label: '1351' } },
      },
    },
    presets: {},
    profiles: {},
    hardware: {},
    facts: {},
  }, {
    id: 'vic20', title: 'VIC-20', emulator: 'xvic', region: true,
    options: {}, presets: {}, profiles: {}, hardware: {}, facts: {},
  }],
  systems: [],
  facts: [],
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '8bs-systemview-'));
}

function fakeProject(dir, overrides = {}) {
  return {
    kind: 'project',
    name: 'my-game',
    dir,
    configPath: path.join(dir, '8bitscript.config.ts'),
    targets: ['c64', 'vic20'],
    ...overrides,
  };
}

function fakeProjects(project, targets) {
  return {
    all: [project],
    visible: [project],
    loadTargets: async () => targets,
    onDidChange: () => ({ dispose() {} }),
    refresh: () => {},
  };
}

/**
 * Registers the command, invokes it, and hands back the webview panel the
 * mock created. `configure` runs after the mock is reset but before the
 * panel opens, so a test can seed settings the panel reads while hydrating.
 */
async function openPanel(projects, configure) {
  vscode.__mock.reset();
  if (configure) configure(vscode);
  const context = { subscriptions: [] };
  registerSystemView(context, projects);
  let created = null;
  const originalCreate = vscode.window.createWebviewPanel;
  vscode.window.createWebviewPanel = (...args) => {
    created = originalCreate(...args);
    return created;
  };
  await vscode.__mock.trigger('8bitscript.configureSystem');
  vscode.window.createWebviewPanel = originalCreate;
  return created;
}

/**
 * Runs `fn(panel)` against a fresh panel for `project`/`targets`, then
 * always disposes it — even on failure. `open` in systemView.cjs is
 * module-level state, so a leaked panel would make the *next* test's
 * "open" reveal this one instead of creating its own.
 */
async function withPanel(project, targets, configure, fn) {
  const panel = await openPanel(fakeProjects(project, targets), configure);
  try {
    await fn(panel);
  } finally {
    panel.__dispose();
  }
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('system builder scripts are valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(HARDWARE, { filename: 'hardware.js' }));
  assert.doesNotThrow(() => new vm.Script(JS, { filename: 'system.js' }));
});

test('every element the system page reaches for is on the page', () => {
  const ids = [...new Set([...JS.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.length > 0);
  for (const id of ids) assert.match(VIEW, new RegExp(`id="${id}"`), `no #${id}`);
});

test('the builder has the five tabs the plan names', () => {
  for (const tab of ['machine', 'hardware', 'region', 'facts', 'save']) {
    assert.match(VIEW, new RegExp(`data-tab="${tab}"`));
    assert.match(VIEW, new RegExp(`id="pane-${tab}"`));
  }
});

test('a save writes one of the three layers, not a private shape', () => {
  assert.match(VIEW, /upsertSystem/);
  assert.match(VIEW, /insertSystem/);
  assert.match(VIEW, /saveLayer/);
  assert.match(VIEW, /id: 'advertised'/);
  assert.match(VIEW, /id: 'project'/);
  assert.match(VIEW, /id: 'user'/);
});

test('ready hydrates from settings and posts the machine list', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), parseTargets(SAMPLE), (v) => v.__mock.configStore.set('system', 'c64'), async (panel) => {
      panel.webview.__fire({ type: 'ready' });
      await tick();
      const state = panel.posted.at(-1);
      assert.equal(state.type, 'state');
      assert.equal(state.tab, 'machine');
      assert.equal(state.project, 'my-game');
      assert.equal(state.draft.target, 'c64');
      assert.equal(state.machines.filter((m) => m.id).length, ALL_TARGETS.length, 'one row per ALL_TARGETS entry, not just what the sample targets');
      assert.ok(state.machines.some((m) => m.group === 'Commodore'), 'machines are grouped by family');
      assert.ok(state.machines.find((m) => m.id === 'c64').runnable);
      assert.equal(state.machines.find((m) => m.id === 'pet').runnable, false, 'a machine the project does not target');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set walks every field the page can change', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), parseTargets(SAMPLE), null, async (panel) => {
      panel.webview.__fire({ type: 'set', key: 'tab', value: 'hardware' });
      panel.webview.__fire({ type: 'set', key: 'target', value: 'vic20' });
      panel.webview.__fire({ type: 'set', key: 'profile', value: 'x' });
      panel.webview.__fire({ type: 'set', key: 'option', option: 'port1', value: 'mouse1351' });
      panel.webview.__fire({ type: 'set', key: 'option', option: 'port1', value: '' });
      panel.webview.__fire({ type: 'set', key: 'region', value: 'pal' });
      panel.webview.__fire({ type: 'set', key: 'stock' });
      panel.webview.__fire({ type: 'set', key: 'layer', value: 'user' });
      panel.webview.__fire({ type: 'set', key: 'nonsense', value: 'x' });
      await tick();
      const state = panel.posted.at(-1);
      assert.equal(state.draft.target, 'vic20', 'switching target resets profile/options');
      assert.equal(state.draft.profile, null, 'stock cleared the profile');
      assert.equal(state.draft.region, 'pal');
      assert.equal(state.draft.layer, 'user');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openConfig opens the project\'s config file', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), parseTargets(SAMPLE), null, async (panel) => {
      panel.webview.__fire({ type: 'command', id: '8bitscript.openConfig' });
      await tick();
      assert.equal(vscode.__mock.calls.showInformationMessage.length, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save: no project to save into', async () => {
  // No project anywhere: an empty `all`/`visible` list.
  const projects = {
    all: [], visible: [], loadTargets: async () => null, onDidChange: () => ({ dispose() {} }), refresh() {},
  };
  const panel = await openPanel(projects);
  try {
    panel.webview.__fire({ type: 'save' });
    await tick();
    assert.equal(vscode.__mock.calls.showInformationMessage.length, 1);
    assert.match(vscode.__mock.calls.showInformationMessage[0][0], /No project to save/);
  } finally {
    panel.__dispose();
  }
});

test('save: an empty name warns and switches to the save tab', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), parseTargets(SAMPLE), null, async (panel) => {
      panel.webview.__fire({ type: 'set', key: 'name', value: '   ' });
      panel.webview.__fire({ type: 'save' });
      await tick();
      assert.match(vscode.__mock.calls.showWarningMessage.at(-1)[0], /needs a name/);
      assert.equal(panel.posted.at(-1).tab, 'save');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save: a machine\'s own name is refused', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), parseTargets(SAMPLE), null, async (panel) => {
      panel.webview.__fire({ type: 'set', key: 'name', value: 'c64' });
      panel.webview.__fire({ type: 'save' });
      await tick();
      assert.match(vscode.__mock.calls.showWarningMessage.at(-1)[0], /machine's own name/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save: a target the project does not target is refused', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir, { targets: ['vic20'] }), parseTargets(SAMPLE), null, async (panel) => {
      // draft.target defaults to settings.getSystem() -> 'pet' (ALL_TARGETS[0])
      panel.webview.__fire({ type: 'set', key: 'target', value: 'c64' });
      panel.webview.__fire({ type: 'set', key: 'name', value: 'My C64' });
      panel.webview.__fire({ type: 'save' });
      await tick();
      assert.match(vscode.__mock.calls.showWarningMessage.at(-1)[0], /does not target/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save: writes into this clone\'s systems.json (project layer)', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), parseTargets(SAMPLE), null, async (panel) => {
      panel.webview.__fire({ type: 'set', key: 'target', value: 'c64' });
      panel.webview.__fire({ type: 'set', key: 'name', value: 'My C64' });
      panel.webview.__fire({ type: 'set', key: 'layer', value: 'project' });
      panel.webview.__fire({ type: 'save' });
      await tick();
      const saved = readSystemsMap(projectSystemsPath(dir));
      assert.ok(saved['My C64'], 'the system landed in the project layer');
      assert.equal(saved['My C64'].target, 'c64');
      assert.match(vscode.__mock.calls.showInformationMessage.at(-1)[0], /Saved 'My C64'/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save: a name shadowed by an existing personal system asks first', async () => {
  const dir = tmpDir();
  try {
    const { upsertSystem } = require('../src/systemsStore.cjs');
    upsertSystem(projectSystemsPath(dir), 'My C64', { target: 'c64' });
    await withPanel(fakeProject(dir), parseTargets(SAMPLE), null, async (panel) => {
      panel.webview.__fire({ type: 'set', key: 'target', value: 'c64' });
      panel.webview.__fire({ type: 'set', key: 'name', value: 'My C64' });
      panel.webview.__fire({ type: 'set', key: 'layer', value: 'advertised' });

      // No choice made: nothing is written.
      panel.webview.__fire({ type: 'save' });
      await tick();
      assert.equal(vscode.__mock.calls.showInformationMessage.length, 0, 'declining the prompt saves nothing');

      // "Save to this clone instead" redirects to the project layer.
      vscode.__mock.queues.showWarningMessage.push('Save to this clone instead');
      panel.webview.__fire({ type: 'save' });
      await tick();
      const saved = readSystemsMap(projectSystemsPath(dir));
      assert.equal(saved['My C64'].target, 'c64');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save: advertising into a plain export default rewrites the config', async () => {
  const dir = tmpDir();
  const originalOpen = vscode.workspace.openTextDocument;
  try {
    await withPanel(fakeProject(dir), parseTargets(SAMPLE), null, async (panel) => {
      const configText = "export default {\n  targets: ['c64'],\n};\n";
      vscode.workspace.openTextDocument = (uri) => Promise.resolve({
        uri,
        getText: () => configText,
        positionAt: (offset) => ({ offset }),
        save: () => Promise.resolve(true),
      });
      panel.webview.__fire({ type: 'set', key: 'target', value: 'c64' });
      panel.webview.__fire({ type: 'set', key: 'name', value: 'My C64' });
      panel.webview.__fire({ type: 'set', key: 'layer', value: 'advertised' });
      panel.webview.__fire({ type: 'save' });
      await tick();
      assert.match(vscode.__mock.calls.showInformationMessage.at(-1)[0], /advertised system/);
    });
  } finally {
    vscode.workspace.openTextDocument = originalOpen;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save: a config that is not a plain export default gets a cursor insert instead', async () => {
  const dir = tmpDir();
  const originalOpen = vscode.workspace.openTextDocument;
  try {
    await withPanel(fakeProject(dir), parseTargets(SAMPLE), null, async (panel) => {
      vscode.workspace.openTextDocument = (uri) => Promise.resolve({
        uri,
        getText: () => '// not a config at all\n',
        positionAt: (offset) => ({ offset }),
        save: () => Promise.resolve(true),
      });
      panel.webview.__fire({ type: 'set', key: 'target', value: 'c64' });
      panel.webview.__fire({ type: 'set', key: 'name', value: 'My C64' });
      panel.webview.__fire({ type: 'set', key: 'layer', value: 'advertised' });
      panel.webview.__fire({ type: 'save' });
      await tick();
      // advertise()'s own early return only exits advertise(), not save():
      // save() still runs its unconditional "Saved" message afterward, so
      // the fallback message from advertise() is the first of the two.
      assert.match(vscode.__mock.calls.showInformationMessage[0][0], /not written for you/);
    });
  } finally {
    vscode.workspace.openTextDocument = originalOpen;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('revealing an already-open panel re-hydrates instead of creating a second one', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), parseTargets(SAMPLE), null, async () => {
      const originalCreate = vscode.window.createWebviewPanel;
      let createdAgain = false;
      vscode.window.createWebviewPanel = (...args) => { createdAgain = true; return originalCreate(...args); };
      await vscode.__mock.trigger('8bitscript.configureSystem');
      vscode.window.createWebviewPanel = originalCreate;
      assert.equal(createdAgain, false, 'the existing panel was reused');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
