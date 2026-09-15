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
  return {
    all: [project],
    visible: [project],
    projects: [project],
    managedDir: null,
    running: { list: () => [] },
    live: new Map(),
    checkoutFlag: () => null,
    onDidChange: () => ({ dispose() {} }),
    refresh() {},
    loadTargets,
  };
}

function fakeView() {
  const posted = [];
  const listeners = [];
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
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
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
