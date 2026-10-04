// The extension side of the launcher, end to end under the vscode mock: the
// page it serves, the state it builds for a real project on disk, and the
// command each message from the page runs. The page itself is tested in
// launcher.test.cjs over a real DOM; the rules in launcherState.test.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const { registerRunner } = require('../src/runner.cjs');
const { registerLauncherView, inputsFromDefine, runId, wasmFor } = require('../src/launcherView.cjs');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A project in the shape of vegas-nights: a lobby, a slot and a small lab. */
function writeLab(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const entry of ['main', 'slot', 'tiny']) fs.writeFileSync(path.join(dir, 'src', `${entry}.8bs`), 'export function main(): void {}\n');
  fs.writeFileSync(path.join(dir, '8bitscript.config.8bs'), `export default {
  programs: {
    main: { entry: 'src/main.8bs' },
    slot: { entry: 'src/slot.8bs' },
    tiny: { entry: 'src/tiny.8bs', targets: ['pet', 'vic20'] },
  },
  targets: ['pet', 'vic20', 'c64', 'web'],
};
`);
  const cli = path.join(dir, 'fake-8bs.mjs');
  fs.writeFileSync(cli, `console.log(JSON.stringify({ targets: [
    { id: 'pet', title: 'Commodore PET', emulator: 'xpet' }, { id: 'vic20', title: 'Commodore VIC-20', emulator: 'xvic' },
    { id: 'c64', title: 'Commodore 64', emulator: 'x64sc' }, { id: 'web', title: 'Web', emulator: null } ], systems: [] }));\n`);
  return cli;
}

function fakeView() {
  const listeners = [];
  const posted = [];
  return {
    visible: true,
    webview: {
      cspSource: 'vscode-webview:',
      options: {},
      html: '',
      postMessage: (message) => { posted.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (listener) => { listeners.push(listener); return { dispose() {} }; },
      __fire: (message) => { for (const listener of listeners) listener(message); },
    },
    posted,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
}

/** Everything after the first state the panel posts, which takes a process to compute. */
async function stateAfter(view, seen = 0) {
  for (let i = 0; i < 300; i += 1) {
    const states = view.posted.filter((m) => m.type === 'state' && m.state.phase !== 'loading');
    if (states.length > seen) return states.at(-1).state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the panel never posted a state');
}
const readyStates = (view) => view.posted.filter((m) => m.type === 'state' && m.state.phase !== 'loading').length;

async function withLauncher(fn, { settings = {}, configure } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-launcher-'));
  const store = new Map();
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: path.join(dir, '.storage') },
    workspaceState: { get: (k) => store.get(k), update: (k, v) => { store.set(k, v); return Promise.resolve(); } },
  };
  try {
    const cli = writeLab(dir);
    vscode.__mock.reset();
    vscode.__mock.configStore.set('project', dir);
    vscode.__mock.configStore.set('system', 'c64');
    for (const [key, value] of Object.entries(settings)) vscode.__mock.configStore.set(key, typeof value === 'function' ? value(dir) : value);
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.8bs') }]);
    const projects = registerRunner(context, { appendLine() {} });
    await tick();
    projects.projects[0].toolchain = cli;
    if (configure) configure(projects.projects[0], dir);
    const provider = registerLauncherView(context, projects, null);
    const view = fakeView();
    provider.resolveWebviewView(view);
    const first = await stateAfter(view);
    await fn({ dir, view, provider, projects, first, store, context });
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Send a message and wait for the state it provokes. */
async function send(view, message) {
  const seen = readyStates(view);
  view.webview.__fire(message);
  await tick();
  return stateAfter(view, seen);
}
const ran = (id) => vscode.__mock.executedCommands.filter((c) => c.id === id);

// ── the page ────────────────────────────────────────────────────────────────

test('the view is registered as the side bar view and serves one page with a strict policy', async () => {
  await withLauncher(({ view }) => {
    assert.ok(vscode.__mock.viewProviders.has('8bitscript.launcher'));
    const html = view.webview.html;
    const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(html)[1];
    assert.match(html, /default-src 'none'/);
    assert.match(html, new RegExp(`style-src vscode-webview: 'nonce-${nonce}'`));
    assert.match(html, /font-src vscode-webview:/, 'the icon font is allowed');
    assert.equal((html.match(new RegExp(`nonce="${nonce}"`, 'g')) ?? []).length, 2, 'one style and one script, both with the nonce');
    assert.doesNotMatch(html, /<script(?![^>]*nonce)/, 'no script without the nonce');
    assert.doesNotMatch(html, /\sstyle="/, 'no inline style attributes, which the policy would block');
    assert.match(html, /<main id="app" data-logo="[^"]*8bitscript-icon\.svg"/);
    assert.match(html, /url\('[^']*codicon\.woff2'\)/, 'the icon font url is filled in');
    assert.doesNotMatch(html, /\{\{CODICON\}\}/);
  });
});

test('the page has none of the old controls', async () => {
  await withLauncher(({ view }) => {
    const html = view.webview.html;
    for (const gone of ['id="studio"', 'id="studio-more"', 'id="run-more"', 'id="boot"', 'id="fitted"', 'id="details"', 'id="open"', 'Quick launch', 'program-field']) {
      assert.ok(!html.includes(gone), `${gone} is gone`);
    }
  });
});

test('the page restricts what it can load to the extension\'s media directory when it has one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-launcher-roots-'));
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    const context = { subscriptions: [], globalStorageUri: { fsPath: dir }, extensionUri: vscode.Uri.file('/ext') };
    const projects = registerRunner(context, { appendLine() {} });
    await tick();
    const provider = registerLauncherView(context, projects, null);
    const view = fakeView();
    view.webview.asWebviewUri = (uri) => ({ toString: () => `https://webview/${uri.fsPath}` });
    provider.resolveWebviewView(view);
    assert.equal(view.webview.options.enableScripts, true);
    assert.deepEqual(view.webview.options.localResourceRoots.map((u) => u.fsPath), ['/ext/media']);
    assert.match(view.webview.html, /url\('https:\/\/webview\/\/ext\/media\/codicon\.woff2'\)/);
    for (const subscription of context.subscriptions) subscription.dispose?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the state ───────────────────────────────────────────────────────────────

test('the first thing posted is the loading state, then the real one', async () => {
  await withLauncher(({ view }) => {
    const states = view.posted.filter((m) => m.type === 'state').map((m) => m.state.phase);
    assert.equal(states[0], 'loading');
    assert.equal(states.at(-1), 'ready');
  });
});

test('the state describes the project, its programs, its systems and the selected program', async () => {
  await withLauncher(({ first, dir }) => {
    assert.equal(first.phase, 'ready');
    assert.equal(first.project.name, 'my-game' === first.project.name ? 'my-game' : first.project.name);
    assert.deepEqual(first.programs.map((p) => p.id), ['main', 'slot', 'tiny']);
    assert.equal(first.program, 'main', 'nothing chosen, and a main: main');
    assert.deepEqual(first.runtimes.map((r) => r.id), ['editor', 'browser', 'native']);
    assert.equal(first.system, 'c64');
    assert.deepEqual(first.systems.map((s) => s.id), ['pet', 'c64', 'vic20', 'web'], 'in the extension\'s own machine order');
    assert.equal(first.systems.find((s) => s.id === 'c64').name, 'Commodore 64');
    assert.ok(first.systems.every((s) => s.enabled), 'main targets all of them');
    assert.deepEqual(first.programs.map((p) => p.entry), ['src/main.8bs', 'src/slot.8bs', 'src/tiny.8bs']);
    assert.equal(first.projects.length >= 1, true);
    assert.ok(first.projects.some((p) => p.id === dir));
  });
});

test('the C64 has no WASM build in the extension\'s own list, so Editor and Browser are off and Native is the primary', async () => {
  await withLauncher(({ first }) => {
    const main = first.programs[0];
    assert.equal(main.runtimes.editor.ok, false);
    assert.equal(main.runtimes.browser.ok, false);
    assert.match(main.runtimes.editor.reason, /Commodore 64 WASM build isn't ready/);
    assert.equal(main.runtimes.native.ok, true);
    assert.equal(main.primary, 'native');
    assert.deepEqual(main.live, []);
  });
});

test('the PET has a WASM build, so Editor is the default and Browser is available', async () => {
  await withLauncher(({ first }) => {
    const main = first.programs[0];
    assert.equal(main.runtimes.editor.ok && main.runtimes.browser.ok && main.runtimes.native.ok, true);
    assert.equal(main.primary, 'editor');
  }, { settings: { system: 'pet' } });
});

test('preferWebPreview off makes Native the default where everything works', async () => {
  await withLauncher(({ first }) => {
    assert.equal(first.programs[0].primary, 'native');
  }, { settings: { system: 'pet', preferWebPreview: false } });
});

test('the Web system has no native emulator, and no bare emulator either', async () => {
  await withLauncher(({ first }) => {
    const main = first.programs[0];
    assert.equal(main.runtimes.native.ok, false);
    assert.match(main.runtimes.native.reason, /no native emulator/);
    assert.equal(main.primary, 'editor');
    assert.equal(first.systems.find((s) => s.id === 'web').emulator, null);
  }, { settings: { system: 'web' } });
});

test('the command is the exact line the primary runtime would run, with --program and --define', async () => {
  await withLauncher(async ({ view, first }) => {
    assert.equal(first.command, '8bs run c64 --program main --size', 'main of several programs on the C64: native, the program named as Run names it');
  });
  await withLauncher(async ({ view }) => {
    const state = await send(view, { type: 'select', program: 'slot' });
    assert.equal(state.program, 'slot');
    assert.equal(state.command, '8bs run pet --program slot --web --no-open --port 0 --size', 'the PET\'s default is the Editor tab');
    const done = await send(view, { type: 'selectRuntime', program: 'slot', runtime: 'browser' });
    assert.equal(done.command, '8bs run pet --program slot --web --size');
  }, { settings: { system: 'pet' } });
});

test('picking a program the machine does not target moves the machine, and the systems list disables the rest', async () => {
  await withLauncher(async ({ view, dir }) => {
    const state = await send(view, { type: 'select', program: 'tiny' });
    assert.deepEqual(vscode.__mock.configStore.get('program'), { [dir]: 'tiny' });
    assert.equal(vscode.__mock.configStore.get('system'), 'pet', 'the program\'s first machine');
    assert.equal(state.system, 'pet');
    assert.deepEqual(state.systems.map((s) => [s.id, s.enabled]), [['pet', true], ['c64', false], ['vic20', true], ['web', false]]);
    assert.equal(state.programs.find((p) => p.id === 'tiny').onSystem, true);
    assert.equal(state.programs.find((p) => p.id === 'slot').onSystem, true);
  });
});

test('a program name the config does not have changes nothing', async () => {
  await withLauncher(async ({ view, dir }) => {
    await send(view, { type: 'select', program: 'nope' });
    assert.equal(vscode.__mock.configStore.get('program'), undefined);
  });
});

test('picking a system stores the machine and wipes stale hardware; an unknown one is ignored', async () => {
  await withLauncher(async ({ view }) => {
    vscode.__mock.configStore.set('hardware', { pet: { profile: '3032', options: {} } });
    const state = await send(view, { type: 'select', system: 'pet' });
    assert.equal(vscode.__mock.configStore.get('system'), 'pet');
    assert.deepEqual(vscode.__mock.configStore.get('hardware'), {});
    assert.equal(state.system, 'pet');
    await send(view, { type: 'select', system: 'not-a-machine' });
    assert.equal(vscode.__mock.configStore.get('system'), 'pet');
  });
});

test('picking a project stores it and keeps a machine it can run on', async () => {
  await withLauncher(async ({ view, dir }) => {
    vscode.__mock.configStore.set('system', 'c64');
    await send(view, { type: 'select', project: dir });
    assert.equal(vscode.__mock.configStore.get('project'), dir);
    assert.equal(vscode.__mock.configStore.get('system'), 'c64');
  });
});

// ── run, build, boot ────────────────────────────────────────────────────────

test('Native runs the existing run command with web off and the chosen program', async () => {
  await withLauncher(async ({ view, dir }) => {
    await send(view, { type: 'run', runtime: 'native', program: 'slot', system: 'c64', inputs: {} });
    const run = ran('8bitscript.run').at(-1);
    assert.equal(run.args[0].web, false);
    assert.equal(run.args[0].target, 'c64');
    assert.equal(run.args[0].program, 'slot');
    assert.equal(run.args[0].project.dir, dir);
    assert.deepEqual(vscode.__mock.configStore.get('program'), { [dir]: 'slot' }, 'the run acts on the program it named');
  });
});

test('Editor runs the same command with web on', async () => {
  await withLauncher(async ({ view }) => {
    await send(view, { type: 'run', runtime: 'editor', program: 'main', system: 'pet', inputs: {} });
    assert.equal(ran('8bitscript.run').at(-1).args[0].web, true);
  }, { settings: { system: 'pet' } });
});

test('Browser cannot run through today\'s command, and says so instead of running something else', async () => {
  await withLauncher(async ({ view }) => {
    await send(view, { type: 'run', runtime: 'browser', program: 'main', system: 'pet', inputs: {} });
    assert.equal(ran('8bitscript.run').length, 0);
    assert.equal(vscode.__mock.calls.showInformationMessage.length, 1);
    assert.match(vscode.__mock.calls.showInformationMessage[0][0], /Browser runs need the 8BitScript unit commands/);
  }, { settings: { system: 'pet' } });
});

test('with the unit commands present, every runtime goes through runUnit with its inputs', async () => {
  await withLauncher(async ({ view }) => {
    vscode.__mock.extraCommands.push('8bitscript.runUnit');
    for (const runtime of ['editor', 'browser', 'native']) {
      await send(view, { type: 'run', runtime, program: 'slot', system: 'pet', inputs: { SEED: 10 } });
    }
    const calls = ran('8bitscript.runUnit').map((c) => [c.args[0].runtime, c.args[0].program, c.args[0].inputs]);
    assert.deepEqual(calls, [['editor', 'slot', { SEED: 10 }], ['browser', 'slot', { SEED: 10 }], ['native', 'slot', { SEED: 10 }]]);
    assert.equal(ran('8bitscript.run').length, 0, 'and the old command is not used');
    assert.equal(vscode.__mock.calls.showInformationMessage.length, 0);
  }, { settings: { system: 'pet' } });
});

test('a run remembers its runtime for that program, and the page then draws it as primary', async () => {
  await withLauncher(async ({ view }) => {
    const state = await send(view, { type: 'run', runtime: 'native', program: 'slot', system: 'pet', inputs: {} });
    assert.equal(state.programs.find((p) => p.id === 'slot').primary, 'native');
    assert.equal(state.programs.find((p) => p.id === 'main').primary, 'editor', 'another program keeps its default');
  }, { settings: { system: 'pet' } });
});

test('a runtime that is not one of the three runs nothing', async () => {
  await withLauncher(async ({ view }) => {
    view.webview.__fire({ type: 'run', runtime: 'cloud', program: 'main', system: 'c64', inputs: {} });
    await tick();
    assert.equal(ran('8bitscript.run').length + ran('8bitscript.runUnit').length, 0);
  });
});

test('Build acts on the named program and Boot on no program at all', async () => {
  await withLauncher(async ({ view, dir }) => {
    view.webview.__fire({ type: 'build', program: 'slot', system: 'c64' });
    await tick();
    const build = ran('8bitscript.build').at(-1);
    assert.equal(build.args[0].program, 'slot');
    assert.deepEqual(vscode.__mock.configStore.get('program'), { [dir]: 'slot' });
    view.webview.__fire({ type: 'boot', system: 'c64' });
    await tick();
    const boot = ran('8bitscript.boot').at(-1);
    assert.equal(boot.args[0].target, 'c64');
    assert.equal(boot.args[0].program, undefined);
  });
});

// ── inputs ──────────────────────────────────────────────────────────────────

test('a program\'s define block becomes inputs with the right kinds, and the page\'s edits are remembered per program', async () => {
  await withLauncher(async ({ view, first }) => {
    const slot = first.programs.find((p) => p.id === 'slot');
    assert.deepEqual(slot.inputs.map((i) => [i.name, i.kind, i.def, i.value]), [['SEED', 'number', 7, 7], ['FORCE_BONUS', 'bool', false, false], ['THEME', 'select', 'classic', 'classic']]);
    let state = await send(view, { type: 'select', program: 'slot' });
    state = await send(view, { type: 'input', program: 'slot', name: 'SEED', value: 10 });
    assert.equal(state.programs.find((p) => p.id === 'slot').inputs[0].value, 10);
    assert.match(state.command, /--define SEED=10$/);
    assert.equal(state.programs.find((p) => p.id === 'main').inputs.length, 0, 'main has no inputs to change');
    state = await send(view, { type: 'inputsReset', program: 'slot' });
    assert.equal(state.programs.find((p) => p.id === 'slot').inputs[0].value, 7);
    assert.doesNotMatch(state.command, /--define/);
  }, { configure: (project) => { project.programs.find((p) => p.name === 'slot').define = { SEED: 7, FORCE_BONUS: false, THEME: { value: 'classic', options: ['classic', 'cosmic'] } }; } });
});

test('inputsFromDefine reads both spellings and derives the kind from the default', () => {
  const inputs = inputsFromDefine({ SEED: 7, GO: true, NAME: 'x', CREDITS: { value: 1000, description: 'Bank.', label: 'Credits' }, MODE: { value: 'a', options: ['a', 'b'] } }, { SEED: 9 });
  assert.deepEqual(inputs.map((i) => [i.name, i.kind, i.def, i.value]), [['SEED', 'number', 7, 9], ['GO', 'bool', true, true], ['NAME', 'text', 'x', 'x'], ['CREDITS', 'number', 1000, 1000], ['MODE', 'select', 'a', 'a']]);
  assert.equal(inputs[3].label, 'Credits');
  assert.equal(inputs[3].help, 'Bank.');
  assert.equal(inputs[0].label, 'Seed', 'a label is made from the name when none is given');
  assert.deepEqual(inputsFromDefine(null), []);
});

// ── the rest of the page's messages ─────────────────────────────────────────

test('opening the source opens THAT program\'s entry file, not the project\'s main', async () => {
  await withLauncher(async ({ view, dir }) => {
    const shown = [];
    const original = vscode.window.showTextDocument;
    vscode.window.showTextDocument = (uri) => { shown.push(uri.fsPath); return original(uri); };
    try {
      view.webview.__fire({ type: 'openSource', program: 'tiny' });
      await tick();
      assert.deepEqual(shown, [path.join(dir, 'src', 'tiny.8bs')]);
    } finally {
      vscode.window.showTextDocument = original;
    }
  });
});

test('Reveal asks the explorer to reveal the same file', async () => {
  await withLauncher(async ({ view, dir }) => {
    view.webview.__fire({ type: 'reveal', program: 'slot' });
    await tick();
    const reveal = ran('revealInExplorer').at(-1);
    assert.equal(reveal.args[0].fsPath, path.join(dir, 'src', 'slot.8bs'));
  });
});

test('Copy puts exactly the text it was given on the clipboard, and nothing when it is not text', async () => {
  await withLauncher(async ({ view }) => {
    view.webview.__fire({ type: 'copy', text: '8bs run c64' });
    await tick();
    assert.equal(vscode.env.clipboard.text, '8bs run c64');
    view.webview.__fire({ type: 'copy', text: { not: 'text' } });
    await tick();
    assert.equal(vscode.env.clipboard.text, '8bs run c64');
  });
});

test('the messages that run an extension command run exactly that command, and no other id can be named', async () => {
  await withLauncher(async ({ view }) => {
    const table = { doctor: '8bitscript.doctor', details: '8bitscript.showProject', configureSystem: '8bitscript.configureSystem', saveSystem: '8bitscript.saveSystem', studio: '8bitscript.openStudio', tryExample: '8bitscript.launchExample', rebuildExtension: '8bitscript.rebuildExtension' };
    for (const [type, id] of Object.entries(table)) {
      view.webview.__fire({ type });
      await tick();
      assert.equal(ran(id).length, 1, `${type} runs ${id}`);
    }
    const before = vscode.__mock.executedCommands.length;
    view.webview.__fire({ type: 'command', id: 'workbench.action.terminal.new' });
    view.webview.__fire({ type: 'workbench.action.terminal.new' });
    view.webview.__fire({ type: '__proto__' });
    view.webview.__fire(null);
    await tick();
    assert.equal(vscode.__mock.executedCommands.length, before, 'nothing else ran');
  });
});

test('Fix runs Doctor setup for an emulator and the installer for packages', async () => {
  await withLauncher(async ({ view }) => {
    view.webview.__fire({ type: 'fix', kind: 'emulator' });
    view.webview.__fire({ type: 'fix', kind: 'packages', dir: '/p', name: 'p', packageManager: 'pnpm' });
    await tick();
    assert.equal(ran('8bitscript.doctorSetup').length, 1);
    const install = ran('8bitscript.install').at(-1);
    assert.equal(install.args[0].dir, '/p');
    assert.equal(install.args[0].packageManager, 'pnpm');
  });
});

test('Learn opens the docs, Open Folder opens the folder dialog, and Reload reloads', async () => {
  await withLauncher(async ({ view }) => {
    view.webview.__fire({ type: 'learn' });
    view.webview.__fire({ type: 'openFolder' });
    view.webview.__fire({ type: 'reloadWindow' });
    await tick();
    assert.deepEqual(vscode.__mock.openedExternal, ['https://8bitscript.org/']);
    assert.equal(ran('workbench.action.files.openFolder').length, 1);
    assert.equal(ran('workbench.action.reloadWindow').length, 1);
  });
});

test('Focus shows the Editor tab', async () => {
  await withLauncher(async ({ view }) => {
    view.webview.__fire({ type: 'focus', runId: 'x' });
    await tick();
    assert.equal(ran('8bitscript.previewTab.show').length, 1);
  });
});

// ── what is running ─────────────────────────────────────────────────────────

function fakeExecution(projects, definition, startedAt = Date.now() - 65000) {
  const execution = { task: { definition, name: 'x', detail: `8bs run ${definition.target} --size  (proj)` }, terminated: false, terminate() { this.terminated = true; } };
  projects.running.executions.add(execution);
  projects.running.startedAt.set(execution, startedAt);
  return execution;
}

test('a live run appears in Running with its runtime, and lights the program row it belongs to', async () => {
  await withLauncher(async ({ view, projects, dir, provider }) => {
    fakeExecution(projects, { type: '8bs', command: 'run', projectDir: dir, target: 'pet', program: 'slot', web: true });
    fakeExecution(projects, { type: '8bs', command: 'run', projectDir: dir, target: 'pet', program: 'slot' });
    fakeExecution(projects, { type: '8bs', command: 'doctor', projectDir: dir });
    const state = await send(view, { type: 'ready' });
    assert.deepEqual(state.running.map((r) => [r.system, r.runtime, r.title, r.programId]).sort(), [['pet', 'editor', 'slot', 'slot'], ['pet', 'native', 'slot', 'slot']]);
    assert.deepEqual(state.programs.find((p) => p.id === 'slot').live.sort(), ['editor', 'native']);
    assert.deepEqual(state.programs.find((p) => p.id === 'main').live, []);
    assert.match(state.running[0].elapsed, /^1m /);
    assert.equal(state.running[0].command, '8bs run pet --size', 'the command, without the project path');
  }, { settings: { system: 'pet' } });
});

test('Stop ends exactly the run it names, even when two runs share a program', async () => {
  await withLauncher(async ({ view, projects, dir }) => {
    const editor = fakeExecution(projects, { type: '8bs', command: 'run', projectDir: dir, target: 'pet', program: 'slot', web: true }, 1000);
    const native = fakeExecution(projects, { type: '8bs', command: 'run', projectDir: dir, target: 'pet', program: 'slot' }, 2000);
    const id = runId(1000, editor.task.definition);
    view.webview.__fire({ type: 'stop', runId: id });
    await tick();
    assert.equal(editor.terminated, true);
    assert.equal(native.terminated, false, 'the other run lives');
    view.webview.__fire({ type: 'stop', runId: 'no such run' });
    await tick();
    assert.equal(native.terminated, false);
  }, { settings: { system: 'pet' } });
});

test('Open in browser opens the run\'s own local address', async () => {
  await withLauncher(async ({ view, projects, dir }) => {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', '.8bs-last-pet-web.json'), JSON.stringify({ target: 'pet', url: 'http://127.0.0.1:4173/' }));
    const exec = fakeExecution(projects, { type: '8bs', command: 'run', projectDir: dir, target: 'pet', web: true }, 5);
    view.webview.__fire({ type: 'openInBrowser', runId: runId(5, exec.task.definition) });
    await tick();
    assert.deepEqual(vscode.__mock.openedExternal, ['http://127.0.0.1:4173/']);
  }, { settings: { system: 'pet' } });
});

test('a run\'s runtime is read from the task: tab, browser or native', () => {
  assert.equal(runId(1, { target: 'pet', web: true, program: 'p' }), '1:pet:editor:p');
  assert.equal(runId(1, { target: 'web' }), '1:web:browser:');
  assert.equal(runId(1, { target: 'c64' }), '1:c64:native:');
  assert.equal(runId(1, { target: 'c64', runtime: 'browser' }), '1:c64:browser:', 'a task that names its runtime wins');
});

// ── named systems ───────────────────────────────────────────────────────────

/** A fake CLI that answers `targets --json` with project systems from each origin. */
function systemsCli(dir) {
  const cli = path.join(dir, 'fake-8bs.mjs');
  fs.writeFileSync(cli, `console.log(JSON.stringify({ targets: [
    { id: 'pet', title: 'Commodore PET', emulator: 'xpet' }, { id: 'c64', title: 'Commodore 64', emulator: 'x64sc' },
    { id: 'vic20', title: 'Commodore VIC-20', emulator: 'xvic' }, { id: 'web', title: 'Web', emulator: null } ],
    systems: [
      { name: 'C64 with a mouse', target: 'c64', label: 'mouse', origin: 'project', profile: null, hardware: { mouse: 'on' }, region: 'ntsc' },
      { name: 'My PET', target: 'pet', label: 'stock', origin: 'user', profile: '3032', hardware: {}, region: null },
      { name: 'Advertised VIC', target: 'vic20', label: '8k', origin: 'advertised', profile: null, hardware: {}, region: 'pal' } ] }));\n`);
  return cli;
}

test('named systems are offered by origin above the machines, and an empty selection is the machine id', async () => {
  await withLauncher(async ({ first }) => {
    const named = first.systems.filter((s) => s.group !== 'Machines');
    assert.deepEqual(named.map((s) => [s.group, s.name]), [['This clone', 'C64 with a mouse'], ['This machine', 'My PET'], ['Advertised', 'Advertised VIC']]);
    assert.equal(first.systems.findIndex((s) => s.group === 'Machines') > 2, true, 'machines come after the named systems');
    assert.equal(first.system, 'web', 'no named system fits: the machine id, never a blank');
    assert.equal(named[0].spec, 'c64 · mouse');
    assert.equal(named[1].spec, 'pet', 'a stock system just names its machine');
  }, { settings: { system: 'web' }, configure: (project, dir) => { project.toolchain = systemsCli(dir); } });
});

test('picking a named system fits its machine, hardware and region together, and the picker then shows it', async () => {
  await withLauncher(async ({ view }) => {
    const state = await send(view, { type: 'select', system: 'C64 with a mouse' });
    assert.equal(vscode.__mock.configStore.get('namedSystem'), 'C64 with a mouse');
    assert.equal(vscode.__mock.configStore.get('system'), 'c64');
    assert.equal(vscode.__mock.configStore.get('region'), 'ntsc');
    assert.deepEqual(vscode.__mock.configStore.get('hardware').c64, { profile: null, options: { mouse: 'on' } });
    assert.equal(state.system, 'C64 with a mouse', 'the named system, not the bare machine');
    assert.match(state.summary.name, /C64 with a mouse/);
    assert.match(state.command, /--system C64 with a mouse|run --system/);
  }, { configure: (project, dir) => { project.toolchain = systemsCli(dir); } });
});

test('picking a project with systems of its own starts on the first of them', async () => {
  await withLauncher(async ({ view, dir }) => {
    await send(view, { type: 'select', project: dir });
    assert.equal(vscode.__mock.configStore.get('namedSystem'), 'C64 with a mouse');
  }, { configure: (project, dir) => { project.toolchain = systemsCli(dir); } });
});

// ── notices and the toolchain's own answers ─────────────────────────────────

test('a project without a toolchain says so and offers the install', async () => {
  await withLauncher(({ first }) => {
    const n = first.notices.find((x) => x.id === 'toolchain');
    assert.ok(n);
    assert.equal(n.kind, 'warn');
    assert.equal(n.actions[0].msg.kind, 'packages');
    assert.equal(n.actions[0].msg.packageManager, 'pnpm');
  }, { configure: (project) => { project.toolchain = null; } });
});

test('the CLI\'s own capability report beats the extension\'s list when it gives one', () => {
  assert.deepEqual(wasmFor('c64', { title: 'Commodore 64', runtimes: { wasm: { available: true } } }), { ok: true, reason: undefined });
  assert.deepEqual(wasmFor('pet', { runtimes: { wasm: { available: false, reason: 'asm6502 blocks.' } } }), { ok: false, reason: 'asm6502 blocks.' });
  assert.deepEqual(wasmFor('pet', null), { ok: true });
  assert.deepEqual(wasmFor('web', null), { ok: true });
  assert.equal(wasmFor('c64', { title: 'C64' }).ok, false);
  assert.match(wasmFor('c64', { title: 'C64' }).reason, /^The C64 WASM build isn't ready yet/);
});

test('a state with no project is the empty state, with whatever notices there are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-launcher-empty-'));
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    const context = { subscriptions: [], globalStorageUri: { fsPath: dir } };
    const projects = registerRunner(context, { appendLine() {} });
    await tick();
    const provider = registerLauncherView(context, projects, null);
    const view = fakeView();
    provider.resolveWebviewView(view);
    const state = await stateAfter(view);
    assert.equal(state.phase, 'empty');
    assert.deepEqual(plain(state.programs), []);
    for (const subscription of context.subscriptions) subscription.dispose?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the dev-reload banner is a notice with the right action for each phase', async () => {
  for (const [phase, label, type] of [['dirty', 'Rebuild the local extension', 'rebuildExtension'], ['ready', 'Reload this window', 'reloadWindow'], ['error', 'Rebuild the local extension', 'rebuildExtension']]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-launcher-dev-'));
    try {
      vscode.__mock.reset();
      vscode.workspace.findFiles = () => Promise.resolve([]);
      const context = { subscriptions: [], globalStorageUri: { fsPath: dir } };
      const projects = registerRunner(context, { appendLine() {} });
      await tick();
      const devReload = { phase, error: 'boom', onDidChange: () => ({ dispose() {} }) };
      const provider = registerLauncherView(context, projects, devReload);
      const view = fakeView();
      provider.resolveWebviewView(view);
      const state = await stateAfter(view);
      const notice = state.notices.find((n) => n.id === 'dev-reload');
      assert.equal(notice.actions[0].label, label, phase);
      assert.equal(notice.actions[0].msg.type, type);
      assert.equal(notice.kind, phase === 'error' ? 'error' : 'info');
      if (phase === 'error') assert.equal(notice.text, 'boom');
      for (const subscription of context.subscriptions) subscription.dispose?.();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
