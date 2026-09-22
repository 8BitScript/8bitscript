// The Studio tab: Studio running in the editor, in the CLI's WebAssembly
// x16emu, with the controls around it that a person reaches for while
// drawing — reset the machine, rebuild after an edit, stop, and the
// browser when the tab turns out not to be allowed the mouse.
//
// A `createWebviewPanel`, like Controller Setup, and for the same reason:
// it is opened, used, and closed, and an emulator has no business in a
// 300px side bar. What it frames is not this extension's page at all —
// it is the URL `8bs run cx16 --web` prints, which the CLI serves on
// loopback with the freshly built .prg (packages/cli/src/web-emulator.mjs).
// The extension never bundles an emulator: the CLI owns the pin, the
// download and the argv, and this tab is one <iframe> pointed at it.
//
// The mouse is the honest part. A native x16emu has to run captured (see
// packages/cx16/AGENTS.md), so the pointer cannot leave its window
// without ⇧⌘M. In the browser the same capture is the Pointer Lock API —
// a click on the screen takes the mouse, Esc gives it back — and *whether
// an editor's webview is allowed to grant it to a nested frame is not
// something this code can know in advance*. So the framed page reports
// its pointer-lock state to this one (postMessage, `8bs-x16emu`), the
// tab shows it on its mouse line, and a refusal turns into "Open in
// browser", which is the known-good.
//
// State lives in two places the tab only reads: which `8bs` task is
// running (projects.running) and what the CLI wrote to
// dist/.8bs-last-cx16.json (the URL). A last-run file usually predates the
// run — a native launch leaves one with no URL, an earlier tab a dead one
// — so a report only counts once it is written after the run was started.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const vscode = require('vscode');

const { readLastRun } = require('./runningMachines.cjs');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'studio.css'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'studio.js'), 'utf8');

/** How far behind the tab's own clock a last-run `writtenAt` may be and
 * still count as this run's: the CLI stamps it on the same machine, but a
 * task's start is noted a moment after the command was issued. */
const CLOCK_SLACK_MS = 2000;

/**
 * Which last-run report belongs to the run started at `launchedAt`: one
 * with a URL, written since. Exported for the test; the rule is the
 * whole reason the tab does not frame a stale address.
 *
 * @param {ReturnType<typeof readLastRun>} report
 * @param {number} launchedAt
 */
function freshReport(report, launchedAt) {
  if (!report || !report.url || !report.writtenAt) return null;
  const written = Date.parse(report.writtenAt);
  if (!Number.isFinite(written) || written < launchedAt - CLOCK_SLACK_MS) return null;
  return report;
}

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The page. The framed URL is part of the HTML rather than posted later
 * because the CSP's `frame-src` has to name its origin, and under a remote
 * window that origin is whatever `asExternalUri` hands back.
 *
 * @param {vscode.Webview} webview
 * @param {{ src?: string|null }} [options]
 */
function html(webview, { src = null } = {}) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const origin = src ? new URL(src).origin : null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';${origin ? ` frame-src ${origin};` : ''}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
  <header class="bar">
    <div class="title">Studio <span class="sub">on the Commander X16 · x16emu (WebAssembly)</span></div>
    <div class="status" id="status"></div>
    <div class="actions">
      <button id="restart" title="Reset the machine: the same build, booted again">Reset</button>
      <button id="rebuild" title="Build Studio again and start it">Rebuild</button>
      <button id="stop" title="End the run">Stop</button>
      <button id="browser" title="The same URL in your browser — the known-good for the mouse">Open in browser</button>
    </div>
  </header>
  <p class="mouse" id="mouse"></p>
  <div class="screen">
    ${src ? `<iframe id="frame" src="${escapeAttr(src)}" allow="pointer-lock; autoplay; gamepad; fullscreen" title="Studio"></iframe>` : ''}
    <div class="empty" id="empty" hidden></div>
  </div>
  <script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}

/**
 * Module-level and singular, as Controller Setup's is: a second Open
 * Studio in a Tab replaces what the one tab shows rather than opening a
 * second emulator beside it.
 */
let open = null;

class StudioPanel {
  /**
   * @param {vscode.WebviewPanel} panel
   * @param {import('./runner.cjs').Projects} projects
   */
  constructor(panel, projects) {
    this.panel = panel;
    this.projects = projects;
    /** The run the tab follows: Studio's directory, its target, and when it was started. */
    this.binding = null;
    /** The URL the page currently frames, or null when it frames nothing. */
    this.src = null;
    this.phase = 'stopped';
  }

  /** Point the tab at a run (a new one, on Rebuild) and redraw. */
  async bind({ dir, target, launchedAt }) {
    this.binding = { dir, target, launchedAt };
    this.src = null;
    this.panel.webview.html = html(this.panel.webview);
    await this.refresh();
  }

  running() {
    const { dir, target } = this.binding;
    return this.projects.running.matching(dir, target, { web: true }).length > 0;
  }

  /**
   * Re-read the two facts and redraw. The page is re-rendered only when
   * what it frames changes — a URL arriving, or the run ending — since a
   * new html is a reload of the emulator.
   */
  async refresh() {
    if (!this.binding) return;
    const { dir, target, launchedAt } = this.binding;
    const report = readLastRun(dir, target);
    const fresh = freshReport(report, launchedAt);
    const running = this.running();
    this.phase = !running ? 'stopped' : fresh ? 'running' : 'building';
    this.report = fresh ?? report;
    if (running && fresh && fresh.url !== this.url) {
      this.url = fresh.url;
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(fresh.url));
      this.src = external.toString();
      this.panel.webview.html = html(this.panel.webview, { src: this.src });
      return; // the page says `ready` and gets its state then
    }
    if (!running && this.url) {
      this.url = null;
      this.src = null;
      this.panel.webview.html = html(this.panel.webview);
      return;
    }
    await this.post();
  }

  state() {
    const report = this.phase === 'stopped' ? null : this.report;
    return {
      type: 'state',
      phase: this.phase,
      emulator: report?.emulator ?? null,
      program: report?.memory?.program ?? null,
    };
  }

  post() {
    return this.panel.webview.postMessage(this.state());
  }

  async apply(message) {
    switch (message?.type) {
      case 'ready':
        await this.post();
        return;
      case 'rebuild':
        await vscode.commands.executeCommand('8bitscript.openStudioTab');
        return;
      case 'stop':
        this.stop();
        return;
      case 'browser':
        if (this.url) await vscode.env.openExternal(vscode.Uri.parse(this.url));
        return;
      default:
    }
  }

  /** End the run the tab follows — and only that one: a native Studio window stays. */
  stop() {
    if (!this.binding) return;
    this.projects.running.stop(this.binding.dir, this.binding.target, { web: true });
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import('./runner.cjs').Projects} projects
 */
function registerStudioView(context, projects) {
  context.subscriptions.push(
    // Hidden from the palette (package.json's commandPalette `when:
    // false`): openStudioTab in runner.cjs starts the run and then calls
    // this with what to follow. The palette entry is that one.
    vscode.commands.registerCommand('8bitscript.studioTab.show', async (run) => {
      if (!run || typeof run.dir !== 'string' || typeof run.target !== 'string') return;
      const binding = { dir: run.dir, target: run.target, launchedAt: typeof run.launchedAt === 'number' ? run.launchedAt : Date.now() };
      if (open) {
        await open.bind(binding);
        open.panel.reveal(vscode.ViewColumn.Active);
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        '8bitscript.studio',
        'Studio',
        vscode.ViewColumn.Active,
        // Retained while hidden: a glance at a source file must not cold-boot
        // the machine and lose whatever was being drawn.
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const view = new StudioPanel(panel, projects);
      const subscriptions = [
        panel.webview.onDidReceiveMessage((message) => view.apply(message)),
        // Runs starting and ending, and the live poll's last-run re-reads,
        // both arrive here — no timer of the tab's own.
        projects.onDidChange(() => { view.refresh().catch(() => {}); }),
      ];
      panel.onDidDispose(() => {
        // Closing the tab ends the run: `--no-open` means nothing else is
        // looking at that server. Running machines keeps its own Stop for
        // the odd case of a run started from a terminal.
        view.stop();
        for (const subscription of subscriptions) subscription.dispose();
        open = null;
      });
      open = view;
      await view.bind(binding);
    }),
  );
}

module.exports = { freshReport, html, registerStudioView };
