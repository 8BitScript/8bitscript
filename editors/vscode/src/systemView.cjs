// The System builder: an editor tab with Machine / Hardware / Region /
// Facts / Save, writing the same `{ target, profile?, hardware?, region? }`
// the CLI already validates. Destination is explicit: advertise into
// 8bitscript.config.ts, this clone (.8bitscript/systems.json), or this
// user (~/.config/8bitscript/systems.json).
//
// Controller Setup is the template: createWebviewPanel, nonce CSP,
// media/*.css + media/*.js, the page holds no state, the host posts the
// whole model.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const vscode = require('vscode');

const { ALL_TARGETS, MACHINE_TARGETS, insertSystem, systemLine, groupedMachineOptions } = require('./projects.cjs');
const { labelOf } = require('./runner.cjs');
const settings = require('./settings.cjs');
const { hardwareState, selectionLabel } = require('./hardwareCatalog.cjs');
const {
  layerNames, projectSystemsPath, saveLayer, upsertSystem, userSystemsPath,
} = require('./systemsStore.cjs');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'system.css'), 'utf8');
const HARDWARE_JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'hardware.js'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'system.js'), 'utf8');

const TABS = ['machine', 'hardware', 'region', 'facts', 'save'];

let open = null;

class SystemPanel {
  /** @param {import('./runner.cjs').Projects} projects */
  constructor(panel, projects) {
    this.panel = panel;
    this.projects = projects;
    this.tab = 'machine';
    this.draft = {
      name: settings.getNamedSystem(),
      target: settings.getSystem(),
      profile: null,
      options: {},
      region: settings.getRegion(),
      layer: 'project',
    };
  }

  selectedProject() {
    const all = this.projects.all;
    const chosen = settings.getProject();
    return all.find((entry) => entry.dir === chosen)
      ?? this.projects.visible[0] ?? all[0] ?? null;
  }

  async apply(message) {
    switch (message?.type) {
      case 'ready':
        await this.hydrate();
        await this.post();
        return;
      case 'set':
        await this.set(message);
        return;
      case 'save':
        await this.save();
        return;
      case 'command':
        if (message.id === '8bitscript.openConfig') {
          const project = this.selectedProject();
          if (project) await vscode.window.showTextDocument(vscode.Uri.file(project.configPath));
        }
        return;
      default:
    }
  }

  async hydrate() {
    const project = this.selectedProject();
    const targets = await this.projects.loadTargets(project?.dir);
    const named = settings.getNamedSystem();
    const system = (targets?.systems ?? []).find((entry) => entry.name === named);
    if (system) {
      this.draft = {
        name: system.name,
        target: system.target,
        profile: system.profile ?? null,
        options: { ...(system.hardware ?? {}) },
        region: system.region === 'pal' ? 'pal' : 'ntsc',
        layer: system.origin === 'advertised' ? 'advertised' : system.origin,
      };
      return;
    }
    const target = settings.getSystem();
    const catalog = targets?.get(target);
    const selection = settings.getEffectiveHardware(target, catalog);
    this.draft = {
      name: this.draft.name || '',
      target,
      profile: selection.profile,
      options: { ...selection.options },
      region: settings.getRegion(),
      layer: 'project',
    };
  }

  async set(message) {
    switch (message.key) {
      case 'tab':
        if (TABS.includes(message.value)) this.tab = message.value;
        break;
      case 'name':
        this.draft.name = String(message.value ?? '');
        break;
      case 'target':
        if (ALL_TARGETS.includes(message.value)) {
          this.draft.target = message.value;
          this.draft.profile = null;
          this.draft.options = {};
        }
        break;
      case 'region':
        if (message.value === 'ntsc' || message.value === 'pal') this.draft.region = message.value;
        break;
      case 'profile':
        this.draft.profile = message.value || null;
        this.draft.options = {};
        break;
      case 'option': {
        const options = { ...this.draft.options };
        if (message.value === '' || message.value === undefined) delete options[message.option];
        else options[message.option] = String(message.value);
        this.draft.options = options;
        break;
      }
      case 'stock':
        this.draft.profile = null;
        this.draft.options = {};
        break;
      case 'layer':
        if (['advertised', 'project', 'user'].includes(message.value)) this.draft.layer = message.value;
        break;
      default:
        return;
    }
    await this.post();
  }

  async save() {
    const project = this.selectedProject();
    if (!project) {
      vscode.window.showInformationMessage('No project to save a system into.');
      return;
    }
    const name = this.draft.name.trim();
    if (!name) {
      vscode.window.showWarningMessage('A system needs a name.');
      this.tab = 'save';
      await this.post();
      return;
    }
    if (ALL_TARGETS.includes(name)) {
      vscode.window.showWarningMessage(`'${name}' is a machine's own name; call the system something else.`);
      return;
    }
    if (!project.targets.includes(this.draft.target)) {
      vscode.window.showWarningMessage(`${labelOf(project)} does not target ${this.draft.target}.`);
      return;
    }
    const targets = await this.projects.loadTargets(project.dir);
    const catalog = targets?.get(this.draft.target);
    const hasRegion = catalog?.region ?? false;
    const entry = {
      target: this.draft.target,
      profile: this.draft.profile,
      hardware: this.draft.options,
      region: hasRegion && this.draft.region === 'pal' ? 'pal' : null,
    };
    const existing = layerNames(project.dir);
    const destination = saveLayer(name, this.draft.layer, existing);
    if (destination.reason === 'more-specific') {
      this.draft.layer = destination.layer;
    }
    if (destination.reason === 'shadowed') {
      const choice = await vscode.window.showWarningMessage(
        `'${name}' already exists as a personal system, which would still win over an advertised one.`,
        { modal: true },
        'Save to this clone instead',
        'Advertise anyway',
      );
      if (!choice) return;
      if (choice === 'Save to this clone instead') destination.layer = existing.projectNames.has(name) ? 'project' : 'user';
    }

    if (destination.layer === 'advertised') {
      await advertise(project, name, entry);
    } else {
      const file = destination.layer === 'project'
        ? projectSystemsPath(project.dir)
        : userSystemsPath();
      upsertSystem(file, name, entry);
    }
    await settings.setNamedSystem(name);
    await settings.setSystem(this.draft.target);
    if (hasRegion) await settings.setRegion(this.draft.region);
    await settings.setHardware(this.draft.target, {
      profile: this.draft.profile,
      options: this.draft.options,
    });
    this.projects.refresh();
    vscode.window.showInformationMessage(`Saved '${name}' as a ${destination.layer === 'advertised' ? 'advertised' : destination.layer} system.`);
  }

  async post() {
    const project = this.selectedProject();
    const targets = await this.projects.loadTargets(project?.dir);
    if (!this.panel) return;
    const target = targets?.get(this.draft.target) ?? null;
    const selection = { profile: this.draft.profile, options: this.draft.options };
    const machine = MACHINE_TARGETS.has(this.draft.target);
    const existing = project ? layerNames(project.dir) : { projectNames: new Set(), userNames: new Set() };
    const collision = this.draft.name.trim()
      ? saveLayer(this.draft.name.trim(), this.draft.layer, existing)
      : { layer: this.draft.layer };
    this.panel.webview.postMessage({
      type: 'state',
      tab: this.tab,
      project: project ? labelOf(project) : '',
      draft: this.draft,
      machines: groupedMachineOptions(ALL_TARGETS, (id) => ({
        id,
        label: targets?.get(id)?.title ? `${id} — ${targets.get(id).title}` : id,
        runnable: Boolean(project?.targets.includes(id)),
        region: Boolean(targets?.get(id)?.region),
      })),
      machine,
      fitted: selectionLabel(selection) || 'stock machine',
      hardware: hardwareState(target, targets, selection),
      collision,
      layers: [
        { id: 'advertised', label: 'Advertise in 8bitscript.config.ts', where: project ? path.basename(project.configPath) : '' },
        { id: 'project', label: 'This clone only', where: '.8bitscript/systems.json' },
        { id: 'user', label: 'This machine, any project', where: '~/.config/8bitscript/systems.json' },
      ],
    });
  }
}

async function advertise(project, name, entry) {
  const uri = vscode.Uri.file(project.configPath);
  const document = await vscode.workspace.openTextDocument(uri);
  const updated = insertSystem(document.getText(), name, entry);
  const editor = await vscode.window.showTextDocument(document);
  if (updated === null) {
    const line = systemLine(name, entry);
    await editor.edit((builder) => builder.insert(editor.selection.active, `systems: {\n  ${line}\n},\n`));
    vscode.window.showInformationMessage(
      `${path.basename(project.configPath)} is not a plain "export default { … }", so the system was not written for you — it is at your cursor to place.`,
    );
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), updated);
  await vscode.workspace.applyEdit(edit);
  await document.save();
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
<title>Configure System</title>
</head>
<body>
  <header class="page-head">
    <h1>Configure System</h1>
    <p class="lede" id="lede"></p>
  </header>
  <nav class="tabs" id="tabs">
    <button type="button" data-tab="machine">Machine</button>
    <button type="button" data-tab="hardware">Hardware</button>
    <button type="button" data-tab="region">Region</button>
    <button type="button" data-tab="facts">Facts</button>
    <button type="button" data-tab="save">Save</button>
  </nav>
  <p class="notice" id="notice" hidden></p>
  <section class="block" id="pane-machine">
    <label class="field-label" for="target">Machine</label>
    <select id="target"></select>
  </section>
  <section class="block" id="pane-hardware">
    <div class="field">
      <label class="field-label" for="profile">Preset</label>
      <select id="profile"></select>
    </div>
    <div id="options"></div>
  </section>
  <section class="block" id="pane-region">
    <label class="field-label" for="region">Region</label>
    <select id="region">
      <option value="ntsc">NTSC — US/Japan, 60Hz</option>
      <option value="pal">PAL — Europe, 50Hz</option>
    </select>
    <p class="none" id="region-note"></p>
  </section>
  <section class="block" id="pane-facts">
    <div id="facts"></div>
  </section>
  <section class="block" id="pane-save">
    <label class="field-label" for="name">Name</label>
    <input id="name" type="text" spellcheck="false">
    <label class="field-label" for="layer">Save as</label>
    <select id="layer"></select>
    <p class="none" id="save-note"></p>
    <button class="wide" id="save">Save system</button>
    <button class="link" id="open-config">Open 8bitscript.config.ts</button>
  </section>
  <script nonce="${nonce}">${HARDWARE_JS}</script>
  <script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import('./runner.cjs').Projects} projects
 */
function registerSystemView(context, projects) {
  context.subscriptions.push(
    vscode.commands.registerCommand('8bitscript.configureSystem', async () => {
      if (open) {
        open.panel.reveal(vscode.ViewColumn.Active);
        await open.hydrate();
        await open.post();
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        '8bitscript.system',
        'Configure System',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const view = new SystemPanel(panel, projects);
      const subscriptions = [
        panel.webview.onDidReceiveMessage((message) => view.apply(message)),
        projects.onDidChange(() => view.post()),
        vscode.workspace.onDidChangeConfiguration((event) => {
          if (settings.affectsAny(event)) view.post();
        }),
      ];
      panel.webview.html = html(panel.webview);
      panel.onDidDispose(() => {
        for (const subscription of subscriptions) subscription.dispose();
        open = null;
      });
      open = view;
    }),
  );
}

module.exports = { registerSystemView };
