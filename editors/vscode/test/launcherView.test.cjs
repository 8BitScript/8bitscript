// The side bar's Studio button, end to end under the mock: the page
// script posts the one command id, the view's allow-list passes it to
// vscode.commands, and nothing else on the page can name a command the
// view did not list. launcher.test.cjs reads the same sources as text;
// this runs them — media/launcher.js in a vm context (so coverage lands
// on the file) and LauncherViewProvider against a fake view.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installVscodeMock } = require('./support/vscodeMock.cjs');
const { runWebviewScripts } = require('./support/runWebview.cjs');

const vscode = installVscodeMock();
const { registerRunner } = require('../src/runner.cjs');
const { registerLauncherView } = require('../src/launcherView.cjs');

const ROOT = path.join(__dirname, '..');
const LAUNCHER_JS = path.join(ROOT, 'media', 'launcher.js');

// Objects made inside the vm context have that realm's Object prototype,
// which deepEqual counts; JSON round-trips them into this one.
const plain = (value) => JSON.parse(JSON.stringify(value));

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function emitter() {
  const listeners = [];
  return {
    event: (listener) => { listeners.push(listener); return { dispose() {} }; },
    fire: (value) => { for (const listener of listeners) listener(value); },
  };
}

/** A webview view the way VS Code hands one to resolveWebviewView(). */
function fakeView() {
  const messages = emitter();
  const posted = [];
  return {
    visible: true,
    webview: {
      cspSource: 'vscode-webview:',
      options: {},
      html: '',
      postMessage: (message) => { posted.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: messages.event,
      __fire: (message) => messages.fire(message),
    },
    posted,
    onDidChangeVisibility: emitter().event,
    onDidDispose: emitter().event,
  };
}

test('the page runs: the inline script defines the stop icon, and the Studio button posts its command', () => {
  // The page's own <script> defines ICON_STOP before launcher.js loads;
  // a one-line stand-in for it, in a real file so the vm has a filename.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-launcher-page-'));
  const inline = path.join(dir, 'inline.js');
  fs.writeFileSync(inline, "const ICON_STOP = '<svg></svg>';\n");
  try {
    const { dom, sandbox, posted } = runWebviewScripts([inline, LAUNCHER_JS]);
    assert.deepEqual(plain(posted), [{ type: 'ready' }], 'the page announces itself and nothing else on load');
    dom.getElementById('studio').dispatch('click');
    assert.deepEqual(plain(posted.at(-1)), { type: 'command', id: '8bitscript.openStudio' });
    // The sliver opens the menu; an item launches Studio there; a click
    // anywhere else, or Escape, closes it.
    sandbox.window.dispatch('message', { data: { type: 'state', packages: [], projects: [], project: '', projectLabel: '', installed: true, packageManager: 'pnpm', systems: [], system: 'c64', systemTitle: 'c64', region: 'ntsc', regionLabel: '', machine: true, bootable: true, runnable: false, warning: null, fitted: '', subtitle: '', running: [], hint: '',
      studio: { systems: [{ group: 'In an editor tab' }, { id: 'tab', command: '8bitscript.openStudioTab', label: 'Commander X16', where: 'x16emu in the editor', machine: true, runnable: true }, { group: 'Advertised' }, { id: 'C64 with a mouse', label: 'C64 with a mouse', where: 'c64 · mouse', machine: true, runnable: true }, { group: 'Machines' }, { id: 'pet', label: 'pet — Commodore PET', machine: true, runnable: true }] } } });
    const menu = dom.getElementById('studio-menu');
    assert.equal(menu.hidden, true, 'closed until the sliver is clicked');
    dom.getElementById('studio-more').dispatch('click');
    assert.equal(menu.hidden, false);
    assert.equal(dom.getElementById('studio-more').getAttribute('aria-expanded'), 'true');
    const items = menu.children.filter((el) => el.className === 'menu-item');
    assert.deepEqual(items.map((el) => el.dataset.id), ['tab', 'C64 with a mouse', 'pet']);
    assert.deepEqual(menu.children.filter((el) => el.className === 'menu-group').map((el) => el.textContent), ['In an editor tab', 'Advertised', 'Machines']);
    assert.equal(items[0].textContent, 'Commander X16  —  x16emu in the editor');
    items[0].dispatch('click');
    assert.deepEqual(plain(posted.at(-1)), { type: 'command', id: '8bitscript.openStudioTab', system: 'tab' }, 'the tab entry runs its own command');
    dom.getElementById('studio-more').dispatch('click');
    items[1].dispatch('click');
    assert.deepEqual(plain(posted.at(-1)), { type: 'command', id: '8bitscript.openStudio', system: 'C64 with a mouse' });
    assert.equal(menu.hidden, true, 'a pick closes the menu');
    dom.getElementById('studio-more').dispatch('click');
    sandbox.window.dispatch('click', {});
    assert.equal(menu.hidden, true, 'a click elsewhere closes it');
    dom.getElementById('studio-more').dispatch('click');
    sandbox.window.dispatch('keydown', { key: 'Escape' });
    assert.equal(menu.hidden, true, 'so does Escape');
    // The buttons beside it still say what they always said.
    dom.getElementById('run').dispatch('click');
    assert.deepEqual(plain(posted.at(-1)), { type: 'launch', action: 'run' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the view draws the Studio block and lets the page run openStudio, and only the ids it lists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-launcher-view-'));
  const context = { subscriptions: [], globalStorageUri: { fsPath: path.join(dir, '.storage') } };
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    const projects = registerRunner(context, { appendLine() {} });
    await tick();
    const provider = registerLauncherView(context, projects, null);
    assert.ok(vscode.__mock.viewProviders.has('8bitscript.launcher'), 'registered as the side bar view');

    const view = fakeView();
    provider.resolveWebviewView(view);
    await tick();
    const html = view.webview.html;
    assert.match(html, /<section class="studio-block">/);
    assert.match(html, /class="launch studio" id="studio"/);
    assert.match(html, /Open Studio/);
    assert.ok(html.indexOf('id="studio"') < html.indexOf('for="project"'), 'Studio sits above the quick launch fields');
    assert.match(html, /<svg viewBox="0 0 16 16" width="20" height="20"[^>]*><path fill="currentColor" d="M1\.5 2h13/, 'with its own, larger icon');
    assert.match(html, /id="studio-more"/, 'and the sliver that opens the menu of its systems');
    // The state the page was sent says Studio is not installed here.
    const state = view.posted.find((m) => m.type === 'state');
    assert.equal(state.studio, null, 'no Studio app in an empty workspace');

    // What the page posts, the view runs — through the allow-list.
    view.webview.__fire({ type: 'command', id: '8bitscript.openStudio' });
    await tick();
    const ran = vscode.__mock.executedCommands.filter((c) => c.id === '8bitscript.openStudio');
    assert.equal(ran.length, 1, 'openStudio reached vscode.commands once');
    // A menu pick carries the system through to the command.
    view.webview.__fire({ type: 'command', id: '8bitscript.openStudio', system: 'C64 with a mouse' });
    await tick();
    const picked = vscode.__mock.executedCommands.filter((c) => c.id === '8bitscript.openStudio').at(-1);
    assert.equal(picked.args[0].system, 'C64 with a mouse');
    // The tab entry's command is on the list too.
    view.webview.__fire({ type: 'command', id: '8bitscript.openStudioTab', system: 'tab' });
    await tick();
    assert.equal(vscode.__mock.executedCommands.filter((c) => c.id === '8bitscript.openStudioTab').length, 1);

    // An id the view does not list runs nothing, whatever the page says.
    const before = vscode.__mock.executedCommands.length;
    view.webview.__fire({ type: 'command', id: 'workbench.action.terminal.new' });
    await tick();
    assert.equal(vscode.__mock.executedCommands.length, before);
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const { warningFor, emulatorIsReady } = require('../src/launcherView.cjs');

test('warningFor greys Run when the emulator is missing, and names it', () => {
  const project = { name: 'game', targets: ['atari8', 'cx16'], toolchain: '/bin/8bs', packageManager: 'pnpm' };
  assert.equal(warningFor(project, 'atari8'), null);
  assert.equal(
    warningFor(project, 'atari8', { doctor: { notInstalled: ['atari8'], failed: [] }, emulator: 'atari800' }),
    'atari800 is not installed. Run 8bs doctor.',
  );
  assert.equal(
    warningFor(project, 'cx16', { doctor: { notInstalled: [], failed: ['cx16'] }, emulator: 'x16emu' }),
    'x16emu is installed but cannot boot. Run 8bs doctor.',
  );
  assert.equal(emulatorIsReady({ notInstalled: ['atari8'], failed: [] }, 'atari8'), false);
  assert.equal(emulatorIsReady({ notInstalled: ['atari8'], failed: [] }, 'pet'), true);
  assert.equal(emulatorIsReady(null, 'atari8'), true, 'no report yet: do not grey on a guess');
});
