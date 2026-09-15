// The launcher's Run label is rebuilt after `loadTargets`, which is a CLI
// spawn on first load. A named system is also written as several settings
// (name, then machine). These hold that the button cannot stay on the
// previous machine through either race.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const { registerLauncherView } = require('../src/launcherView.cjs');
const { parseTargets } = require('../src/hardwareCatalog.cjs');

const SAMPLE_TARGETS = parseTargets(JSON.stringify({
  targets: [
    {
      id: 'c64', title: 'Commodore 64', emulator: 'x64sc', region: true,
      options: {}, presets: {}, profiles: {}, hardware: {}, facts: {},
    },
    {
      id: 'web', title: 'Web', emulator: '', region: false,
      options: {}, presets: {}, profiles: {}, hardware: {}, facts: {},
    },
  ],
  systems: [
    { name: 'Commodore 64', target: 'c64', origin: 'advertised', label: 'stock', region: null, hardware: {}, profile: null },
    { name: 'The browser', target: 'web', origin: 'advertised', label: 'stock', region: null, hardware: {}, profile: null },
  ],
  facts: [],
}));

function fakeProject(dir) {
  return {
    kind: 'example',
    name: 'hello-world',
    title: 'hello-world',
    dir,
    shipped: true,
    configPath: path.join(dir, '8bitscript.config.ts'),
    entry: path.join(dir, 'src', 'main.8bs'),
    targets: ['c64', 'web'],
    packageManager: 'pnpm',
    installed: true,
    toolchain: '/fake/8bs',
  };
}

function fakeProjects(project, loadTargets) {
  const listeners = [];
  return {
    all: [project],
    visible: [project],
    projects: [project],
    managedDir: null,
    running: { list: () => [] },
    live: new Map(),
    checkoutFlag: () => null,
    onDidChange: (listener) => {
      listeners.push(listener);
      return { dispose() {} };
    },
    fireChange() {
      for (const listener of listeners) listener();
    },
    refresh() {},
    loadTargets,
  };
}

function fakeView() {
  const posted = [];
  const listeners = [];
  const visListeners = [];
  return {
    visible: true,
    posted,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      postMessage(message) {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (listener) => {
        listeners.push(listener);
        return { dispose() {} };
      },
      __fire(message) {
        for (const listener of listeners) listener(message);
      },
    },
    onDidChangeVisibility: (listener) => {
      visListeners.push(listener);
      return { dispose() {} };
    },
    show() {
      this.visible = true;
      for (const listener of visListeners) listener();
    },
    onDidDispose: () => ({ dispose() {} }),
  };
}

function fakeDevReload() {
  const listeners = [];
  return {
    phase: 'idle',
    error: null,
    onDidChange: (listener) => {
      listeners.push(listener);
      return { dispose() {} };
    },
    fire() {
      for (const listener of listeners) listener();
    },
  };
}

function states(view) {
  return view.posted.filter((message) => message.type === 'state');
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('a named C64 still labels Run as C64 while 8bitscript.system is still web', async () => {
  const dir = '/tmp/hello-world';
  const project = fakeProject(dir);
  vscode.__mock.reset();
  vscode.__mock.configStore.set('project', dir);
  vscode.__mock.configStore.set('system', 'web');
  vscode.__mock.configStore.set('namedSystem', 'Commodore 64');
  const provider = registerLauncherView(
    { subscriptions: [] },
    fakeProjects(project, async () => SAMPLE_TARGETS),
  );
  const view = fakeView();
  provider.resolveWebviewView(view);
  await provider.post();
  const state = states(view).at(-1);
  assert.equal(state.systemTitle, 'Commodore 64');
  assert.match(state.subtitle, /^Commodore 64\b/);
  assert.doesNotMatch(state.subtitle, /^Web\b/);
  assert.match(state.command, /Commodore 64/);
  assert.doesNotMatch(state.command, /The browser/);
});

test('an older post waiting on loadTargets cannot overwrite a later C64 selection', async () => {
  const dir = '/tmp/hello-world';
  const project = fakeProject(dir);
  let entered = 0;
  let release;
  let hitGate;
  const gate = new Promise((resolve) => { release = resolve; });
  const enteredGate = new Promise((resolve) => { hitGate = resolve; });
  const loadTargets = async () => {
    const n = ++entered;
    if (n === 1) {
      hitGate();
      await gate;
    }
    return SAMPLE_TARGETS;
  };

  vscode.__mock.reset();
  vscode.__mock.configStore.set('project', dir);
  vscode.__mock.configStore.set('system', 'web');
  vscode.__mock.configStore.set('namedSystem', 'The browser');
  const provider = registerLauncherView({ subscriptions: [] }, fakeProjects(project, loadTargets));
  const view = fakeView();
  provider.resolveWebviewView(view);
  await enteredGate;

  vscode.__mock.configStore.set('system', 'c64');
  vscode.__mock.configStore.set('namedSystem', 'Commodore 64');
  await provider.post();
  const painted = states(view);
  assert.equal(painted.at(-1).systemTitle, 'Commodore 64');
  const countAfterLatest = painted.length;

  release();
  await tick();
  await tick();
  const after = states(view);
  assert.equal(after.length, countAfterLatest, 'the first-load post must not paint after the later one');
  assert.equal(after.at(-1).systemTitle, 'Commodore 64');
  assert.match(after.at(-1).subtitle, /^Commodore 64\b/);
});

test('set() of a named system paints C64 even if the previous machine was web', async () => {
  const dir = '/tmp/hello-world';
  const project = fakeProject(dir);
  vscode.__mock.reset();
  vscode.__mock.configStore.set('project', dir);
  vscode.__mock.configStore.set('system', 'web');
  vscode.__mock.configStore.set('namedSystem', 'The browser');
  const provider = registerLauncherView(
    { subscriptions: [] },
    fakeProjects(project, async () => SAMPLE_TARGETS),
  );
  const view = fakeView();
  provider.resolveWebviewView(view);
  await tick();
  await provider.set({ key: 'system', value: 'Commodore 64' });
  const state = states(view).at(-1);
  assert.equal(vscode.__mock.configStore.get('namedSystem'), 'Commodore 64');
  assert.equal(vscode.__mock.configStore.get('system'), 'c64');
  assert.equal(state.systemTitle, 'Commodore 64');
  assert.match(state.subtitle, /^Commodore 64\b/);
});

test('set() of a bare machine id clears the named system', async () => {
  const dir = '/tmp/hello-world';
  const project = fakeProject(dir);
  vscode.__mock.reset();
  vscode.__mock.configStore.set('project', dir);
  vscode.__mock.configStore.set('system', 'web');
  vscode.__mock.configStore.set('namedSystem', 'The browser');
  const provider = registerLauncherView(
    { subscriptions: [] },
    fakeProjects(project, async () => SAMPLE_TARGETS),
  );
  const view = fakeView();
  provider.resolveWebviewView(view);
  await tick();
  await provider.set({ key: 'system', value: 'c64' });
  assert.equal(vscode.__mock.configStore.get('namedSystem'), '');
  assert.equal(vscode.__mock.configStore.get('system'), 'c64');
  const state = states(view).at(-1);
  assert.equal(state.systemTitle, 'Commodore 64');
});

test('set() of a project applies its first named system', async () => {
  const dir = '/tmp/hello-world';
  const project = fakeProject(dir);
  vscode.__mock.reset();
  vscode.__mock.configStore.set('project', '');
  vscode.__mock.configStore.set('system', 'web');
  vscode.__mock.configStore.set('namedSystem', '');
  const provider = registerLauncherView(
    { subscriptions: [] },
    fakeProjects(project, async () => SAMPLE_TARGETS),
  );
  const view = fakeView();
  provider.resolveWebviewView(view);
  await tick();
  await provider.set({ key: 'project', value: dir });
  assert.equal(vscode.__mock.configStore.get('namedSystem'), 'Commodore 64');
  assert.equal(vscode.__mock.configStore.get('system'), 'c64');
  assert.equal(states(view).at(-1).systemTitle, 'Commodore 64');
});

test('set() of a project with no systems keeps a targeted machine, or takes the first', async () => {
  const dir = '/tmp/hello-world';
  const project = fakeProject(dir);
  const none = { get: (id) => SAMPLE_TARGETS.get(id), systems: [] };
  vscode.__mock.reset();
  vscode.__mock.configStore.set('project', dir);
  vscode.__mock.configStore.set('system', 'web');
  vscode.__mock.configStore.set('namedSystem', 'The browser');
  const provider = registerLauncherView(
    { subscriptions: [] },
    fakeProjects(project, async () => none),
  );
  const view = fakeView();
  provider.resolveWebviewView(view);
  await tick();
  await provider.set({ key: 'project', value: dir });
  assert.equal(vscode.__mock.configStore.get('namedSystem'), '');
  assert.equal(vscode.__mock.configStore.get('system'), 'web');

  project.targets = ['c64'];
  vscode.__mock.configStore.set('system', 'web');
  await provider.set({ key: 'project', value: dir });
  assert.equal(vscode.__mock.configStore.get('system'), 'c64');
});

test('set() of an unknown project or key still posts once apply finishes', async () => {
  const dir = '/tmp/hello-world';
  const project = fakeProject(dir);
  vscode.__mock.reset();
  vscode.__mock.configStore.set('project', dir);
  vscode.__mock.configStore.set('system', 'web');
  const provider = registerLauncherView(
    { subscriptions: [] },
    fakeProjects(project, async () => SAMPLE_TARGETS),
  );
  const view = fakeView();
  provider.resolveWebviewView(view);
  await tick();
  const before = states(view).length;
  await provider.set({ key: 'project', value: '/no-such-project' });
  await provider.set({ key: 'region', value: 'pal' });
  assert.ok(states(view).length > before);
});

test('set() swallows posts from projects, config, visibility and the local-extension watcher', async () => {
  const dir = '/tmp/hello-world';
  const project = fakeProject(dir);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered = 0;
  const loadTargets = async () => {
    entered += 1;
    if (entered === 2) await gate;
    return SAMPLE_TARGETS;
  };
  const projects = fakeProjects(project, loadTargets);
  const devReload = fakeDevReload();
  vscode.__mock.reset();
  vscode.__mock.configStore.set('project', dir);
  vscode.__mock.configStore.set('system', 'web');
  vscode.__mock.configStore.set('namedSystem', 'The browser');
  const provider = registerLauncherView({ subscriptions: [] }, projects, devReload);
  const view = fakeView();
  provider.resolveWebviewView(view);
  await tick();
  const applying = provider.set({ key: 'system', value: 'Commodore 64' });
  await tick();
  const during = states(view).length;
  projects.fireChange();
  vscode.__mock.fireConfigChange('8bitscript.system');
  vscode.__mock.fireConfigChange('8bitscript.showExamples');
  view.show();
  devReload.fire();
  await tick();
  assert.equal(states(view).length, during, 'nothing paints while set() still holds suppress');
  release();
  await applying;
  assert.equal(states(view).at(-1).systemTitle, 'Commodore 64');
  const after = states(view).length;
  projects.fireChange();
  vscode.__mock.fireConfigChange('8bitscript.system');
  vscode.__mock.fireConfigChange('8bitscript.showExamples');
  view.show();
  devReload.fire();
  await tick();
  assert.ok(states(view).length > after, 'once set() is done, the same events paint again');
});
