// The Studio tab, end to end under the mock: opened by the show command
// with a run to follow, it frames nothing until a last-run file written
// *after* that run started carries a URL (a native launch's file, or an
// earlier tab's, is older and ignored), then frames that URL with the
// permissions the emulator needs; the page's buttons reach the host
// through the message handler; and closing the tab ends the run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const { freshReport, html, registerStudioView } = require('../src/studioView.cjs');

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function writeLastRun(dir, target, data) {
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', `.8bs-last-${target}.json`), JSON.stringify({ target, ...data }));
}

/**
 * A Projects stand-in: which runs are in flight, a Stop that records, the
 * change event, and — for the "Open in emulator" button — a doctor report
 * and a target catalog to read an emulator's name from. Both default to
 * "nothing installed, nothing to fit against", so every test that does not
 * care about the button sees it stay hidden without having to say so.
 */
function fakeProjects({ doctor = null, targets = new Map(), all = [] } = {}) {
  const changed = new vscode.EventEmitter();
  const runs = [];
  const stopped = [];
  return {
    runs,
    stopped,
    changed,
    all,
    onDidChange: changed.event,
    loadDoctor: async () => doctor,
    loadTargets: async () => targets,
    running: {
      matching: (dir, target, only = {}) => runs.filter((r) => r.dir === dir && r.target === target && (only.web === undefined || r.web === only.web)),
      stop: (dir, target, only) => stopped.push({ dir, target, only }),
    },
  };
}

test('freshReport: a report counts only with a URL and written since the run started', () => {
  const launchedAt = Date.parse('2026-09-21T10:00:00Z');
  const base = { url: 'http://127.0.0.1:5000/', writtenAt: '2026-09-21T10:00:05Z' };
  assert.ok(freshReport(base, launchedAt));
  assert.equal(freshReport({ ...base, writtenAt: '2026-09-21T09:59:00Z' }, launchedAt), null, 'an earlier run\'s file');
  assert.ok(freshReport({ ...base, writtenAt: '2026-09-21T09:59:58.500Z' }, launchedAt), 'a moment before is clock slack, not staleness');
  assert.equal(freshReport({ ...base, url: null }, launchedAt), null, 'a native launch wrote no URL');
  assert.equal(freshReport({ ...base, writtenAt: 'yesterday' }, launchedAt), null);
  assert.equal(freshReport(null, launchedAt), null);
});

test('html: without a URL there is no frame and no frame-src; with one, the frame has the emulator\'s permissions and the CSP names its origin', () => {
  const webview = { cspSource: 'vscode-webview:' };
  const empty = html(webview);
  assert.doesNotMatch(empty, /<iframe/);
  assert.doesNotMatch(empty, /frame-src/);
  assert.match(empty, /id="restart"[\s\S]*id="rebuild"[\s\S]*id="stop"[\s\S]*id="browser"/);
  const framed = html(webview, { src: 'http://localhost:5000/?x="1"' });
  assert.match(framed, /frame-src http:\/\/localhost:5000;/);
  assert.match(framed, /<iframe id="frame" src="http:\/\/localhost:5000\/\?x=&quot;1&quot;" allow="pointer-lock; autoplay; gamepad; fullscreen"/);
  assert.doesNotMatch(framed, /sandbox=/, 'a sandbox would strip pointer lock');
});

test('html: no options at all is Studio on the X16, unchanged — the Preview tab\'s defaults never leak into Studio\'s own call site', () => {
  const webview = { cspSource: 'vscode-webview:' };
  const page = html(webview);
  assert.match(page, /<title>Studio<\/title>/);
  assert.match(page, /Studio <span class="sub">on the Commander X16 · x16emu \(WebAssembly\)<\/span>/);
  assert.match(page, /window\.__8bsHasMouse = true;/);
});

test('html: a machine with no mouse (hasMouse: false) still gets its own title, and the page is told not to show a mouse line', () => {
  const webview = { cspSource: 'vscode-webview:' };
  const page = html(webview, { tabTitle: 'Preview', title: 'PET', subtitle: 'wasm build', hasMouse: false });
  assert.match(page, /<title>Preview<\/title>/);
  assert.match(page, /PET <span class="sub">wasm build<\/span>/);
  assert.match(page, /window\.__8bsHasMouse = false;/);
});

test('the tab follows a run: building until a fresh URL lands, framed once it does, stopped when the run ends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-studio-tab-'));
  const context = { subscriptions: [] };
  try {
    vscode.__mock.reset();
    const projects = fakeProjects();
    registerStudioView(context, projects);
    assert.ok(vscode.__mock.commandHandlers.has('8bitscript.studioTab.show'));

    // A native run left a file with no URL; an earlier tab, one with a dead URL. Both older.
    writeLastRun(dir, 'cx16', { url: 'http://127.0.0.1:1111/', emulator: 'x16emu r49 (WebAssembly)', writtenAt: '2020-01-01T00:00:00Z' });
    const launchedAt = Date.now();
    projects.runs.push({ dir, target: 'cx16', web: true });
    await vscode.__mock.trigger('8bitscript.studioTab.show', { dir, target: 'cx16', launchedAt });
    await tick();
    const panel = vscode.__mock.webviewPanels.at(-1);
    assert.equal(panel.viewType, '8bitscript.studio');
    assert.equal(panel.options.retainContextWhenHidden, true);
    assert.doesNotMatch(panel.webview.html, /<iframe/, 'the stale URL is not framed');
    panel.webview.__fire({ type: 'ready' });
    await tick();
    assert.deepEqual(panel.posted.at(-1), { type: 'state', phase: 'building', emulator: 'x16emu r49 (WebAssembly)', program: null, nativeEmulator: null });

    // The CLI serves: a fresh file with the URL.
    writeLastRun(dir, 'cx16', { url: 'http://127.0.0.1:2222/', emulator: 'x16emu r49 (WebAssembly)', memory: { program: 6186 }, writtenAt: new Date().toISOString() });
    projects.changed.fire();
    await tick();
    await tick();
    assert.match(panel.webview.html, /<iframe id="frame" src="http:\/\/127\.0\.0\.1:2222\/"/);
    panel.webview.__fire({ type: 'ready' });
    await tick();
    assert.deepEqual(panel.posted.at(-1), { type: 'state', phase: 'running', emulator: 'x16emu r49 (WebAssembly)', program: 6186, nativeEmulator: null });

    // The page's buttons.
    panel.webview.__fire({ type: 'browser' });
    await tick();
    assert.deepEqual(vscode.__mock.openedExternal, ['http://127.0.0.1:2222/']);
    panel.webview.__fire({ type: 'stop' });
    await tick();
    assert.deepEqual(projects.stopped, [{ dir, target: 'cx16', only: { web: true } }], 'only the tab\'s run, never a native window');
    panel.webview.__fire({ type: 'rebuild' });
    await tick();
    assert.ok(vscode.__mock.executedCommands.some((c) => c.id === '8bitscript.openStudioTab'));
    panel.webview.__fire({ type: 'something-else' });
    await tick();

    // The run ends: the frame goes, the page says stopped.
    projects.runs.length = 0;
    projects.changed.fire();
    await tick();
    assert.doesNotMatch(panel.webview.html, /<iframe/);
    panel.webview.__fire({ type: 'ready' });
    await tick();
    assert.deepEqual(panel.posted.at(-1), { type: 'state', phase: 'stopped', emulator: null, program: null, nativeEmulator: null });

    // A second show re-points the one tab rather than opening another.
    const before = vscode.__mock.webviewPanels.length;
    projects.runs.push({ dir, target: 'cx16', web: true });
    await vscode.__mock.trigger('8bitscript.studioTab.show', { dir, target: 'cx16', launchedAt: Date.now() });
    await tick();
    assert.equal(vscode.__mock.webviewPanels.length, before);
    // Nothing to follow is nothing done.
    await vscode.__mock.trigger('8bitscript.studioTab.show', undefined);
    assert.equal(vscode.__mock.webviewPanels.length, before);

    // Closing the tab stops the run.
    projects.stopped.length = 0;
    panel.__dispose();
    assert.deepEqual(projects.stopped, [{ dir, target: 'cx16', only: { web: true } }]);
    // And the next show opens a fresh one.
    await vscode.__mock.trigger('8bitscript.studioTab.show', { dir, target: 'cx16', launchedAt: Date.now() });
    await tick();
    assert.equal(vscode.__mock.webviewPanels.length, before + 1);
    vscode.__mock.webviewPanels.at(-1).__dispose();
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ready re-reads instead of echoing a stale phase: a build fast enough to finish before the live poll\'s next tick still reports running', async () => {
  // hello-world's PET build finishes in well under a second — faster
  // than the 1s live poll that would otherwise be the only thing to
  // notice the fresh file. The very first bind() reads before any file
  // exists, caches phase 'building', and used to just echo that cache
  // back to `ready` — showing "being built" over an already-rendered
  // screen until, or unless, a poll tick happened to land first.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-studio-tab-ready-'));
  const context = { subscriptions: [] };
  try {
    vscode.__mock.reset();
    const projects = fakeProjects();
    registerStudioView(context, projects);

    const launchedAt = Date.now();
    projects.runs.push({ dir, target: 'pet', web: true });
    // Nothing on disk yet when the tab binds — bind()'s own refresh()
    // caches phase 'building', same as any run's first instant.
    await vscode.__mock.trigger('8bitscript.previewTab.show', { dir, target: 'pet', launchedAt });
    await tick();
    const panel = vscode.__mock.webviewPanels.at(-1);

    // The build finishes and the file lands *between* that bind() and
    // `ready` — and crucially, with no projects.changed.fire() in
    // between: nothing else has told the tab to look again yet, exactly
    // as when a build this fast beats the live poll's next 1s tick.
    writeLastRun(dir, 'pet', { url: 'http://127.0.0.1:3333/', emulator: 'browser', memory: { program: 108 }, writtenAt: new Date(launchedAt + 50).toISOString() });
    panel.webview.__fire({ type: 'ready' });
    await tick();
    assert.match(panel.webview.html, /<iframe id="frame" src="http:\/\/127\.0\.0\.1:3333\/"/,
      'ready itself notices the fresh file and frames it, rather than waiting for the next poll tick');
    // A real reload of the page it just framed sends its own `ready`,
    // exactly as the existing "framed once it does" run above relies on
    // after a poll-triggered swap; the mock's plain object html does not
    // reload on its own, so this fires the round trip by hand.
    panel.webview.__fire({ type: 'ready' });
    await tick();
    assert.deepEqual(panel.posted.at(-1), { type: 'state', phase: 'running', emulator: 'browser', program: 108, nativeEmulator: null });
    // Disposed, not left open: the module-level openPreview it set is
    // shared by every registerStudioView() call in this process, so a
    // panel left dangling here would make the *next* test's own
    // previewTab.show silently re-bind this one instead of creating its
    // own — exactly the kind of cross-test state a fresh vscode mock
    // (reset() clears the mock's own lists, not studioView.cjs's) does
    // not protect against.
    panel.__dispose();
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('closing the Preview tab stops its run, exactly as closing Studio\'s own tab does', async () => {
  // registerTab() is one shared implementation behind both commands;
  // Studio's own "closing the tab stops the run" case is covered above,
  // but nothing exercised the *second* registration (previewTab.show —
  // pet/vic20/c64's own --web builds, not the X16) the same way, so a
  // difference between the two call sites (a missing onRebuild, a typo
  // in which command name maps to which getOpen/setOpen) could have hidden
  // behind the first one passing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-preview-tab-dispose-'));
  const context = { subscriptions: [] };
  try {
    vscode.__mock.reset();
    const projects = fakeProjects();
    registerStudioView(context, projects);
    assert.ok(vscode.__mock.commandHandlers.has('8bitscript.previewTab.show'));

    projects.runs.push({ dir, target: 'pet', web: true });
    await vscode.__mock.trigger('8bitscript.previewTab.show', { dir, target: 'pet', launchedAt: Date.now() });
    await tick();
    const panel = vscode.__mock.webviewPanels.at(-1);
    assert.equal(panel.viewType, '8bitscript.preview', 'its own view type, not Studio\'s');

    projects.stopped.length = 0;
    panel.__dispose();
    assert.deepEqual(projects.stopped, [{ dir, target: 'pet', only: { web: true } }],
      'closing the Preview tab ends exactly the run it was following');
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('"Open in emulator": named only when Doctor reports it installed, and clicking runs the real machine alongside the preview, never replacing it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-preview-tab-emulator-'));
  const context = { subscriptions: [] };
  try {
    vscode.__mock.reset();
    const project = { dir, name: 'hello-world' };
    const targets = new Map([['pet', { emulator: 'xpet' }]]);
    const projects = fakeProjects({ all: [project], targets, doctor: { ready: ['pet'], notInstalled: [], failed: [] } });
    registerStudioView(context, projects);

    projects.runs.push({ dir, target: 'pet', web: true });
    await vscode.__mock.trigger('8bitscript.previewTab.show', { dir, target: 'pet', launchedAt: Date.now() });
    await tick();
    const panel = vscode.__mock.webviewPanels.at(-1);

    panel.webview.__fire({ type: 'ready' });
    await tick();
    assert.equal(panel.posted.at(-1).nativeEmulator, 'xpet', 'Doctor says pet is ready, and the catalog names its emulator');

    panel.webview.__fire({ type: 'emulator' });
    await tick();
    const ran = vscode.__mock.executedCommands.find((c) => c.id === '8bitscript.run');
    assert.ok(ran, 'the emulator button reaches the same 8bitscript.run command Run in emulator does');
    assert.deepEqual(ran.args[0], { project, target: 'pet', web: false },
      'web: false forces the native path, and the project is looked up from the binding\'s own dir');
    // The wasm preview's own run is untouched: nothing was stopped by this.
    assert.deepEqual(projects.stopped, []);

    // Doctor changes its mind (uninstalled, or found broken): the button goes away.
    projects.doctor = { ready: [], notInstalled: ['pet'], failed: [] };
    projects.loadDoctor = async () => projects.doctor;
    panel.webview.__fire({ type: 'ready' });
    await tick();
    assert.equal(panel.posted.at(-1).nativeEmulator, null, 'not installed: no button to open it');
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
