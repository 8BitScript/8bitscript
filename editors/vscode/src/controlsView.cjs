// The controls at the top of the 8BitScript side bar.
//
// A tree view cannot hold a <select>, so this is a small webview: the
// system to run on, the region for the machines that have one, the
// hardware fitted to that system — a profile (a catalog preset or one the
// project composes in its 8bs.config.ts) and single options on top, every
// option and value read from `8bs targets --json` so the editor lists
// nothing of its own — and which way to lay out the project list, plus a
// checkbox for the toolchain's proofs of concept when any are available.
// Every choice is written straight to the extension's settings (see
// settings.cjs); the projects view reads those settings, so the two views
// never hold state of their own to disagree over, and the Run button on
// any row runs exactly the `8bs run` line the hint shows.
const crypto = require('crypto');

const vscode = require('vscode');

const { ALL_TARGETS, MACHINE_TARGETS, commandArgs } = require('./projects.cjs');
const settings = require('./settings.cjs');
const { effectiveFacts, effectiveOptions, normalizeSelection } = require('./hardwareCatalog.cjs');

const VIEW_ID = '8bitscript.controls';

class ControlsViewProvider {
  /**
   * @param {{ hasExamples: () => boolean, onDidChange: vscode.Event<unknown>, loadTargets: () => Promise<Map<string, object>|null> }} projects
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
      case 'profile': {
        const system = settings.getSystem();
        const current = settings.getHardware(system);
        await settings.setHardware(system, { ...current, profile: message.value || null });
        break;
      }
      case 'option': {
        const system = settings.getSystem();
        const current = settings.getHardware(system);
        const options = { ...current.options };
        if (message.value === '' || message.value === undefined) delete options[message.option];
        else options[message.option] = String(message.value);
        await settings.setHardware(system, { ...current, options });
        break;
      }
      case 'stock': {
        await settings.setHardware(settings.getSystem(), { profile: null, options: {} });
        break;
      }
      default:
        break;
    }
  }

  /** Push the current settings to the page; it never keeps its own copy. */
  async post() {
    if (!this.view) return;
    const system = settings.getSystem();
    const targets = await this.projects.loadTargets();
    if (!this.view) return;
    const target = targets?.get(system) ?? null;
    const selection = normalizeSelection(settings.getHardware(system));
    const region = settings.getRegion();
    this.view.webview.postMessage({
      type: 'state',
      systems: ALL_TARGETS.map((id) => ({ id, machine: MACHINE_TARGETS.has(id), title: targets?.get(id)?.title ?? id })),
      views: settings.VIEW_MODES,
      system,
      region,
      view: settings.getViewMode(),
      showExamples: settings.getShowExamples(),
      hasExamples: this.projects.hasExamples(),
      hardware: target ? {
        profiles: [
          ...Object.keys(target.profiles ?? {}).map((id) => ({ id, label: `${id} (this project)` })),
          ...Object.keys(target.presets ?? {}).map((id) => ({ id, label: id })),
        ],
        options: Object.entries(target.options ?? {}).map(([id, option]) => ({
          id,
          label: option.label,
          default: option.default,
          values: Object.entries(option.values).map(([value, entry]) => ({
            id: value, label: entry.label, affectsBuild: entry.affectsBuild,
          })),
        })),
        effective: effectiveOptions(target, selection),
        selection,
        // What a program can rely on with this selection: the sheet
        // @8bitscript/system's consts fold to, labelled from the schema.
        facts: (targets.facts ?? []).filter((fact) => fact.program).map((fact) => ({
          key: fact.key, doc: fact.doc, when: fact.when, type: fact.type,
          value: effectiveFacts(target, selection)[fact.key] ?? (fact.type === 'flag' ? false : 0),
        })),
      } : null,
      command: `8bs ${commandArgs('run', system, region, selection).join(' ')}`,
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
  .hardware { margin-top: 4px; }
  .hardware .option { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
  .hardware .option label { flex: 0 0 38%; font-size: 11px; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hardware .option select { flex: 1; }
  .hardware .option.set label { opacity: 1; font-weight: 600; }
  .hardware .none { font-size: 11px; opacity: 0.6; margin: 4px 0; }
  .link { background: none; border: none; padding: 0; font: inherit; font-size: 11px; color: var(--vscode-textLink-foreground); cursor: pointer; }
  .check input { margin: 0; }
  .hint { margin-top: 8px; font-size: 11px; opacity: 0.7; }
  details.facts { margin-top: 8px; }
  details.facts summary { cursor: pointer; font-size: 11px; opacity: 0.8; }
  table.facts { border-collapse: collapse; width: 100%; font-size: 11px; margin-top: 4px; }
  table.facts td { padding: 1px 4px; vertical-align: top; }
  table.facts td.value { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.facts td.run { opacity: 0.7; }
  table.facts tr.group td { padding-top: 5px; font-weight: 600; opacity: 0.8; }
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
      <select id="region" title="NTSC (US/Japan, 60Hz) or PAL (Europe, 50Hz) machine model for vic20 and c64">
        <option value="ntsc">NTSC (US/Japan)</option>
        <option value="pal">PAL (Europe)</option>
      </select>
    </div>
  </div>
  <label class="field" for="profile">Hardware</label>
  <select id="profile" title="A profile: a preset from the system's catalog, or one this project composes in its 8bs.config.ts"></select>
  <div class="hardware" id="hardware"></div>
  <label class="field" for="view">View</label>
  <select id="view" title="How the project list below is laid out"></select>
  <div class="check" id="examplesRow" hidden>
    <input type="checkbox" id="examples">
    <label for="examples">Show proofs of concept</label>
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

    function renderHardware(hardware) {
      const root = $('hardware');
      root.textContent = '';
      if (!hardware) {
        fill($('profile'), [{ id: '', label: 'stock' }], '');
        $('profile').disabled = true;
        const none = document.createElement('div');
        none.className = 'none';
        none.textContent = 'No toolchain found to ask about hardware.';
        root.appendChild(none);
        return;
      }
      $('profile').disabled = false;
      fill($('profile'), [{ id: '', label: 'stock' }, ...hardware.profiles], hardware.selection.profile ?? '');
      if (hardware.options.length === 0) {
        const none = document.createElement('div');
        none.className = 'none';
        none.textContent = 'Nothing to fit on this system.';
        root.appendChild(none);
        return;
      }
      for (const option of hardware.options) {
        const row = document.createElement('div');
        row.className = 'option' + (option.id in hardware.selection.options ? ' set' : '');
        const label = document.createElement('label');
        label.textContent = option.label;
        label.title = option.label + ' (--hardware ' + option.id + '=...)';
        const select = document.createElement('select');
        select.title = label.title;
        for (const value of option.values) {
          const el = document.createElement('option');
          el.value = value.id;
          el.textContent = value.label + (value.affectsBuild ? '  [build]' : '');
          el.selected = value.id === hardware.effective[option.id];
          select.appendChild(el);
        }
        select.addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'option', option: option.id, value: e.target.value }));
        row.appendChild(label);
        row.appendChild(select);
        root.appendChild(row);
      }
      const reset = document.createElement('button');
      reset.className = 'link';
      reset.textContent = 'Back to stock';
      reset.addEventListener('click', () => vscode.postMessage({ type: 'set', key: 'stock' }));
      root.appendChild(reset);
      renderFacts(root, hardware.facts);
    }

    // The fact sheet for the selection, grouped the way @8bitscript/system
    // names it: `video.columns` is Video.COLUMNS. A run-time fact reads
    // "may use", since the machine answers whether it is really there.
    function renderFacts(root, facts) {
      if (!facts || facts.length === 0) return;
      const details = document.createElement('details');
      details.className = 'facts';
      const summary = document.createElement('summary');
      summary.textContent = 'What a program can rely on';
      details.appendChild(summary);
      const table = document.createElement('table');
      table.className = 'facts';
      let group = null;
      for (const fact of facts) {
        const [head, ...rest] = fact.key.split('.');
        if (head !== group) {
          group = head;
          const row = document.createElement('tr');
          row.className = 'group';
          const cell = document.createElement('td');
          cell.colSpan = 2;
          cell.textContent = head[0].toUpperCase() + head.slice(1);
          row.appendChild(cell);
          table.appendChild(row);
        }
        const row = document.createElement('tr');
        row.title = fact.doc + (fact.when === 'run' ? ' (run time: the build may use it; the machine says whether it is there)' : '');
        const name = document.createElement('td');
        name.textContent = rest.join('.').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
        const value = document.createElement('td');
        value.className = 'value' + (fact.when === 'run' ? ' run' : '');
        value.textContent = fact.type === 'flag'
          ? (fact.value ? (fact.when === 'run' ? 'may use' : 'yes') : 'no')
          : String(fact.value);
        row.appendChild(name);
        row.appendChild(value);
        table.appendChild(row);
      }
      details.appendChild(table);
      root.appendChild(details);
    }

    window.addEventListener('message', ({ data }) => {
      if (data.type !== 'state') return;
      fill($('system'), data.systems.map((s) => ({ id: s.id, label: s.title === s.id ? s.id : s.id + ' \\u2014 ' + s.title })), data.system);
      fill($('view'), data.views, data.view);
      $('region').value = data.region;
      const machine = data.systems.find((s) => s.id === data.system)?.machine ?? false;
      $('region').disabled = !machine;
      $('examplesRow').hidden = !data.hasExamples;
      $('examples').checked = data.showExamples;
      renderHardware(data.hardware);
      $('hint').innerHTML = 'Run buttons use <code>' + data.command + '</code>';
    });

    for (const key of ['system', 'region', 'view']) {
      $(key).addEventListener('change', (e) => vscode.postMessage({ type: 'set', key, value: e.target.value }));
    }
    $('profile').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'profile', value: e.target.value }));
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
