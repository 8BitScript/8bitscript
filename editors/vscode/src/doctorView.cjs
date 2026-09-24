// The Doctor panel: which emulators `8bs doctor` should manage and
// install. Default is all of them. The page holds no state — toggling
// a box writes `8bitscript.doctorEmulators` and the host posts the list
// back. Building never needs an emulator. Install selected (and Run
// doctor) start `8bs doctor --install` for the checked set.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const vscode = require('vscode');

const {
  ALL_DOCTOR_EMULATOR_IDS, DOCTOR_EMULATORS, installersForTargets,
} = require('./projects.cjs');
const settings = require('./settings.cjs');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'doctor.css'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'doctor.js'), 'utf8');

let open = null;

function statusFor(emu, doctor) {
  if (!doctor) return null;
  const machines = emu.machines ?? [];
  if (machines.some((id) => doctor.failed?.includes(id))) return 'broken';
  if (machines.some((id) => doctor.notInstalled?.includes(id))) return 'missing';
  if (machines.some((id) => doctor.ready?.includes(id))) return 'ready';
  return null;
}

class DoctorPanel {
  /** @param {import('./runner.cjs').Projects} projects */
  constructor(panel, projects) {
    this.panel = panel;
    this.projects = projects;
  }

  async apply(message) {
    switch (message?.type) {
      case 'ready':
        await this.post();
        return;
      case 'toggle':
        await this.toggle(message.id, Boolean(message.checked));
        return;
      case 'all':
        await settings.setDoctorEmulators(null);
        await this.post();
        return;
      case 'none':
        await settings.setDoctorEmulators([]);
        await this.post();
        return;
      case 'project':
        await this.projectOnly();
        return;
      case 'run':
        await vscode.commands.executeCommand('8bitscript.doctor');
        return;
      case 'install':
        await vscode.commands.executeCommand('8bitscript.doctor');
        return;
      default:
    }
  }

  async toggle(id, checked) {
    if (!ALL_DOCTOR_EMULATOR_IDS.includes(id)) return;
    const current = settings.getDoctorEmulators() ?? ALL_DOCTOR_EMULATOR_IDS;
    const next = checked
      ? [...current, id]
      : current.filter((key) => key !== id);
    await settings.setDoctorEmulators(next);
    await this.post();
  }

  async projectOnly() {
    const chosen = settings.getProject();
    const project = this.projects.all.find((entry) => entry.dir === chosen)
      ?? this.projects.visible[0]
      ?? this.projects.all[0]
      ?? null;
    await settings.setDoctorEmulators(installersForTargets(project?.targets ?? []));
    await this.post();
  }

  async post() {
    const selected = settings.getDoctorEmulators();
    const doctor = await this.projects.loadDoctor?.();
    if (!this.panel) return;
    this.panel.webview.postMessage({
      type: 'state',
      selected,
      total: ALL_DOCTOR_EMULATOR_IDS.length,
      emulators: DOCTOR_EMULATORS.map((emu) => ({
        ...emu,
        status: statusFor(emu, doctor),
      })),
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
<title>Doctor</title>
</head>
<body>
  <header class="page-head">
    <h1>Doctor</h1>
    <p class="lede" id="lede">Which emulators 8bs doctor should manage and install. Default is all of them. Building never needs an emulator. Install selected runs the package-manager plans for the checked set — no prompt, because a task terminal is not a TTY.</p>
  </header>
  <p class="count" id="count"></p>
  <div class="row-actions">
    <button class="wide" id="install-selected">Install selected</button>
    <button class="wide secondary" id="run">Run doctor</button>
    <button class="wide secondary" id="all">Check all</button>
    <button class="wide secondary" id="project">This project</button>
    <button class="wide secondary" id="none">Check none</button>
  </div>
  <div id="list"></div>
  <p class="none" id="note">Each checked emulator is installed with Homebrew, apt, pacman/AUR, or <code>8bs setup</code>. Caprice32 and Vecx have no macOS package; Fuse is the <code>fredm-fuse</code> cask (never <code>brew install fuse</code>). SameBoy is a cask that installs SameBoy.app.</p>
  <script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import('./runner.cjs').Projects} projects
 */
function registerDoctorView(context, projects) {
  context.subscriptions.push(
    vscode.commands.registerCommand('8bitscript.doctorSetup', async () => {
      if (open) {
        open.panel.reveal(vscode.ViewColumn.Active);
        await open.post();
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        '8bitscript.doctorSetup',
        'Doctor',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const view = new DoctorPanel(panel, projects);
      const subscriptions = [
        panel.webview.onDidReceiveMessage((message) => view.apply(message)),
        projects.onDidChange(() => view.post()),
        vscode.workspace.onDidChangeConfiguration((event) => {
          if (event.affectsConfiguration('8bitscript.doctorEmulators')) view.post();
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

module.exports = { registerDoctorView, statusFor };
