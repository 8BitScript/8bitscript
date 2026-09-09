// The 8BitScript side bar: one launcher panel, and nothing else.
//
// It replaces the two views this side bar used to have — a Run Settings
// webview stacked on a Projects tree. The tree could show a project three
// different ways and hung nine commands off its rows; the panel above it
// had grown to five dropdowns and a fact sheet. Between them they answered
// a question nobody asks in a side bar. The question people do ask is
// "run this", so that is what this is.
//
// The order down the panel is how often a thing is touched. One loud
// button that runs the selected project on the selected machine; **the
// machine** directly under it, because that is what changes between two
// runs of the same program; then the project, which changes less. Build is
// an icon on the project's own row rather than a second big button — it is
// the occasional action, and it belongs beside the thing it builds.
// Everything else — the region, the hardware fitted to the machine, the
// facts a program can rely on — is folded away behind one disclosure.
//
// Studio, Doctor and Refresh are icons in the view's title bar rather than
// buttons in the page, which is where an editor puts a view's actions; the
// palette has them too. What is running is a section at the bottom with a
// Stop on each row — a launcher that cannot stop what it launched is only
// half of one.
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
  ALL_TARGETS, MACHINE_TARGETS, byKind, commandArgs,
} = require('./projects.cjs');
const { labelOf, whereLabel } = require('./runner.cjs');
const settings = require('./settings.cjs');
const {
  effectiveFacts, effectiveOptions, matchesSystem, selectionLabel,
} = require('./hardwareCatalog.cjs');

const VIEW_ID = '8bitscript.launcher';
const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'launcher.css'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'launcher.js'), 'utf8');

class LauncherViewProvider {
  /** @param {import('./runner.cjs').Projects} projects */
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
        await vscode.commands.executeCommand(
          message.action === 'build' ? '8bitscript.build' : '8bitscript.run',
          { project, target: settings.getSystem() },
        );
        return;
      }
      case 'stop':
        await vscode.commands.executeCommand('8bitscript.stop', { dir: message.dir, target: message.target });
        return;
      case 'command':
        // Only the ids the page can name, so a message cannot run anything else.
        if (['8bitscript.refresh', '8bitscript.doctor', '8bitscript.install', '8bitscript.openEntry', '8bitscript.openConfig'].includes(message.id)) {
          await vscode.commands.executeCommand(message.id, { project: this.selectedProject() });
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
        else if (!project.targets.includes(settings.getSystem())) {
          await settings.setSystem(project.targets[0] ?? settings.getSystem());
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
          await settings.setSystem(message.value);
        }
        break;
      }
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
      case 'stock':
        await settings.setHardware(settings.getSystem(), { profile: null, options: {} });
        break;
      default:
    }
  }

  /** Push the current settings to the page; it never keeps its own copy. */
  async post() {
    if (!this.view) return;
    const system = settings.getSystem();
    const all = this.projects.all;
    const project = this.selectedProject(all);
    // The picker lists what is on offer, plus whatever is selected: hiding
    // the examples while one of them is chosen must not leave the picker
    // showing nothing.
    const offered = this.projects.visible;
    const listed = project && !offered.includes(project) ? [...offered, project] : offered;
    // Asked in the selected project's directory: the hardware it fits its
    // targets with is in its own 8bs.config.ts, not the toolchain's
    // catalog, so the panel's stock machine is that project's.
    const targets = await this.projects.loadTargets(project?.dir);
    if (!this.view) return;
    const target = targets?.get(system) ?? null;
    // Nothing stored fits the machine's worst RAM config, not its catalog
    // stock, so the panel shows the same machine a Run actually uses.
    const selection = settings.getEffectiveHardware(system, target);
    const region = settings.getRegion();
    const machine = MACHINE_TARGETS.has(system);
    const runnable = Boolean(project?.targets.includes(system) && project.toolchain);
    // The system the panel is *on*, when what is selected is exactly one
    // of the project's — then the button names it instead of spelling the
    // machine and its hardware out.
    const fitted = (targets?.systems ?? [])
      .find((entry) => entry.target === system && matchesSystem(entry, target, selection, region));
    this.view.webview.postMessage({
      type: 'state',
      projects: projectOptions(listed),
      project: project?.dir ?? '',
      projectLabel: project ? labelOf(project) : '',
      installed: project ? project.installed : true,
      packageManager: project?.packageManager ?? 'pnpm',
      systems: systemOptions(targets, project),
      system: fitted?.name ?? system,
      systemTitle: fitted?.name ?? target?.title ?? system,
      region,
      regionLabel: machine ? settings.regionShort(region) : '',
      machine,
      runnable,
      // Both, when both: a broken `systems` block does not stop a run,
      // and the reason a run is stopped is not the block.
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
      hardware: hardwareState(target, targets, selection),
      running: this.runningRows(all),
      command: `8bs ${commandArgs('run', system, region, selection).join(' ')}`,
    });
  }

  /** What is running, named the way the panel's rows read. */
  runningRows(all) {
    return this.projects.running.list().map((row) => {
      const project = all.find((p) => p.dir === row.dir);
      return {
        dir: row.dir,
        target: row.target,
        label: project ? labelOf(project) : path.basename(row.dir || '8bs'),
        detail: row.target ? `${row.command} · ${row.target}` : row.command,
      };
    });
  }
}

/**
 * The project dropdown's entries, grouped into Projects / Examples / Apps
 * when the list holds more than one kind. The examples used to be behind a
 * checkbox because they crowded a tree; a group in a dropdown costs the
 * rest of the list nothing, so they are simply always there.
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
 * The System dropdown's entries. A project whose config declares a
 * `systems` block gets those first, in a group of their own — one choice
 * that fits the machine, its hardware and its region together — with the
 * bare machines under them for anything the block does not cover. A
 * project with no block gets the machine list it always had.
 *
 * A system's id is its name, which cannot collide with a machine id: the
 * CLI would have refused a target it did not recognise long before here.
 */
function systemOptions(targets, project) {
  const machines = ALL_TARGETS.map((id) => ({
    id,
    machine: MACHINE_TARGETS.has(id),
    label: targets?.get(id)?.title ? `${id} — ${targets.get(id).title}` : id,
    runnable: Boolean(project?.targets.includes(id)),
  }));
  const systems = targets?.systems ?? [];
  if (systems.length === 0) return machines;
  return [
    { group: 'This project' },
    ...systems.map((system) => ({
      id: system.name,
      machine: MACHINE_TARGETS.has(system.target),
      label: system.name,
      where: system.label === 'stock' ? system.target : `${system.target} · ${system.label}`,
      runnable: Boolean(project?.targets.includes(system.target)),
      // A system the program asks more of than it gives is still listed —
      // it is in the config — but it is listed as short, so the choice is
      // made with the answer rather than at the build's expense.
      short: (system.unmet ?? []).length > 0,
    })),
    { group: 'Machines' },
    ...machines,
  ];
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
  if (!project) return 'No project here yet. A project is a directory with an 8bs.config.ts in it.';
  if (!project.targets.includes(system)) return `${labelOf(project)} does not target ${system}.`;
  if (!project.toolchain) return `No 8bs toolchain for ${labelOf(project)}. Run ${project.packageManager} install.`;
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

// Codicon shapes, inline rather than the codicon font: a webview does not
// get the editor's icon font for free, and four paths are cheaper than
// shipping one.
const ICONS = {
  play: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 2.5v11l9-5.5-9-5.5z"/></svg>',
  build: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 1a4 4 0 0 0-3.8 5.2L1.4 11a1.4 1.4 0 0 0 2 2l4.8-4.8A4 4 0 1 0 10 1zm0 1.5c.4 0 .8.1 1.1.3L9.3 4.6l1.1 1.1 1.8-1.8A2.5 2.5 0 0 1 10 7.5c-.4 0-.8-.1-1.1-.3l-.6-.3-5 5a.4.4 0 0 1-.5-.5l5-5-.3-.6A2.5 2.5 0 0 1 10 2.5z"/></svg>',
  file: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.5 1H3.8C3.4 1 3 1.4 3 1.9v12.2c0 .5.4.9.8.9h8.4c.4 0 .8-.4.8-.9V4.8L9.5 1zm0 1.6L11.9 5H9.5V2.6zM4 14V2h4.5v3.5c0 .3.2.5.5.5h3v8H4z"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 4h8v8H4z"/></svg>',
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
  <button class="launch" id="run" title="Run this project on the selected system">
    ${ICONS.play}
    <span class="launch-text">
      <span class="launch-title" id="run-title">Run</span>
      <span class="launch-sub" id="run-sub"></span>
    </span>
  </button>

  <p class="notice" id="notice" hidden></p>
  <button class="wide secondary" id="install" hidden></button>

  <div class="fields" id="fields">
    <div class="field">
      <label class="field-label" for="system">System</label>
      <select id="system" title="The system Run and Build use"></select>
    </div>
    <div class="field">
      <label class="field-label" for="project">Project</label>
      <div class="control">
        <select id="project" title="The project Run and Build act on"></select>
        <button class="icon" id="build" title="Build this project for the selected system">${ICONS.build}</button>
        <button class="icon" id="open" title="Open this project's entry file">${ICONS.file}</button>
      </div>
    </div>
  </div>

  <details class="more" id="more">
    <summary>Hardware &middot; Region &middot; Facts <span class="summary-value" id="fitted"></span></summary>
    <div class="field">
      <label class="field-label" for="region">Region</label>
      <select id="region" title="NTSC (US/Japan, 60Hz) or PAL (Europe, 50Hz) machine model">
        <option value="ntsc">NTSC — US/Japan, 60Hz</option>
        <option value="pal">PAL — Europe, 50Hz</option>
      </select>
    </div>
    <div class="field">
      <label class="field-label" for="profile">Fitted with</label>
      <select id="profile" title="A preset: stock, a catalog preset, or one this project composes in its 8bs.config.ts"></select>
    </div>
    <div id="options"></div>
  </details>

  <section class="running" id="running" hidden>
    <h2 class="section-label">Running</h2>
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
 */
function registerLauncherView(context, projects) {
  const provider = new LauncherViewProvider(projects);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  return provider;
}

module.exports = { registerLauncherView };
