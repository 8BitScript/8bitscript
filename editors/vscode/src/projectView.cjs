// Project details: an editor tab for one 8BitScript project (or the
// monorepo install root). Path, config, entry, targets, advertised vs
// personal systems, package manager, `@8bitscript/*` versions, and the
// local-checkout toggle. The page holds no state.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const vscode = require('vscode');

const { labelOf, whereLabel } = require('./runner.cjs');
const settings = require('./settings.cjs');
const { eightBitScriptVersions, lockfileFor, toolchainLabel } = require('./projectInfo.cjs');
const { isCheckout, resolveCheckoutRoot } = require('./checkout.cjs');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'project.css'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'project.js'), 'utf8');

let open = null;

class ProjectPanel {
  /** @param {import('./runner.cjs').Projects} projects */
  constructor(panel, projects) {
    this.panel = panel;
    this.projects = projects;
    this.dir = settings.getProject();
  }

  selected() {
    const all = this.projects.all;
    return all.find((entry) => entry.dir === this.dir)
      ?? all.find((entry) => entry.dir === settings.getProject())
      ?? this.projects.visible[0] ?? all[0] ?? null;
  }

  async apply(message) {
    switch (message?.type) {
      case 'ready':
        await this.post();
        return;
      case 'command':
        await this.command(message);
        return;
      default:
    }
  }

  async command(message) {
    const project = this.selected();
    const allowed = [
      '8bitscript.install',
      '8bitscript.refresh',
      '8bitscript.useLocal',
      '8bitscript.usePublished',
      '8bitscript.openConfig',
      '8bitscript.openEntry',
      '8bitscript.configureSystem',
    ];
    if (!allowed.includes(message.id)) return;
    await vscode.commands.executeCommand(message.id, { project });
    await this.post();
  }

  async post() {
    const project = this.selected();
    const targets = await this.projects.loadTargets(project?.dir);
    if (!this.panel) return;
    const checkout = this.projects.checkoutFlag();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const available = resolveCheckoutRoot({
      folders,
      setting: settings.getCheckout() || null,
      managed: this.projects.managedDir,
    });
    const versions = project ? eightBitScriptVersions(project.dir) : {};
    const published = versions['@8bitscript/cli'] ?? Object.values(versions)[0] ?? null;
    const lock = project ? lockfileFor(project.dir) : null;
    const systems = (targets?.systems ?? []).map((system) => ({
      name: system.name,
      target: system.target,
      origin: system.origin,
      label: system.label,
    }));
    this.panel.webview.postMessage({
      type: 'state',
      empty: !project,
      name: project ? labelOf(project) : '',
      where: project ? whereLabel(project) : '',
      dir: project?.dir ?? '',
      config: project ? path.basename(project.configPath) : '',
      entry: project ? path.relative(project.dir, project.entry) : '',
      targets: project?.targets ?? [],
      systems,
      packageManager: project?.packageManager ?? 'pnpm',
      lockfile: lock ? path.basename(lock.file) : '',
      installed: project ? project.installed : true,
      versions,
      checkout: checkout && isCheckout(checkout) ? checkout : null,
      checkoutAvailable: Boolean(available),
      toolchain: toolchainLabel({ checkout, publishedVersion: published }),
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
<style nonce="${nonce}">${CSS}</style>
<title>Project</title>
</head>
<body>
  <header class="page-head">
    <h1 id="title">Project</h1>
    <p class="lede" id="lede"></p>
  </header>
  <p class="notice" id="notice" hidden></p>
  <section class="block">
    <h2 class="section-label">This project</h2>
    <div class="kv" id="meta"></div>
  </section>
  <section class="block">
    <h2 class="section-label">Systems</h2>
    <div id="systems"></div>
  </section>
  <section class="block">
    <h2 class="section-label">Packages</h2>
    <div class="kv" id="packages"></div>
    <div class="row-actions">
      <button class="wide secondary" id="install">Install</button>
      <button class="wide secondary" id="refresh">Refresh</button>
      <button class="wide secondary" id="use-local">Use local 8BitScript</button>
      <button class="wide secondary" id="use-published">Use published packages</button>
    </div>
  </section>
  <div class="hint">
    <button class="link" id="open-config">Open 8bitscript.config.ts</button>
    <button class="link" id="open-entry">Open entry file</button>
    <button class="link" id="configure">Configure System</button>
  </div>
  <script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import('./runner.cjs').Projects} projects
 */
function registerProjectView(context, projects) {
  context.subscriptions.push(
    vscode.commands.registerCommand('8bitscript.showProject', async (node) => {
      const dir = node?.project?.dir ?? node?.dir ?? settings.getProject();
      if (open) {
        open.dir = dir;
        open.panel.reveal(vscode.ViewColumn.Active);
        await open.post();
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        '8bitscript.project',
        'Project',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const view = new ProjectPanel(panel, projects);
      view.dir = dir;
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

module.exports = { registerProjectView };
