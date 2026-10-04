// The 8BitScript side bar: pick a program, pick a system, run it where you want.
//
// The page (media/launcher.{css,js}) holds no truth. This file builds one
// LauncherState (the shape is documented at the top of launcherState.cjs),
// posts it, and maps each typed message the page sends back onto a command.
// What it shows comes from the unit model (units.cjs, reached through the
// runner): the project's programs and their inputs, which runtimes work on
// which machine and why not, which one is the default, and what is running.
// Every choice that matters to a run is written straight to the extension's
// settings (settings.cjs) or the workspace state (unitState.cjs) and read
// back, so what the page shows and what a run does cannot disagree, and the
// command the page shows is built by the same functions the run uses.
//
// Run is three buttons, not one: Editor (the WASM build in an editor tab),
// Browser (the WASM build in the system browser) and Native (the machine's
// real emulator). Each is its own message and its own command; none is a
// default hidden behind another, and none needs another to be running.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const vscode = require('vscode');

const { MACHINE_TARGETS, byKind, commandArgs } = require('./projects.cjs');
const { labelOf, whereLabel } = require('./runner.cjs');
const settings = require('./settings.cjs');
const { effectiveFacts, matchesSystem, selectionLabel } = require('./hardwareCatalog.cjs');
const { machineTree, readLastRun, rowKey } = require('./runningMachines.cjs');
const { installRoots } = require('./projectInfo.cjs');
const { quietly } = require('./quietly.cjs');
const units = require('./units.cjs');
const {
  RUNTIMES, availabilityFromMatrix, inputRow, movedNote, normalizeState,
} = require('./launcherState.cjs');

const VIEW_ID = '8bitscript.launcher';
const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'launcher.css'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'launcher.js'), 'utf8');

const DOCS_URL = 'https://8bitscript.org/';

/** The short names the System picker shows; anything else shows its id. */
const SHORT = { pet: 'PET', c64: 'C64', vic20: 'VIC-20', cx16: 'X16', web: 'Web', c128: 'C128', mega65: 'MEGA65', atari8: 'Atari 8-bit', nes: 'NES' };

/** Page messages that run a command of the extension, by the message's own `type`. */
const COMMANDS = {
  doctor: '8bitscript.doctor',
  details: '8bitscript.showProject',
  configureSystem: '8bitscript.configureSystem',
  saveSystem: '8bitscript.saveSystem',
  studio: '8bitscript.openStudio',
  studioNative: '8bitscript.openStudioNative',
  tryExample: '8bitscript.launchExample',
  rebuildExtension: '8bitscript.rebuildExtension',
};

/**
 * A run's runtime, whatever the task says. A boot has none and is the machine's
 * own emulator; the synthetic web target is itself the browser.
 */
function runtimeOfRow(row) {
  if (row.runtime) return row.runtime;
  if (row.web) return 'editor';
  return row.target === 'web' ? 'browser' : 'native';
}

class LauncherViewProvider {
  /**
   * @param {import('./runner.cjs').Projects} projects
   * @param {ReturnType<import('./devReload.cjs').registerDevReload> | null} [devReload]
   * @param {import('vscode').ExtensionContext | null} [context]
   */
  constructor(projects, devReload, context) {
    this.projects = projects;
    this.devReload = devReload ?? null;
    this.context = context ?? null;
    this.view = undefined;
    this.loaded = false;
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = this.context?.extensionUri ? vscode.Uri.joinPath(this.context.extensionUri, 'media') : null;
    view.webview.options = { enableScripts: true, ...(media ? { localResourceRoots: [media] } : {}) };
    view.webview.html = html(view.webview, media);

    const subscriptions = [
      view.webview.onDidReceiveMessage((message) => this.apply(message)),
      // post() is async; none of these listeners are, so an uncaught
      // rejection would otherwise be an unhandled promise rejection rather
      // than a logged, best-effort refresh of the panel.
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (settings.affectsAny(event) || event.affectsConfiguration('8bitscript.showExamples')) {
          void quietly('8BitScript launcher view', () => this.post());
        }
      }),
      this.projects.onDidChange(() => quietly('8BitScript launcher view', () => this.post())),
      view.onDidChangeVisibility(() => view.visible && quietly('8BitScript launcher view', () => this.post())),
    ];
    if (this.devReload) {
      subscriptions.push(this.devReload.onDidChange(() => quietly('8BitScript launcher view', () => this.post())));
    }
    view.onDidDispose(() => {
      for (const subscription of subscriptions) subscription.dispose();
      this.view = undefined;
    });

    void quietly('8BitScript launcher view', () => this.post());
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

  /** Whether a machine takes a region: the CLI's word once it has given it, else the fixed set (as the run does). */
  regionalOf(project, id) {
    return this.projects.regional(project.dir, id) ?? MACHINE_TARGETS.has(id);
  }

  /** The program the panel acts on: the chosen one if the project has it, else its main, else its first. */
  chosenProgram(unit, project) {
    const chosen = settings.getProgram(project.dir);
    return units.programNamed(unit, chosen) ?? units.programNamed(unit, unit.main) ?? unit.programs[0] ?? null;
  }

  // ── messages from the page ────────────────────────────────────────────────
  async apply(message) {
    const project = this.selectedProject();
    switch (message?.type) {
      case 'ready':
        await this.post();
        return;
      case 'run':
        await this.run(project, message);
        return;
      case 'build':
        if (project) await this.withProgram(project, message.program, () => vscode.commands.executeCommand('8bitscript.build', this.args(project, message.program)));
        return;
      case 'boot':
        if (project) await vscode.commands.executeCommand('8bitscript.openBareEmulator', this.args(project));
        return;
      case 'select':
        await this.select(message);
        return;
      case 'selectRuntime':
        if (project) await this.projects.unitState.setRuntime(project.dir, message.program, message.runtime);
        await this.post();
        return;
      case 'input':
        await this.setInput(project, message);
        return;
      case 'inputsReset':
        if (project) await this.projects.unitState.resetInputs(project.dir, message.program ?? '');
        await this.post();
        return;
      case 'openSource':
        await this.openSource(project, message.program);
        return;
      case 'reveal':
        await this.openSource(project, message.program, true);
        return;
      case 'copy':
        if (typeof message.text === 'string') await vscode.env.clipboard.writeText(message.text);
        return;
      case 'stop':
        this.projects.running.stopRun(message.runId);
        return;
      case 'focus':
        await vscode.commands.executeCommand('8bitscript.previewTab.show');
        return;
      case 'openInBrowser':
        await this.openInBrowser(message.runId);
        return;
      case 'fix':
        await this.fix(project, message);
        return;
      case 'openFolder':
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
        return;
      case 'learn':
        await vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
        return;
      case 'reloadWindow':
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
        return;
      default:
        // Only the ids the page can name, so a message cannot run anything else.
        if (Object.prototype.hasOwnProperty.call(COMMANDS, message?.type)) {
          await vscode.commands.executeCommand(COMMANDS[message.type], { project, system: message.system });
        }
    }
  }

  /**
   * `{ project, program }` plus the system the settings say. The page only ever
   * displays the system, so a `system` it sends is a label and not an input.
   */
  args(project, program) {
    return {
      project,
      target: settings.getSystem(),
      system: settings.getNamedSystem() || undefined,
      ...(program ? { program } : {}),
    };
  }

  /** Make `program` the chosen one for the duration of a command that reads the setting. */
  async withProgram(project, program, action) {
    const unit = await this.projects.unitProject(project);
    if (program && units.programNamed(unit, program)) await settings.setProgram(project.dir, program);
    return action();
  }

  async run(project, message) {
    if (!project || !RUNTIMES.some((r) => r.id === message.runtime)) return;
    await vscode.commands.executeCommand('8bitscript.runUnit', {
      ...this.args(project, message.program),
      runtime: message.runtime,
      inputs: message.inputs ?? {},
    });
    await this.post();
  }

  async select(message) {
    if (message.project !== undefined) {
      await settings.setProject(message.project);
      // Picking a project loads what it is set up for: the first of its
      // systems, hardware and region and all. A project with none keeps
      // the current machine when it targets it, and takes its first
      // otherwise — the panel never leaves a machine selected that the
      // project cannot be run on.
      const project = this.projects.all.find((p) => p.dir === message.project);
      if (project) {
        const unit = await this.projects.unitProject(project);
        const targets = await this.projects.loadTargets(project.dir);
        const first = targets?.systems?.[0];
        if (first) await this.applySystem(first);
        else {
          await settings.setNamedSystem('');
          if (!unit.targets.includes(settings.getSystem())) {
            await settings.setSystem(unit.targets[0] ?? settings.getSystem());
          }
        }
      }
    } else if (message.program !== undefined) {
      // Which of the selected project's programs Run and Build act on. The
      // machine follows the program the way it follows a project: kept when
      // the program targets it, the program's first otherwise.
      const project = this.selectedProject();
      const unit = project ? await this.projects.unitProject(project) : null;
      const program = unit ? units.programNamed(unit, message.program) : null;
      if (program) {
        await settings.setProgram(project.dir, program.name);
        if (program.targets.length > 0 && !program.targets.includes(settings.getSystem())) {
          await settings.setNamedSystem('');
          await settings.setSystem(program.targets[0]);
        }
      }
    } else if (message.system !== undefined) {
      // One picker, two kinds of entry: a machine on its own, or a whole
      // machine the project has been set up for, which sets the hardware and
      // the region with it.
      const project = this.selectedProject();
      const named = (await this.projects.loadTargets(project?.dir))?.systems?.find((s) => s.name === message.system);
      const unit = project ? await this.projects.unitProject(project) : null;
      if (named) await this.applySystem(named);
      else if (unit?.targets.includes(message.system)) {
        await settings.setNamedSystem('');
        await settings.setSystem(message.system);
        // A bare machine, picked on its own, means its project's own
        // config-declared stock — never whatever hardware a previous named
        // pick left stored for it.
        await settings.setHardware(message.system, {});
      }
    }
    await this.post();
  }

  /** Fit a whole system: its machine, its region, and its hardware, in one write. */
  async applySystem(system) {
    await settings.setNamedSystem(system.name);
    await settings.setSystem(system.target);
    if (system.region) await settings.setRegion(system.region);
    await settings.setHardware(system.target, { profile: system.profile ?? null, options: system.hardware ?? {} });
  }

  /** Remember an input for a program, or forget it when it is back to what a plain run uses. */
  async setInput(project, { program, name, value }) {
    if (!project || typeof name !== 'string') return;
    const unit = await this.projects.unitProject(project);
    const input = units.programNamed(unit, program)?.defines.find((d) => d.name === name);
    const base = input ? (input.value ?? input.default) : undefined;
    await this.projects.unitState.setInput(project.dir, program ?? '', name, value === base ? undefined : value);
    await this.post();
  }

  // ── actions on a program or a run ─────────────────────────────────────────
  async openSource(project, program, reveal = false) {
    if (!project) return;
    const unit = await this.projects.unitProject(project);
    const entry = units.programNamed(unit, program)?.entry || project.entry;
    if (!entry) return;
    const uri = vscode.Uri.file(entry);
    if (reveal) await vscode.commands.executeCommand('revealInExplorer', uri);
    else await vscode.window.showTextDocument(uri);
  }

  async openInBrowser(id) {
    const row = this.projects.running.list().find((r) => r.runId === id);
    if (!row) return;
    const url = readLastRun(row.dir, row.target, row.web === true)?.url;
    if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async fix(project, message) {
    if (message.kind === 'emulator') await vscode.commands.executeCommand('8bitscript.doctorSetup');
    else if (message.kind === 'packages') {
      await vscode.commands.executeCommand('8bitscript.install', {
        project, dir: message.dir, name: message.name, packageManager: message.packageManager,
      });
    }
  }

  // ── the state ─────────────────────────────────────────────────────────────
  /** Push the current settings to the page; it never keeps its own copy. */
  async post() {
    if (!this.view) return;
    if (!this.loaded) this.view.webview.postMessage({ type: 'state', state: normalizeState({ phase: 'loading' }) });
    const state = await this.buildState();
    this.loaded = true;
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'state', state });
  }

  async buildState() {
    const all = this.projects.all;
    const project = this.selectedProject(all);
    const offered = this.projects.visible;
    const listed = project && !offered.includes(project) ? [...offered, project] : offered;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const setting = settings.getCheckout() || null;
    const notices = this.noticesFor({ folders, setting });

    if (!project) return normalizeState({ phase: 'empty', notices });

    const machine = settings.getSystem();
    const named = settings.getNamedSystem();
    const [rows, unit, doctor] = await Promise.all([
      this.projects.loadTargets(project.dir), this.projects.unitProject(project), this.projects.loadDoctor(),
    ]);
    if (!this.view) return normalizeState({ phase: 'empty' });
    const target = rows?.get(machine) ?? null;
    const selection = settings.getEffectiveHardware(machine, target);
    const region = settings.getRegion();
    const fitted = named
      ? (rows?.systems ?? []).find((entry) => entry.name === named)
      : (rows?.systems ?? []).find((entry) => entry.target === machine && matchesSystem(entry, target, selection, region));
    const systemId = fitted?.name || named || machine;
    const extras = { system: fitted?.name || named || undefined, checkout: this.projects.checkoutFlag() || undefined };
    const runtimeRow = units.normalizeRuntime(target?.runtime) ?? units.legacyRuntime(machine);
    const emulator = runtimeRow.native.emulator ?? target?.emulator ?? null;
    const preferEditor = settings.getPreferWebPreview();

    // Warnings that are about the project, not about one program or runtime.
    for (const text of [shortfall(rows, target, selection), rows?.systemsError, rows?.requiresError, unit.configError].filter(Boolean)) {
      notices.push({ id: `w${notices.length}`, kind: 'warn', icon: 'warning', text, actions: [] });
    }
    for (const [i, problem] of unit.problems.entries()) {
      notices.push({ id: `p${i}`, kind: 'warn', icon: 'warning', text: `${problem.scope}: ${problem.message}`, actions: [] });
    }
    if (!project.toolchain) {
      notices.push({
        id: 'toolchain', kind: 'warn', icon: 'warning', title: 'No 8bs toolchain.', text: `Run ${project.packageManager} install in ${labelOf(project)}.`,
        actions: [{ label: 'Install packages', icon: 'package', msg: { type: 'fix', kind: 'packages', dir: project.dir, name: labelOf(project), packageManager: project.packageManager } }],
      });
    }

    const live = this.projects.running.list().filter((r) => r.dir === project.dir && r.command === 'run');
    const selected = this.chosenProgram(unit, project);
    const programs = unit.programs.map((p) => {
      const onSystem = p.targets.length === 0 || p.targets.includes(machine);
      const matrix = units.runtimeMatrix({ runtime: runtimeRow, target: machine, program: p, doctor });
      const availability = availabilityFromMatrix(matrix, { emulator });
      const remembered = this.projects.unitState.runtime(project.dir, p.name);
      const primary = onSystem ? units.defaultRuntime({ matrix, remembered, preferEditor }) : null;
      const overrides = this.projects.unitState.inputs(project.dir, p.name);
      const note = primary ? movedNote(remembered, primary, availability) : '';
      return {
        id: p.name,
        title: p.label,
        group: p.group ?? '',
        description: p.description ?? '',
        entry: p.entryRelative,
        onSystem,
        // A project whose 8bs cannot list its inputs shows none: they are
        // unknown, not empty (the model says so with `definesRead`).
        inputs: unit.legacy || !p.definesRead ? [] : p.defines.map((d) => inputRow(d, overrides)),
        runtimes: availability,
        primary,
        ...(note ? { primaryMoved: note } : {}),
        live: [...new Set(live.filter((r) => (r.program ?? unit.main) === p.name).map(runtimeOfRow))],
      };
    });

    const current = programs.find((p) => p.id === selected?.name) ?? programs[0];
    const command = selected ? this.commandFor({ unit, program: selected, project, machine, region, selection, extras, runtime: current?.primary ?? 'native' }) : '';

    const reachable = new Set(selected?.targets ?? unit.targets);
    const systems = [
      ...(rows?.systems ?? []).map((entry) => ({
        id: entry.name,
        short: entry.name,
        name: entry.name,
        spec: entry.label === 'stock' ? entry.target : `${entry.target} · ${entry.label}`,
        region: this.regionalOf(project, entry.target) ? settings.regionShort(entry.region ?? region) : '—',
        group: { project: 'This clone', user: 'This machine', advertised: 'Advertised' }[entry.origin] ?? 'Systems',
        emulator: units.normalizeRuntime(rows?.get(entry.target)?.runtime)?.native.emulator ?? null,
        enabled: reachable.has(entry.target),
      })),
      ...unit.targets.map((id) => {
        const t = rows?.get(id);
        const hw = id === machine ? selection : settings.getEffectiveHardware(id, t);
        const row = units.normalizeRuntime(t?.runtime) ?? units.legacyRuntime(id);
        const regional = this.regionalOf(project, id);
        return {
          id, short: SHORT[id] ?? id, name: t?.title ?? id,
          spec: selectionLabel(hw) || 'stock machine',
          region: regional ? settings.regionShort(region) : (id === 'web' ? '—' : ''),
          group: (rows?.systems?.length ?? 0) > 0 ? 'Machines' : '',
          emulator: row.native.emulator ?? null,
          enabled: reachable.has(id),
        };
      }),
    ];

    return normalizeState({
      phase: 'ready',
      notices,
      projects: projectOptions(listed),
      project: { id: project.dir, name: labelOf(project), sub: whereLabel(project) },
      systems,
      system: systemId,
      summary: {
        name: fitted?.name ?? target?.title ?? machine,
        text: [selectionLabel(selection) || 'stock machine'].concat(this.regionalOf(project, machine) ? [settings.regionShort(region)] : []).join(' · '),
      },
      programs,
      program: selected?.name ?? null,
      collapsedGroups: [...new Set(programs.map((p) => p.group))].filter((g) => /^test\b/i.test(g)),
      command,
      running: this.runningRows(all, unit),
    });
  }

  /**
   * The exact `8bs` line a click on the program's primary runtime runs: the
   * same functions the run uses, in the same order, so what is shown is what
   * happens.
   */
  commandFor({ unit, program, project, machine, region, selection, extras, runtime }) {
    const overrides = this.projects.unitState.inputs(project.dir, program.name);
    const inputs = unit.legacy || !program.definesRead ? { args: [] } : units.inputArgs(program, overrides);
    const args = commandArgs('run', machine, region, extras.system ? undefined : selection, {
      ...extras,
      ...(unit.several ? { program: program.name } : {}),
      defines: inputs.args,
      regional: this.regionalOf(project, machine),
    });
    args.push(...units.runtimeArgs(runtime, machine, { webLan: settings.getWebLan() }));
    if (machine === 'cx16' && runtime === 'native') args.push(...settings.cx16NativeWindowCliArgs({ studio: project.name === '@8bitscript/studio' }));
    return units.formatCommand(args);
  }

  /** What is running, named the way the panel's rows read. */
  runningRows(all, unit) {
    const rows = [];
    for (const row of this.projects.running.list()) {
      if (row.command !== 'run' && row.command !== 'boot') continue;
      const project = all.find((p) => p.dir === row.dir);
      const report = row.target ? readLastRun(row.dir, row.target, row.web === true) : null;
      const live = this.projects.live.get(rowKey(row.dir, row.target, row.web === true)) ?? null;
      const tree = machineTree({ command: row.command, target: row.target, startedAt: row.startedAt }, report, live);
      const program = row.program ? units.programNamed(unit, row.program) : null;
      const title = program?.label ?? (project ? labelOf(project) : path.basename(row.dir || '8bs'));
      const details = [];
      if (tree?.fitted) details.push({ label: 'Hardware', value: tree.fitted });
      if (tree?.emulator) details.push({ label: 'Emulator', value: tree.emulator });
      if (tree?.outFile) details.push({ label: 'Image', value: tree.outFile, mono: true });
      if (tree?.memory?.line) details.push({ label: 'Memory', value: tree.memory.line });
      if (tree?.url) details.push({ label: 'Local URL', value: tree.url, mono: true });
      if (tree?.lanUrl) details.push({ label: 'Network URL', value: tree.lanUrl, mono: true });
      rows.push({
        id: row.runId,
        programId: row.program ?? null,
        title,
        system: row.target ?? '',
        runtime: runtimeOfRow(row),
        elapsed: tree?.elapsed ?? '',
        fps: typeof tree?.live?.fps === 'number' ? `${Math.round(tree.live.fps)} fps` : '',
        detail: tree?.url ?? tree?.emulator ?? '',
        url: tree?.url ?? null,
        error: tree?.live?.error ?? null,
        command: row.commandLine ?? '',
        details,
        size: (tree?.size ?? []).map((s) => ({ name: s.name, text: `${s.bytes} B · ${s.pct}%` })),
        qrSvg: tree?.qrSvg ?? null,
      });
    }
    return rows;
  }

  /** Dev-reload and package notices, shown above everything else. */
  noticesFor({ folders, setting }) {
    const notices = [];
    const phase = this.devReload?.phase ?? 'idle';
    if (phase !== 'idle') {
      const text = {
        dirty: 'The local 8BitScript extension has changed.',
        building: 'Rebuilding the local extension…',
        ready: 'The local 8BitScript extension was rebuilt successfully.',
        error: this.devReload?.error || 'The local extension did not build.',
      }[phase] ?? '';
      const actions = [];
      if (phase === 'dirty' || phase === 'error') actions.push({ label: 'Rebuild the local extension', icon: 'tools', msg: { type: 'rebuildExtension' } });
      if (phase === 'ready') actions.push({ label: 'Reload this window', icon: 'refresh', msg: { type: 'reloadWindow' } });
      notices.push({ id: 'dev-reload', kind: phase === 'error' ? 'error' : 'info', icon: 'tools', text, actions });
    }
    const missing = packageRows({ folders, setting, managed: this.projects.managedDir, projects: this.projects.projects });
    for (const row of missing) {
      notices.push({
        id: `pkg-${row.dir}`, kind: 'warn', icon: 'package', title: 'Packages need installing.', text: `${row.label} is missing ${row.detail ?? 'its packages'}.`,
        actions: [{ label: 'Install packages', icon: 'package', msg: { type: 'fix', kind: 'packages', dir: row.dir, name: row.label, packageManager: row.packageManager } }],
      });
    }
    return notices;
  }
}

/** The project picker's entries, grouped into Projects / Examples / Apps. */
function projectOptions(projects) {
  const entry = (project, group) => ({ id: project.dir, label: labelOf(project), where: whereLabel(project), group });
  const sections = byKind(projects);
  if (!sections) return projects.map((project) => entry(project, ''));
  return sections.flatMap(({ label, projects: group }) => group.map((project) => entry(project, label)));
}

/**
 * The rows the packages block shows: only a root that needs installing.
 * A row that only offers an update nobody asked for is a row to read past;
 * the palette's "8BitScript: Install Dependencies" updates on request.
 */
function packageRows({ folders, setting, managed, projects }) {
  return installRoots({ folders, setting, managed, projects }).filter((status) => !status.installed).map((status) => ({
    dir: status.dir,
    kind: status.kind,
    label: status.label,
    detail: status.detail,
    packageManager: status.packageManager,
  }));
}

/**
 * What this machine, fitted this way, gives the program less of than it
 * asked for — the config's `requires` block, checked against the sheet the
 * build will resolve to. The same answer `8bs build` refuses with, said
 * before the build rather than after it. A warning, not a refusal: the build
 * is the authority.
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

/**
 * The page. `media` is the extension's media directory as a Uri; without one
 * (a unit test with no extension context) the files are named relatively.
 */
function html(webview, media) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const asset = (name) => (media && webview.asWebviewUri ? String(webview.asWebviewUri(vscode.Uri.joinPath(media, name))) : name);
  const css = CSS.replace('{{CODICON}}', asset('codicon.woff2'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${css}</style>
<title>8BitScript</title>
</head>
<body>
  <main id="app" data-logo="${asset('8bitscript-icon.svg')}" aria-label="8BitScript launcher"></main>
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
  const provider = new LauncherViewProvider(projects, devReload, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  return provider;
}

module.exports = { registerLauncherView, runtimeOfRow };
