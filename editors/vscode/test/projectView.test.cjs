const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const { registerProjectView } = require('../src/projectView.cjs');
const { parseTargets } = require('../src/hardwareCatalog.cjs');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'media', 'project.js'), 'utf8');
const VIEW = fs.readFileSync(path.join(ROOT, 'src', 'projectView.cjs'), 'utf8');

const SAMPLE_TARGETS = parseTargets(JSON.stringify({
  targets: [{
    id: 'c64', title: 'Commodore 64', emulator: 'x64sc', region: true,
    options: {}, presets: {}, profiles: {}, hardware: {}, facts: {},
  }],
  systems: [
    { name: 'C64 with a mouse', target: 'c64', origin: 'advertised', label: 'stock' },
  ],
  facts: [],
}));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '8bs-projectview-'));
}

function fakeProject(dir, overrides = {}) {
  return {
    kind: 'project',
    name: 'my-game',
    dir,
    shipped: false,
    configPath: path.join(dir, '8bitscript.config.ts'),
    entry: path.join(dir, 'src', 'main.8bs'),
    targets: ['c64'],
    packageManager: 'pnpm',
    installed: true,
    ...overrides,
  };
}

function fakeProjects(project, targets = SAMPLE_TARGETS) {
  return {
    all: project ? [project] : [],
    visible: project ? [project] : [],
    managedDir: null,
    loadTargets: async () => targets,
    checkoutFlag: () => null,
    onDidChange: () => ({ dispose() {} }),
    refresh: () => {},
  };
}

/** Registers the command, invokes it, and hands back the mock's webview panel. */
async function openPanel(projects, node, configure) {
  vscode.__mock.reset();
  if (configure) configure(vscode);
  const context = { subscriptions: [] };
  registerProjectView(context, projects);
  let created = null;
  const originalCreate = vscode.window.createWebviewPanel;
  vscode.window.createWebviewPanel = (...args) => {
    created = originalCreate(...args);
    return created;
  };
  await vscode.__mock.trigger('8bitscript.showProject', node);
  vscode.window.createWebviewPanel = originalCreate;
  return created;
}

async function withPanel(project, node, configure, fn) {
  const panel = await openPanel(fakeProjects(project), node, configure);
  try {
    await fn(panel);
  } finally {
    panel.__dispose();
  }
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('project details script is valid JavaScript', () => {
  new vm.Script(JS, { filename: 'project.js' });
});

test('every element the project page reaches for is on the page', () => {
  const ids = [...new Set([...JS.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.length > 0);
  for (const id of ids) assert.match(VIEW, new RegExp(`id="${id}"`), `no #${id}`);
});

test('the page can install, refresh, and switch toolchain without rewriting package.json', () => {
  assert.match(JS, /8bitscript.install/);
  assert.match(JS, /8bitscript.useLocal/);
  assert.match(JS, /8bitscript.usePublished/);
  assert.doesNotMatch(VIEW, /package\.json/);
});

test('ready posts a project\'s details, including its systems', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), undefined, null, async (panel) => {
      panel.webview.__fire({ type: 'ready' });
      await tick();
      const state = panel.posted.at(-1);
      assert.equal(state.type, 'state');
      assert.equal(state.empty, false);
      assert.equal(state.name, 'my-game');
      assert.equal(state.dir, dir);
      assert.equal(state.entry, path.join('src', 'main.8bs'));
      assert.equal(state.targets.length, 1);
      assert.equal(state.systems.length, 1);
      assert.equal(state.systems[0].name, 'C64 with a mouse');
      assert.equal(state.packageManager, 'pnpm');
      assert.equal(state.checkoutAvailable, false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no project at all posts the empty state', async () => {
  await withPanel(undefined, undefined, null, async (panel) => {
    panel.webview.__fire({ type: 'ready' });
    await tick();
    const state = panel.posted.at(-1);
    assert.equal(state.empty, true);
    assert.equal(state.name, '');
    assert.deepEqual(state.targets, []);
    assert.equal(state.installed, true, 'no project is never shown as needing install');
  });
});

test('an allowed command runs and re-posts state', async () => {
  const dir = tmpDir();
  try {
    const project = fakeProject(dir);
    await withPanel(project, undefined, null, async (panel) => {
      let refreshRan = false;
      vscode.__mock.commandHandlers.set('8bitscript.refresh', () => { refreshRan = true; });
      panel.webview.__fire({ type: 'command', id: '8bitscript.refresh' });
      await tick();
      assert.equal(refreshRan, true);
      const executed = vscode.__mock.executedCommands.find((c) => c.id === '8bitscript.refresh');
      assert.ok(executed, 'the command was routed through vscode.commands.executeCommand');
      assert.equal(executed.args[0].project, project, 'the selected project rides along');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecognized command id is refused', async () => {
  const dir = tmpDir();
  try {
    await withPanel(fakeProject(dir), undefined, null, async (panel) => {
      panel.webview.__fire({ type: 'command', id: 'not.a.real.command' });
      await tick();
      assert.equal(vscode.__mock.executedCommands.length, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkout in use is reported once it resolves as a real checkout', async () => {
  const dir = tmpDir();
  const checkoutDir = tmpDir();
  try {
    fs.mkdirSync(path.join(checkoutDir, 'packages', 'cli', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(checkoutDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    fs.writeFileSync(path.join(checkoutDir, 'packages', 'cli', 'bin', '8bs.mjs'), '');
    const project = fakeProject(dir);
    const projects = { ...fakeProjects(project), checkoutFlag: () => checkoutDir };
    const panel = await openPanel(projects);
    try {
      panel.webview.__fire({ type: 'ready' });
      await tick();
      assert.equal(panel.posted.at(-1).checkout, checkoutDir);
    } finally {
      panel.__dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test('showing the project again with a different node retargets an already-open panel', async () => {
  const dir = tmpDir();
  const otherDir = tmpDir();
  try {
    const project = fakeProject(dir);
    const other = fakeProject(otherDir, { name: 'other-game' });
    const projects = {
      all: [project, other], visible: [project, other], managedDir: null,
      loadTargets: async () => SAMPLE_TARGETS, checkoutFlag: () => null,
      onDidChange: () => ({ dispose() {} }), refresh: () => {},
    };
    const panel = await openPanel(projects, { project });
    try {
      let createdAgain = false;
      const originalCreate = vscode.window.createWebviewPanel;
      vscode.window.createWebviewPanel = (...args) => { createdAgain = true; return originalCreate(...args); };
      await vscode.__mock.trigger('8bitscript.showProject', { project: other });
      vscode.window.createWebviewPanel = originalCreate;
      assert.equal(createdAgain, false, 'the existing panel was reused, not duplicated');
      assert.equal(panel.posted.at(-1).name, 'other-game');
    } finally {
      panel.__dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});
