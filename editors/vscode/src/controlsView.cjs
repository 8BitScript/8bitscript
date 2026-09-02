// The dropdowns at the top of the 8BitScript side bar.
//
// A tree view cannot hold a <select>, so this is a small webview: three
// dropdowns — the system to run on, the region for the Commodore machines,
// and which way to lay out the project list — plus a checkbox for the example
// projects when any are available. Every choice is written straight to the
// extension's settings (see settings.cjs); the projects view reads those
// settings, so the two views never hold state of their own to disagree over.
const crypto = require('crypto');

const vscode = require('vscode');

const { ALL_TARGETS, MACHINE_TARGETS } = require('./projects.cjs');
const settings = require('./settings.cjs');

const VIEW_ID = '8bitscript.controls';

class ControlsViewProvider {
  /**
   * @param {{ hasExamples: () => boolean, onDidChange: vscode.Event<unknown> }} projects
   */
  constructor(projects) {
    this.projects = projects;
    this.view = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview);

    const subscriptions = [
      view.webview.onDidReceiveMessage((message) => this.apply(message)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (settings.affectsAny(event) || event.affectsConfiguration('8bitscript.showExamples')) {
          this.post();
        }
      }),
      this.projects.onDidChange(() => this.post()),
      view.onDidChangeVisibility(() => view.visible && this.post()),
    ];
    view.onDidDispose(() => {
      for (const subscription of subscriptions) subscription.dispose();
      this.view = undefined;
    });

    this.post();
  }

  async apply(message) {
    if (message?.type !== 'set') return;
    switch (message.key) {
      case 'system':
        if (ALL_TARGETS.includes(message.value)) await settings.setSystem(message.value);
        break;
      case 'region':
        if (message.value === 'ntsc' || message.value === 'pal') await settings.setRegion(message.value);
        break;
      case 'view':
        if (settings.VIEW_MODES.some((m) => m.id === message.value)) await settings.setViewMode(message.value);
        break;
      case 'examples':
        await settings.setShowExamples(Boolean(message.value));
        break;
      default:
        break;
    }
  }

  /** Push the current settings to the page; it never keeps its own copy. */
  post() {
    if (!this.view) return;
    const system = settings.getSystem();
    this.view.webview.postMessage({
      type: 'state',
      systems: ALL_TARGETS.map((id) => ({ id, machine: MACHINE_TARGETS.has(id) })),
      views: settings.VIEW_MODES,
      system,
      region: settings.getRegion(),
      view: settings.getViewMode(),
      showExamples: settings.getShowExamples(),
      hasExamples: this.projects.hasExamples(),
    });
  }
}

function html(webview) {
  const nonce = crypto.randomBytes(16).toString('hex');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body {
    margin: 0;
    padding: 4px 12px 10px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  .row { display: flex; gap: 8px; }
  .row > div { flex: 1; min-width: 0; }
  label.field {
    display: block;
    margin: 6px 0 2px;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.8;
  }
  select {
    width: 100%;
    box-sizing: border-box;
    padding: 3px 6px;
    font: inherit;
    color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
  }
  select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  select:disabled { opacity: 0.5; }
  .check { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
  .check input { margin: 0; }
  .hint { margin-top: 8px; font-size: 11px; opacity: 0.7; }
  code { font-family: var(--vscode-editor-font-family); }
</style>
<title>8BitScript</title>
</head>
<body>
  <div class="row">
    <div>
      <label class="field" for="system">System</label>
      <select id="system" title="The system the Run and Build buttons use"></select>
    </div>
    <div>
      <label class="field" for="region">Region</label>
      <select id="region" title="NTSC (60Hz) or PAL (50Hz) machine model for vic20 and c64">
        <option value="ntsc">NTSC</option>
        <option value="pal">PAL</option>
      </select>
    </div>
  </div>
  <label class="field" for="view">View</label>
  <select id="view" title="How the project list below is laid out"></select>
  <div class="check" id="examplesRow" hidden>
    <input type="checkbox" id="examples">
    <label for="examples">Show example projects</label>
  </div>
  <div class="hint" id="hint"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    function fill(select, options, selected) {
      select.textContent = '';
      for (const option of options) {
        const el = document.createElement('option');
        el.value = option.id;
        el.textContent = option.label;
        el.selected = option.id === selected;
        select.appendChild(el);
      }
    }

    window.addEventListener('message', ({ data }) => {
      if (data.type !== 'state') return;
      fill($('system'), data.systems.map((s) => ({ id: s.id, label: s.id })), data.system);
      fill($('view'), data.views, data.view);
      $('region').value = data.region;
      const machine = data.systems.find((s) => s.id === data.system)?.machine ?? false;
      $('region').disabled = !machine;
      $('examplesRow').hidden = !data.hasExamples;
      $('examples').checked = data.showExamples;
      const regionText = machine ? ' \\u00b7 ' + data.region.toUpperCase() : '';
      $('hint').innerHTML = 'Run buttons use <code>' + data.system + regionText + '</code>';
    });

    for (const key of ['system', 'region', 'view']) {
      $(key).addEventListener('change', (e) => vscode.postMessage({ type: 'set', key, value: e.target.value }));
    }
    $('examples').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'examples', value: e.target.checked }));
  </script>
</body>
</html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ hasExamples: () => boolean, onDidChange: vscode.Event<unknown> }} projects
 */
function registerControlsView(context, projects) {
  const provider = new ControlsViewProvider(projects);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  return provider;
}

module.exports = { registerControlsView };
