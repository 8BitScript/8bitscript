// The 8BitScript side bar: package status plus named-system quick launch.
//
// Hardware fitting and project details are editor tabs (systemView,
// projectView) — Controller Setup is the template. The hardware matrix
// used to live in a disclosure here; it does not any more.
//
// Studio, Doctor and Refresh are icons in the view's title bar rather than
// buttons in the page, which is where an editor puts a view's actions; the
// palette has them too. What is running is a Running machines tree at the
// bottom: a run expands to the compile's own size breakdown and the
// hardware it launched, with a Stop on each row.
//
// The panel holds no state. Every choice is written straight to the
// extension's settings (settings.cjs) and read back, so what the page
// shows and what a run does cannot disagree, and Run here runs exactly the
// `8bs run` line the hint at the bottom prints.
//
// The page itself lives in media/launcher.{css,js} and is read in here. It
// used to be inlined in this file as a template literal; `\n` inside that
// template became a real newline in the generated script, which failed to
// parse, so every dropdown that is filled from JS stayed empty.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const vscode = require('vscode');

const {
  ALL_TARGETS, MACHINE_TARGETS, NO_BARE_EMULATOR, byKind, commandArgs,
} = require('./projects.cjs');
const { labelOf, whereLabel } = require('./runner.cjs');
const settings = require('./settings.cjs');
const {
  effectiveFacts, matchesSystem, selectionLabel,
} = require('./hardwareCatalog.cjs');
const { machineTree, readLastRun, rowKey } = require('./runningMachines.cjs');
const { resolveCheckoutRoot } = require('./checkout.cjs');
const { installRoots } = require('./projectInfo.cjs');

const VIEW_ID = '8bitscript.launcher';
const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'launcher.css'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'launcher.js'), 'utf8');

class LauncherViewProvider {
  /**
   * @param {import('./runner.cjs').Projects} projects
   * @param {ReturnType<import('./devReload.cjs').registerDevReload> | null} [devReload]
   */
  constructor(projects, devReload) {
    this.projects = projects;
    this.devReload = devReload ?? null;
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
    if (this.devReload) subscriptions.push(this.devReload.onDidChange(() => this.post()));
    view.onDidDispose(() => {
      for (const subscription of subscriptions) subscription.dispose();
      this.view = undefined;
    });

    this.post();
  }

  /**
   * The project the panel acts on: the chosen one, or the first offered.
   * `all` rebuilds the shipped list on every read, so a caller that already
   * has it passes it in.
   */
  selectedProject(all = this.projects.all) {
    const chosen = settings.getProject();
    return all.find((project) => project.dir === chosen)
      ?? this.projects.visible[0] ?? all[0] ?? null;
  }

  async apply(message) {
    switch (message?.type) {
      case 'ready':
        await this.post();
        return;
      case 'launch': {
        const project = this.selectedProject();
        if (!project) return;
        const commandId = { build: '8bitscript.build', boot: '8bitscript.boot' }[message.action] ?? '8bitscript.run';
        await vscode.commands.executeCommand(commandId, {
          project,
          target: settings.getSystem(),
          system: settings.getNamedSystem() || undefined,
        });
        return;
      }
      case 'stop':
        await vscode.commands.executeCommand('8bitscript.stop', { dir: message.dir, target: message.target });
        return;
      case 'reloadWindow':
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
        return;
      case 'rebuildExtension':
        await vscode.commands.executeCommand('8bitscript.rebuildExtension');
        return;
      case 'command':
        // Only the ids the page can name, so a message cannot run anything else.
        if ([
          '8bitscript.refresh', '8bitscript.doctor', '8bitscript.install',
          '8bitscript.openEntry', '8bitscript.openConfig',
          '8bitscript.showProject', '8bitscript.configureSystem',
          '8bitscript.useLocal', '8bitscript.usePublished',
          '8bitscript.openStudio', '8bitscript.openStudioTab',
        ].includes(message.id)) {
          const project = this.selectedProject();
          await vscode.commands.executeCommand(message.id, {
            project,
            dir: message.dir,
            name: message.name,
            packageManager: message.packageManager,
            toolchain: message.toolchain,
            // Open Studio's sliver menu: the system to open it on.
            system: message.system,
          });
        }
        return;
      case 'set':
        await this.set(message);
        return;
      default:
    }
  }

  /** One of the selected project's systems, by name, or null for a machine id. */
  async namedSystem(name) {
    const targets = await this.projects.loadTargets(this.selectedProject()?.dir);
    return targets?.systems?.find((system) => system.name === name) ?? null;
  }

  /** Fit a whole system: its machine, its region, and its hardware, in one write. */
  async applySystem(system) {
    await settings.setNamedSystem(system.name);
    await settings.setSystem(system.target);
    if (system.region) await settings.setRegion(system.region);
    await settings.setHardware(system.target, {
      profile: system.profile ?? null,
      options: system.hardware ?? {},
    });
  }

  async set(message) {
    switch (message.key) {
      case 'project': {
        await settings.setProject(message.value);
        // Picking a project loads what it is set up for: the first of its
        // systems, hardware and region and all. A project with none keeps
        // the current machine when it targets it, and takes its first
        // otherwise — the panel never leaves a machine selected that the
        // project cannot be run on.
        const project = this.projects.all.find((p) => p.dir === message.value);
        if (!project) break;
        const targets = await this.projects.loadTargets(project.dir);
        const first = targets?.systems?.[0];
        if (first) await this.applySystem(first);
        else {
          await settings.setNamedSystem('');
          if (!project.targets.includes(settings.getSystem())) {
            await settings.setSystem(project.targets[0] ?? settings.getSystem());
          }
        }
        break;
      }
      case 'system': {
        // One dropdown, two kinds of entry: a machine on its own, or a
        // whole machine the project has been set up for, which sets the
        // hardware and the region with it.
        const system = await this.namedSystem(message.value);
        if (system) {
          await this.applySystem(system);
        } else if (ALL_TARGETS.includes(message.value)) {
          await settings.setNamedSystem('');
          await settings.setSystem(message.value);
        }
        break;
      }
      default:
    }
  }

  /** Push the current settings to the page; it never keeps its own copy. */
  async post() {
    if (!this.view) return;
    const system = settings.getSystem();
    const named = settings.getNamedSystem();
    const all = this.projects.all;
    const project = this.selectedProject(all);
    const offered = this.projects.visible;
    const listed = project && !offered.includes(project) ? [...offered, project] : offered;
    const targets = await this.projects.loadTargets(project?.dir);
    if (!this.view) return;
    const target = targets?.get(system) ?? null;
    const selection = settings.getEffectiveHardware(system, target);
    const region = settings.getRegion();
    const machine = MACHINE_TARGETS.has(system);
    const bootable = !NO_BARE_EMULATOR.has(system);
    const runnable = Boolean(project?.targets.includes(system) && project.toolchain);
    const fitted = named
      ? (targets?.systems ?? []).find((entry) => entry.name === named)
      : (targets?.systems ?? []).find((entry) => entry.target === system && matchesSystem(entry, target, selection, region));
    const extras = {
      system: fitted?.name || named || undefined,
      checkout: this.projects.checkoutFlag() || undefined,
    };
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const setting = settings.getCheckout() || null;
    const resolved = resolveCheckoutRoot({
      folders,
      setting,
      managed: this.projects.managedDir,
    });
    const systems = systemOptions(targets, project);
    const postedSystem = selectedSystemId(fitted, named, system);
    const studio = await studioOptions(this.projects, all);
    if (!this.view) return;
    this.view.webview.postMessage({
      type: 'state',
      packages: packageRows({
        folders,
        setting,
        managed: this.projects.managedDir,
        projects: this.projects.projects,
      }),
      projects: projectOptions(listed),
      project: project?.dir ?? '',
      projectLabel: project ? labelOf(project) : '',
      installed: project ? project.installed : true,
      packageManager: project?.packageManager ?? 'pnpm',
      systems,
      system: postedSystem,
      studio,
      systemTitle: fitted?.name ?? target?.title ?? system,
      region,
      regionLabel: machine ? settings.regionShort(region) : '',
      machine,
      bootable,
      runnable,
      warning: [
        warningFor(project, system),
        shortfall(targets, target, selection),
        targets?.systemsError,
        targets?.requiresError,
      ].filter(Boolean).join('  ') || null,
      fitted: selectionLabel(selection) || 'stock machine',
      subtitle: fitted
        ? [target?.title ?? system, selectionLabel(selection) || 'stock machine']
          .concat(machine ? [settings.regionShort(region)] : []).join(' · ')
        : null,
      checkout: extras.checkout ?? null,
      checkoutAvailable: Boolean(resolved),
      running: this.runningRows(all),
      devReload: {
        phase: this.devReload?.phase ?? 'idle',
        error: this.devReload?.error ?? null,
      },
      command: `8bs ${commandArgs('run', system, region, extras.system ? undefined : selection, extras).concat(
        system === 'web' ? ['--port', '0'] : [],
        system === 'web' && !settings.getWebLan() ? ['--local'] : [],
        system === 'cx16' ? settings.cx16NativeWindowCliArgs() : [],
      ).join(' ')}`,
    });
  }

  /** What is running, named the way the panel's rows read. */
  runningRows(all) {
    return this.projects.running.list().map((row) => {
      const project = all.find((p) => p.dir === row.dir);
      const report = row.target ? readLastRun(row.dir, row.target) : null;
      const live = this.projects.live.get(rowKey(row.dir, row.target)) ?? null;
      return {
        dir: row.dir,
        target: row.target,
        command: row.command,
        label: project ? labelOf(project) : path.basename(row.dir || '8bs'),
        detail: row.target ? `${row.command} · ${row.target}` : row.command,
        machine: machineTree(row, report, live),
      };
    });
  }
}

/**
 * The program dropdown's entries, grouped into Programs / Examples / Apps.
 */
function projectOptions(projects) {
  const entry = (project) => ({
    id: project.dir,
    label: labelOf(project),
    where: whereLabel(project),
  });
  const sections = byKind(projects);
  if (!sections) return projects.map(entry);
  const options = [];
  for (const { label, projects: group } of sections) {
    options.push({ group: label });
    for (const project of group) options.push(entry(project));
  }
  return options;
}

/**
 * The System dropdown's selected value. A named system's name when one is
 * fitted or chosen; otherwise the bare machine id. `named` is stored as
 * '' when nothing named is selected, so empty must fall through — `??`
 * would keep '' and the page would select its first option (pet).
 *
 * @param {{ name: string } | null | undefined} fitted
 * @param {string} named
 * @param {string} machine
 */
function selectedSystemId(fitted, named, machine) {
  return fitted?.name || named || machine;
}

/**
 * The System dropdown's entries. A project whose config declares a
 * `systems` block gets those first, in a group of their own — one choice
 * that fits the machine, its hardware and its region together — with the
 * bare machines under them for anything the block does not cover. A
 * project with no block gets the machine list it always had.
 *
 * A system's id is its name, which cannot collide with a machine id: the
 * CLI would have refused a target it did not recognize long before here.
 */
/**
 * The Studio button's sliver menu: the same list the System chooser
 * below offers, built for Studio — its named systems by origin, then the
 * bare machines — so a pick launches Studio there and then. Null when
 * Studio is not installed, and the page says so.
 */
async function studioOptions(projects, all) {
  const studio = all.find((p) => p.kind === 'app' && p.name === '@8bitscript/studio');
  if (!studio) return null;
  const targets = await projects.loadTargets(studio.dir);
  // First in the menu: the editor's own tab, which only the X16 can fill
  // (the one machine with a WebAssembly emulator — `8bs run cx16 --web`).
  // `command` names what a pick runs; every other entry runs openStudio.
  return {
    systems: [
      { group: 'In an editor tab' },
      { id: 'tab', command: '8bitscript.openStudioTab', label: 'Commander X16', where: 'x16emu in the editor', machine: true, runnable: studio.targets.includes('cx16') },
      ...systemOptions(targets, studio),
    ],
  };
}

function systemOptions(targets, project) {
  const machines = ALL_TARGETS.map((id) => ({
    id,
    machine: MACHINE_TARGETS.has(id),
    label: targets?.get(id)?.title ? `${id} — ${targets.get(id).title}` : id,
    runnable: Boolean(project?.targets.includes(id)),
  }));
  const systems = targets?.systems ?? [];
  if (systems.length === 0) return machines;
  const groups = [
    ['project', 'This clone'],
    ['user', 'This machine'],
    ['advertised', 'Advertised'],
  ];
  const options = [];
  for (const [origin, label] of groups) {
    const rows = systems.filter((system) => system.origin === origin);
    if (rows.length === 0) continue;
    options.push({ group: label });
    for (const system of rows) {
      options.push({
        id: system.name,
        machine: MACHINE_TARGETS.has(system.target),
        label: system.name,
        where: system.label === 'stock' ? system.target : `${system.target} · ${system.label}`,
        runnable: Boolean(project?.targets.includes(system.target)),
        short: (system.unmet ?? []).length > 0,
      });
    }
  }
  options.push({ group: 'Machines' }, ...machines);
  return options;
}

/**
 * The rows the packages block shows: only a root that needs installing.
 * The view's title already says 8BitScript, and a row that only offers
 * an update nobody asked for is a row to read past; the palette's
 * "8BitScript: Install Dependencies" updates on request.
 */
function packageRows({ folders, setting, managed, projects }) {
  return installRoots({ folders, setting, managed, projects }).filter((status) => !status.installed).map((status) => ({
    dir: status.dir,
    kind: status.kind,
    label: status.label,
    detail: status.detail,
    packageManager: status.packageManager,
    installed: status.installed,
    action: status.action,
  }));
}

/**
 * What this machine, fitted this way, gives the program less of than it
 * asked for — the config's `requires` block, checked against the sheet the
 * build will resolve to. The same answer `8bs build` refuses with, said
 * before the build rather than after it.
 *
 * Run is not greyed out for it: the build is the authority, and a fact
 * sheet the panel computed is a good enough reason to warn and not a good
 * enough reason to refuse.
 */
function shortfall(targets, target, selection) {
  const requires = Object.entries(targets?.requires ?? {});
  if (requires.length === 0 || !target) return null;
  const facts = effectiveFacts(target, selection);
  const unmet = requires.filter(([key, need]) => (need === true ? facts[key] !== true : (facts[key] ?? 0) < need));
  if (unmet.length === 0) return null;
  return `This machine gives less than the program asks for: ${unmet
    .map(([key, need]) => `${key} needs ${need === true ? 'it' : need}, has ${facts[key] === true ? 'it' : facts[key] ?? 0}`)
    .join('; ')}.`;
}

/** Why Run is greyed out, in the words the panel shows instead of the command line. */
function warningFor(project, system) {
  if (!project) return 'No project here yet. A project is a directory with an 8bitscript.config.ts in it.';
  if (!project.targets.includes(system)) return `${labelOf(project)} does not target ${system}.`;
  if (!project.toolchain) return `No 8bs toolchain for ${labelOf(project)}. Run ${project.packageManager} install.`;
  return null;
}

// Codicon shapes, inline rather than the codicon font: a webview does not
// get the editor's icon font for free, and four paths are cheaper than
// shipping one.
const ICONS = {
  play: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 2.5v11l9-5.5-9-5.5z"/></svg>',
  build: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 1a4 4 0 0 0-3.8 5.2L1.4 11a1.4 1.4 0 0 0 2 2l4.8-4.8A4 4 0 1 0 10 1zm0 1.5c.4 0 .8.1 1.1.3L9.3 4.6l1.1 1.1 1.8-1.8A2.5 2.5 0 0 1 10 7.5c-.4 0-.8-.1-1.1-.3l-.6-.3-5 5a.4.4 0 0 1-.5-.5l5-5-.3-.6A2.5 2.5 0 0 1 10 2.5z"/></svg>',
  file: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.5 1H3.8C3.4 1 3 1.4 3 1.9v12.2c0 .5.4.9.8.9h8.4c.4 0 .8-.4.8-.9V4.8L9.5 1zm0 1.6L11.9 5H9.5V2.6zM4 14V2h4.5v3.5c0 .3.2.5.5.5h3v8H4z"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 4h8v8H4z"/></svg>',
  // A small down-pointing chevron: the sliver on a split button.
  chevron: '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M2.5 5.5 8 11l5.5-5.5-1.4-1.4L8 8.2 3.9 4.1z"/></svg>',
  // Studio: a screen on a stand, with a brush across it — the asset
  // editor, as opposed to `play`'s run of the project.
  studio: '<svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M1.5 2h13a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H9v1.5h2.5V14h-7v-1.5H7V11H1.5a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5zM2 3v7h12V3H2zm8.6 1.2 1.2 1.2-3.6 3.6-1.6.4.4-1.6 3.6-3.6z"/></svg>',
  // A bare chip: the body, and pins — the hardware with nothing running on
  // it yet, as opposed to `build`'s wrench (turning source into bytes).
  chip: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 1h1v2H5V1zm5 0h1v2h-1V1zM5 13h1v2H5v-2zm5 0h1v2h-1v-2zM1 5h2v1H1V5zm0 5h2v1H1v-1zm12-5h2v1h-2V5zm0 5h2v1h-2v-1zM4 4h8v8H4V4z"/></svg>',
};

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
  <div class="dev-reload" id="dev-reload" hidden>
    <p class="notice" id="dev-reload-msg"></p>
    <button class="wide secondary" id="rebuild-extension" hidden>Rebuild the local extension</button>
    <button class="wide" id="reload-window" hidden>Reload this window</button>
  </div>

  <section class="packages" id="packages-block" hidden>
    <div id="package-rows"></div>
  </section>

  <section class="studio-block">
    <h2 class="section-label">Studio</h2>
    <div class="split">
      <button class="launch studio" id="studio" title="Open Studio — the asset editor that ships with the toolchain — on the Commander X16, the machine it is designed on; not a run of this project">
        ${ICONS.studio}
        <span class="launch-text">
          <span class="launch-title">Open Studio</span>
          <span class="launch-sub" id="studio-sub">on the Commander X16</span>
        </span>
      </button>
      <button class="launch studio-more" id="studio-more" title="Open Studio on another system" aria-haspopup="menu" aria-expanded="false">${ICONS.chevron}</button>
    </div>
    <div class="menu" id="studio-menu" role="menu" hidden></div>
  </section>

  <section class="launch-block">
    <h2 class="section-label">Quick launch</h2>
    <div class="fields" id="fields">
      <div class="field">
        <label class="field-label" for="project">Program</label>
        <div class="control">
          <select id="project" title="The program Run and Build act on"></select>
          <button class="icon" id="details" title="Show project details">${ICONS.file}</button>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="system">System</label>
        <select id="system" title="A named system, or a bare machine"></select>
      </div>
    </div>
    <button class="link fitted" id="fitted" title="Open the system builder"></button>
    <button class="launch" id="run" title="Run this project on the selected system">
      ${ICONS.play}
      <span class="launch-text">
        <span class="launch-title" id="run-title">Run</span>
        <span class="launch-sub" id="run-sub"></span>
      </span>
    </button>
    <p class="notice" id="notice" hidden></p>
    <div class="control launch-actions">
      <button class="wide secondary" id="build" title="Build this project for the selected system">${ICONS.build} Build</button>
      <button class="wide secondary" id="boot" title="Boot the selected system's emulator with nothing loaded — just the hardware">
        ${ICONS.chip} <span id="boot-label">Boot</span>
      </button>
      <button class="icon" id="open" title="Open this project's entry file">${ICONS.file}</button>
    </div>
  </section>

  <section class="running" id="running" hidden>
    <h2 class="section-label">Running machines</h2>
    <div id="running-rows"></div>
  </section>

  <div class="hint" id="hint"></div>
  <script nonce="${nonce}">const ICON_STOP = ${JSON.stringify(ICONS.stop)};</script>
  <script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import('./runner.cjs').Projects} projects
 * @param {ReturnType<import('./devReload.cjs').registerDevReload> | null} [devReload]
 */
function registerLauncherView(context, projects, devReload) {
  const provider = new LauncherViewProvider(projects, devReload);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  return provider;
}

module.exports = { registerLauncherView, selectedSystemId };
