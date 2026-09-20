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
    const { dom, posted } = runWebviewScripts([inline, LAUNCHER_JS]);
    assert.deepEqual(plain(posted), [{ type: 'ready' }], 'the page announces itself and nothing else on load');
    dom.getElementById('studio').dispatch('click');
    assert.deepEqual(plain(posted.at(-1)), { type: 'command', id: '8bitscript.openStudio' });
    dom.getElementById('studio-system').dispatch('change', { target: { value: 'C64 with a mouse' } });
    assert.deepEqual(plain(posted.at(-1)), { type: 'set', key: 'studioSystem', value: 'C64 with a mouse' });
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
    assert.match(html, /<select id="studio-system"/, 'and the dropdown of its systems');
    // The state the page was sent says Studio is not installed here.
    const state = view.posted.find((m) => m.type === 'state');
    assert.equal(state.studio, null, 'no Studio app in an empty workspace');

    // The dropdown's pick is a setting, like every choice on the panel.
    view.webview.__fire({ type: 'set', key: 'studioSystem', value: 'C64 with a mouse' });
    await tick();
    assert.equal(vscode.__mock.configStore.get('studioSystem'), 'C64 with a mouse');

    // What the page posts, the view runs — through the allow-list.
    view.webview.__fire({ type: 'command', id: '8bitscript.openStudio' });
    await tick();
    const ran = vscode.__mock.executedCommands.filter((c) => c.id === '8bitscript.openStudio');
    assert.equal(ran.length, 1, 'openStudio reached vscode.commands once');

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
