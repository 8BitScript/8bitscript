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

/** A Projects stand-in: which runs are in flight, a Stop that records, and the change event. */
function fakeProjects() {
  const changed = new vscode.EventEmitter();
  const runs = [];
  const stopped = [];
  return {
    runs,
    stopped,
    changed,
    onDidChange: changed.event,
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
    assert.deepEqual(panel.posted.at(-1), { type: 'state', phase: 'building', emulator: 'x16emu r49 (WebAssembly)', program: null });

    // The CLI serves: a fresh file with the URL.
    writeLastRun(dir, 'cx16', { url: 'http://127.0.0.1:2222/', emulator: 'x16emu r49 (WebAssembly)', memory: { program: 6186 }, writtenAt: new Date().toISOString() });
    projects.changed.fire();
    await tick();
    await tick();
    assert.match(panel.webview.html, /<iframe id="frame" src="http:\/\/127\.0\.0\.1:2222\/"/);
    panel.webview.__fire({ type: 'ready' });
    await tick();
    assert.deepEqual(panel.posted.at(-1), { type: 'state', phase: 'running', emulator: 'x16emu r49 (WebAssembly)', program: 6186 });

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
    assert.deepEqual(panel.posted.at(-1), { type: 'state', phase: 'stopped', emulator: null, program: null });

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
