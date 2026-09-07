// The controls at the top of the 8BitScript side bar.
//
// A tree view cannot hold a <select>, so this is a small webview, and it
// is deliberately four lines tall: the project to act on with Run and
// Build beside it, the system and its region, and — behind a disclosure,
// because most runs never touch it — the hardware fitted to that system:
// a preset (a catalog preset or one the project composes in its
// 8bs.config.ts) and one control per catalog option (RAM, model, ports,
// …), every option and value read from `8bs targets --json` so the editor
// lists nothing of its own. How the project list below is laid out, and
// whether it shows the toolchain's examples, are on that view's title bar
// rather than here; this panel sits above the list and must not push it
// off the screen.
//
// Every choice is written straight to the extension's settings (see
// settings.cjs); the projects view reads those settings, so the two views
// never hold state of their own to disagree over, and Run here runs
// exactly the `8bs run` line the hint shows.
//
// The page itself lives in media/controls.{css,js} and is read in here.
// It used to be inlined in this file as a template literal; `\n` inside
// that template became a real newline in the generated script, which
// failed to parse, so every dropdown that is filled from JS stayed empty.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const vscode = require('vscode');

const { ALL_TARGETS, MACHINE_TARGETS, commandArgs } = require('./projects.cjs');
const settings = require('./settings.cjs');
const {
  effectiveFacts, effectiveOptions, normalizeSelection, selectionLabel,
} = require('./hardwareCatalog.cjs');

const VIEW_ID = '8bitscript.controls';
const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'controls.css'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'controls.js'), 'utf8');

class ControlsViewProvider {
  /**
   * @param {{
   *   list: () => import('./projects.cjs').Project[],
   *   onDidChange: vscode.Event<unknown>,
   *   loadTargets: (dir?: string) => Promise<Map<string, object>|null>,
   * }} projects
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

  /** The project the panel acts on: the chosen one, or the first offered. */
  selectedProject() {
    const projects = this.projects.list();
    const chosen = settings.getProject();
    return projects.find((project) => project.dir === chosen) ?? projects[0] ?? null;
  }

  async apply(message) {
    if (message?.type === 'ready') {
      await this.post();
      return;
    }
    if (message?.type === 'launch') {
      const project = this.selectedProject();
      if (!project) return;
      await vscode.commands.executeCommand(
        message.action === 'build' ? '8bitscript.build' : '8bitscript.run',
        { kind: 'target', project, target: settings.getSystem() },
      );
      return;
    }
    if (message?.type !== 'set') return;
    switch (message.key) {
      case 'project':
        await settings.setProject(message.value);
        break;
      case 'system':
        if (ALL_TARGETS.includes(message.value)) await settings.setSystem(message.value);
        break;
      case 'region':
        if (message.value === 'ntsc' || message.value === 'pal') await settings.setRegion(message.value);
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
    const project = this.selectedProject();
    // Asked in the selected project's directory: the hardware it fits its
    // targets with is in its own 8bs.config.ts, not the toolchain's
    // catalog, so the panel's stock machine is that project's.
    const targets = await this.projects.loadTargets(project?.dir);
    if (!this.view) return;
    const target = targets?.get(system) ?? null;
    const selection = normalizeSelection(settings.getHardware(system));
    const region = settings.getRegion();
    const runnable = Boolean(project?.targets.includes(system));
    this.view.webview.postMessage({
      type: 'state',
      projects: this.projects.list().map((p) => ({
        id: p.dir,
        label: `${p.kind === 'app' ? p.title : p.name}  —  ${p.targets.join(', ')}`,
      })),
      project: project?.dir ?? '',
      systems: ALL_TARGETS.map((id) => ({ id, machine: MACHINE_TARGETS.has(id), title: targets?.get(id)?.title ?? id })),
      system,
      region,
      runnable,
      warning: warningFor(project, system),
      hardware: hardwareState(target, targets, selection),
      command: `8bs ${commandArgs('run', system, region, selection).join(' ')}`,
    });
  }
}

/** Why Run is greyed out, in the words the panel shows instead of the command line. */
function warningFor(project, system) {
  if (!project) return 'No project found. A project is a directory with an 8bs.config.ts.';
  if (!project.targets.includes(system)) return `${project.name} does not target ${system}.`;
  return null;
}

/** Presets and options for one system, or null when the toolchain could not be asked. */
function hardwareState(target, targets, selection) {
  if (!target) return null;
  const project = Object.keys(target.profiles ?? {});
  const catalog = Object.keys(target.presets ?? {}).filter((id) => !project.includes(id));
  const profiles = [{ id: '', label: 'Stock machine' }];
  if (project.length > 0) {
    profiles.push({ group: 'This project' });
    for (const id of project) profiles.push({ id, label: id });
  }
  if (catalog.length > 0) {
    profiles.push({ group: 'Catalog presets' });
    for (const id of catalog) profiles.push({ id, label: id });
  }
  return {
    summary: selectionLabel(selection) || 'stock',
    profiles,
    options: Object.entries(target.options ?? {}).map(([id, option]) => ({
      id,
      label: option.label,
      default: option.default,
      detect: option.detect ?? null,
      values: Object.entries(option.values ?? {}).map(([value, entry]) => ({
        id: value, label: entry.label, affectsBuild: entry.affectsBuild, detect: entry.detect ?? null,
      })),
    })),
    effective: effectiveOptions(target, selection),
    selection,
    facts: (targets.facts ?? []).filter((fact) => fact.program).map((fact) => ({
      key: fact.key, doc: fact.doc, when: fact.when, type: fact.type,
      value: effectiveFacts(target, selection)[fact.key] ?? (fact.type === 'flag' ? false : 0),
    })),
  };
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
<style nonce="${nonce}">${CSS}</style>
<title>8BitScript</title>
</head>
<body>
  <div class="row">
    <div class="grow">
      <label class="field" for="project">Project</label>
      <select id="project" title="The project Run and Build act on"></select>
    </div>
    <button class="action" id="run" title="Run this project on the selected system">Run</button>
    <button class="action secondary" id="build" title="Build this project for the selected system">Build</button>
  </div>
  <div class="row">
    <div class="grow">
      <label class="field" for="system">System</label>
      <select id="system" title="The system Run and Build use"></select>
    </div>
    <div class="grow">
      <label class="field" for="region">Region</label>
      <select id="region" title="NTSC (US/Japan, 60Hz) or PAL (Europe, 50Hz) machine model">
        <option value="ntsc">NTSC (US/Japan)</option>
        <option value="pal">PAL (Europe)</option>
      </select>
    </div>
  </div>
  <details class="panel">
    <summary>Hardware <span class="summary-value" id="fitted"></span></summary>
    <select id="profile" title="A preset: stock, a catalog preset, or one this project composes in its 8bs.config.ts"></select>
    <div id="options"></div>
  </details>
  <div class="hint" id="hint"></div>
  <script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ list: () => import('./projects.cjs').Project[], onDidChange: vscode.Event<unknown> }} projects
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
