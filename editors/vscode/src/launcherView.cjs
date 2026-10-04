// The 8BitScript side bar: pick a program, pick a system, run it where you want.
//
// The page (media/launcher.{css,js}) holds no truth. This file builds one
// LauncherState (the shape is documented at the top of launcherState.cjs),
// posts it, and maps each typed message the page sends back onto a command.
// Every choice that matters to a run is written straight to the extension's
// settings (settings.cjs) or the workspace state and read back, so what the
// page shows and what a run does cannot disagree, and the command the page
// shows is exactly the `8bs` line a click runs.
//
// Run is three buttons, not one: Editor (the WASM build in an editor tab),
// Browser (the WASM build in the system browser) and Native (the machine's
// real emulator). Each is its own message and its own command; none is a
// default hidden behind another, and none needs another to be running.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const vscode = require('vscode');

const {
  ALL_TARGETS, MACHINE_TARGETS, WEB_PREVIEW_READY, byKind, commandArgs,
  hasSeveralPrograms, programTargets, resolveProgram,
} = require('./projects.cjs');
const { labelOf, whereLabel } = require('./runner.cjs');
const settings = require('./settings.cjs');
const { effectiveFacts, matchesSystem, selectionLabel } = require('./hardwareCatalog.cjs');
const { machineTree, readLastRun, rowKey } = require('./runningMachines.cjs');
const { resolveCheckoutRoot } = require('./checkout.cjs');
const { installRoots } = require('./projectInfo.cjs');
const { quietly } = require('./quietly.cjs');
const {
  RUNTIMES, availability, commandLine, defineFlags, normalizeState, primaryRuntime,
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
  tryExample: '8bitscript.launchExample',
  rebuildExtension: '8bitscript.rebuildExtension',
};

/** The command a Run click goes to: the unit model's, falling back to today's. */
const RUN_UNIT = '8bitscript.runUnit';

/** A small key-value store: the workspace's when it has one, memory otherwise. */
function makeStore(context) {
  const memory = new Map();
  const backing = context?.workspaceState;
  return {
    get(key, fallback) {
      const value = backing ? backing.get(key) : memory.get(key);
      return value === undefined ? fallback : value;
    },
    async set(key, value) {
      if (backing) await backing.update(key, value);
      else memory.set(key, value);
    },
  };
}

/** The runtime a running task is in. */
function runtimeOfDefinition(definition) {
  if (definition.runtime) return definition.runtime;
  if (definition.web) return 'editor';
  return definition.target === 'web' ? 'browser' : 'native';
}

/** A run's stable id for the page: when it started, where, and what. */
function runId(startedAt, definition) {
  return `${startedAt}:${definition.target ?? ''}:${runtimeOfDefinition(definition)}:${definition.program ?? ''}`;
}

/**
 * A program's inputs, from its `define` block: `{ SEED: 7 }` or
 * `{ SEED: { value: 7, label, description, options } }`. The kind follows the
 * default's type, so the form needs no schema of its own.
 *
 * @param {Record<string, unknown> | null | undefined} define
 * @param {Record<string, unknown>} [overrides] values the person has set
 */
function inputsFromDefine(define, overrides = {}) {
  return Object.entries(define ?? {}).map(([name, raw]) => {
    const spec = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw };
    const def = spec.value ?? spec.default;
    const options = Array.isArray(spec.options) ? spec.options : [];
    const kind = options.length > 0 ? 'select'
      : typeof def === 'boolean' ? 'bool'
        : typeof def === 'number' ? 'number' : 'text';
    return {
      name,
      label: spec.label ?? name.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      kind,
      def,
      value: Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : def,
      help: spec.description ?? '',
      options,
    };
  });
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
    this.store = makeStore(context);
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

  /** The program the panel acts on, by name, or null for a project with one. */
  selectedProgram(project) {
    return project ? resolveProgram(project, settings.getProgram(project.dir)) : null;
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
        if (project) await vscode.commands.executeCommand('8bitscript.boot', this.args(project));
        return;
      case 'select':
        await this.select(message);
        return;
      case 'selectRuntime':
        await this.remember('runtime', project, message.program, message.runtime);
        await this.post();
        return;
      case 'input':
        await this.setInput(project, message);
        return;
      case 'inputsReset':
        await this.store.set('launcher.inputs', this.without(project, message.program));
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
        this.stop(message.runId);
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
   * `{ project, target, system, program }`, the way every run command takes
   * them. The system is whatever the settings say — the page only ever
   * displays them, so its own `system` field is a label and not an input.
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
    if (program && project.programs?.some((p) => p.name === program)) {
      await settings.setProgram(project.dir, program);
    }
    return action();
  }

  async run(project, message) {
    if (!project || !RUNTIMES.some((r) => r.id === message.runtime)) return;
    await this.remember('runtime', project, message.program, message.runtime);
    await this.withProgram(project, message.program, async () => {
      const common = { ...this.args(project, message.program), runtime: message.runtime, inputs: message.inputs ?? {} };
      const ids = await this.commandIds();
      if (ids.has(RUN_UNIT)) {
        await vscode.commands.executeCommand(RUN_UNIT, common);
        return;
      }
      // Until the unit model's commands exist: Native and Editor are the two
      // runs `8bitscript.run` already makes; Browser is the one it cannot.
      if (message.runtime === 'browser') {
        void vscode.window.showInformationMessage('Browser runs need the 8BitScript unit commands, which this build does not have yet. Use Editor or Native.');
        return;
      }
      await vscode.commands.executeCommand('8bitscript.run', { ...common, web: message.runtime === 'editor' });
    });
    await this.post();
  }

  async commandIds() {
    try {
      return new Set(await vscode.commands.getCommands(true));
    } catch {
      return new Set();
    }
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
        const targets = await this.projects.loadTargets(project.dir);
        const first = targets?.systems?.[0];
        if (first) await this.applySystem(first);
        else {
          await settings.setNamedSystem('');
          if (!project.targets.includes(settings.getSystem())) {
            await settings.setSystem(project.targets[0] ?? settings.getSystem());
          }
        }
      }
    } else if (message.program !== undefined) {
      // Which of the selected project's programs Run and Build act on. The
      // machine follows the program the way it follows a project: kept when
      // the program targets it, the program's first otherwise.
      const project = this.selectedProject();
      if (project?.programs?.some((p) => p.name === message.program)) {
        await settings.setProgram(project.dir, message.program);
        const fits = programTargets(project, message.program);
        if (!fits.includes(settings.getSystem()) && fits.length > 0) {
          await settings.setNamedSystem('');
          await settings.setSystem(fits[0]);
        }
      }
    } else if (message.system !== undefined) {
      // One picker, two kinds of entry: a machine on its own, or a whole
      // machine the project has been set up for, which sets the hardware and
      // the region with it.
      const named = (await this.projects.loadTargets(this.selectedProject()?.dir))?.systems?.find((s) => s.name === message.system);
      if (named) await this.applySystem(named);
      else if (ALL_TARGETS.includes(message.system)) {
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

  // ── per-program memory ────────────────────────────────────────────────────
  /** The remembered value of `kind` for one program. */
  recall(kind, project, program) {
    return this.store.get(`launcher.${kind}`, {})?.[project?.dir]?.[program];
  }

  async remember(kind, project, program, value) {
    if (!project || !program) return;
    const all = { ...this.store.get(`launcher.${kind}`, {}) };
    all[project.dir] = { ...all[project.dir], [program]: value };
    await this.store.set(`launcher.${kind}`, all);
  }

  async setInput(project, { program, name, value }) {
    if (!project || !program || typeof name !== 'string') return;
    const current = this.recall('inputs', project, program) ?? {};
    await this.remember('inputs', project, program, { ...current, [name]: value });
    await this.post();
  }

  without(project, program) {
    const all = { ...this.store.get('launcher.inputs', {}) };
    if (project && all[project.dir]) {
      all[project.dir] = { ...all[project.dir] };
      delete all[project.dir][program];
    }
    return all;
  }

  // ── actions on a program or a run ─────────────────────────────────────────
  async openSource(project, program, reveal = false) {
    const entry = (project?.programs ?? []).find((p) => p.name === program)?.entry ?? project?.entry;
    if (!entry) return;
    const uri = vscode.Uri.file(entry);
    if (reveal) await vscode.commands.executeCommand('revealInExplorer', uri);
    else await vscode.window.showTextDocument(uri);
  }

  /** The live task a run id names. */
  executionOf(id) {
    const running = this.projects.running;
    for (const execution of running.executions) {
      if (runId(running.startedAt.get(execution), execution.task.definition) === id) return execution;
    }
    return null;
  }

  stop(id) {
    this.executionOf(id)?.terminate();
  }

  async openInBrowser(id) {
    const execution = this.executionOf(id);
    if (!execution) return;
    const definition = execution.task.definition;
    const url = readLastRun(definition.projectDir, definition.target, definition.web === true)?.url;
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
    const targets = await this.projects.loadTargets(project.dir);
    const doctor = await this.projects.loadDoctor();
    if (!this.view) return normalizeState({ phase: 'empty' });
    const target = targets?.get(machine) ?? null;
    const selection = settings.getEffectiveHardware(machine, target);
    const region = settings.getRegion();
    const fitted = named
      ? (targets?.systems ?? []).find((entry) => entry.name === named)
      : (targets?.systems ?? []).find((entry) => entry.target === machine && matchesSystem(entry, target, selection, region));
    const systemId = fitted?.name || named || machine;
    const extras = { system: fitted?.name || named || undefined, checkout: this.projects.checkoutFlag() || undefined };
    const rawPrograms = project.programs?.length ? project.programs : [{ name: 'main', entry: project.entry, targets: null }];
    const chosen = hasSeveralPrograms(project) ? this.selectedProgram(project) : rawPrograms[0].name;

    // Warnings that are about the project, not about one program or runtime.
    const shortfallText = shortfall(targets, target, selection);
    for (const text of [shortfallText, targets?.systemsError, targets?.requiresError].filter(Boolean)) {
      notices.push({ id: `w${notices.length}`, kind: 'warn', icon: 'warning', text, actions: [] });
    }
    if (!project.toolchain) {
      notices.push({
        id: 'toolchain', kind: 'warn', icon: 'warning', title: 'No 8bs toolchain.', text: `Run ${project.packageManager} install in ${labelOf(project)}.`,
        actions: [{ label: 'Install packages', icon: 'package', msg: { type: 'fix', kind: 'packages', dir: project.dir, name: labelOf(project), packageManager: project.packageManager } }],
      });
    }

    const programs = rawPrograms.map((p) => {
      const targetsOf = programTargets(project, p.name);
      const onSystem = targetsOf.includes(machine);
      const av = availability({
        system: { id: machine, emulator: machine === 'web' ? null : (target?.emulator ?? machine) },
        wasm: wasmFor(machine, target),
        emulatorMissing: doctor?.notInstalled?.includes(machine) === true,
        nativeFails: doctor?.failed?.includes(machine) === true,
      });
      const remembered = this.recall('runtime', project, p.name);
      const { runtime, moved } = onSystem ? primaryRuntime(av, remembered, { preferEditor: settings.getPreferWebPreview() }) : { runtime: null };
      return {
        id: p.name,
        title: p.title ?? (rawPrograms.length === 1 ? labelOf(project) : p.name),
        group: p.group ?? '',
        description: p.description ?? '',
        entry: p.entry ? path.relative(project.dir, p.entry) : '',
        onSystem,
        inputs: inputsFromDefine(p.define, this.recall('inputs', project, p.name)),
        runtimes: av,
        primary: runtime,
        ...(moved ? { primaryMoved: moved } : {}),
        live: this.liveRuntimes(project, p.name),
      };
    });

    const selected = programs.find((p) => p.id === chosen) ?? programs[0];
    const baseArgs = commandArgs('run', machine, region, extras.system ? undefined : selection, {
      ...extras, ...(hasSeveralPrograms(project) && selected ? { program: selected.id } : {}),
    });
    const runtime = selected?.primary ?? 'native';
    const flags = [
      ...(machine === 'web' ? ['--port', '0'] : []),
      ...(machine === 'web' && !settings.getWebLan() ? ['--local'] : []),
      ...(machine === 'cx16' && runtime === 'native' ? settings.cx16NativeWindowCliArgs({ studio: project.name === '@8bitscript/studio' }) : []),
    ];
    const command = commandLine([...baseArgs, ...flags], machine === 'web' ? 'native' : runtime, defineFlags(selected?.inputs ?? []));

    const reachable = new Set(programTargets(project, selected?.id));
    const machines = ALL_TARGETS.filter((id) => project.targets.includes(id));
    const systems = [
      ...(targets?.systems ?? []).map((entry) => ({
        id: entry.name,
        short: entry.name,
        name: entry.name,
        spec: entry.label === 'stock' ? entry.target : `${entry.target} · ${entry.label}`,
        region: MACHINE_TARGETS.has(entry.target) ? settings.regionShort(entry.region ?? region) : '—',
        group: { project: 'This clone', user: 'This machine', advertised: 'Advertised' }[entry.origin] ?? 'Systems',
        emulator: entry.target === 'web' ? null : (targets?.get(entry.target)?.emulator ?? entry.target),
        enabled: reachable.has(entry.target),
      })),
      ...machines.map((id) => {
        const t = targets?.get(id);
        const hw = id === machine ? selection : settings.getEffectiveHardware(id, t);
        return {
          id, short: SHORT[id] ?? id, name: t?.title ?? id,
          spec: selectionLabel(hw) || 'stock machine',
          region: MACHINE_TARGETS.has(id) ? settings.regionShort(region) : (id === 'web' ? '—' : ''),
          group: (targets?.systems?.length ?? 0) > 0 ? 'Machines' : '',
          emulator: id === 'web' ? null : (t?.emulator ?? id),
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
        text: [selectionLabel(selection) || 'stock machine'].concat(MACHINE_TARGETS.has(machine) ? [settings.regionShort(region)] : []).join(' · '),
      },
      programs,
      program: selected?.id ?? null,
      collapsedGroups: [...new Set(programs.map((p) => p.group))].filter((g) => /^test\b/i.test(g)),
      command,
      running: this.runningRows(all, programs),
    });
  }

  /** Which runtimes have a live task for one program. */
  liveRuntimes(project, program) {
    const running = this.projects.running;
    const out = [];
    for (const execution of running.executions) {
      const d = execution.task.definition;
      if (d.projectDir !== project.dir || d.command !== 'run') continue;
      if ((d.program ?? null) !== (hasSeveralPrograms(project) ? program : null)) continue;
      out.push(runtimeOfDefinition(d));
    }
    return [...new Set(out)];
  }

  /** What is running, named the way the panel's rows read. */
  runningRows(all, programs) {
    const running = this.projects.running;
    const rows = [];
    for (const execution of running.executions) {
      const d = execution.task.definition;
      if (d.command !== 'run' && d.command !== 'boot') continue;
      const startedAt = running.startedAt.get(execution) ?? Date.now();
      const project = all.find((p) => p.dir === d.projectDir);
      const runtime = runtimeOfDefinition(d);
      const report = d.target ? readLastRun(d.projectDir, d.target, d.web === true) : null;
      const live = this.projects.live.get(rowKey(d.projectDir, d.target, d.web === true)) ?? null;
      const tree = machineTree({ command: d.command, target: d.target, startedAt }, report, live);
      const title = (d.program && programs.find((p) => p.id === d.program)?.title) || (project ? labelOf(project) : path.basename(d.projectDir || '8bs'));
      const details = [];
      if (tree?.fitted) details.push({ label: 'Hardware', value: tree.fitted });
      if (tree?.emulator) details.push({ label: 'Emulator', value: tree.emulator });
      if (tree?.outFile) details.push({ label: 'Image', value: tree.outFile, mono: true });
      if (tree?.memory?.line) details.push({ label: 'Memory', value: tree.memory.line });
      if (tree?.url) details.push({ label: 'Local URL', value: tree.url, mono: true });
      if (tree?.lanUrl) details.push({ label: 'Network URL', value: tree.lanUrl, mono: true });
      rows.push({
        id: runId(startedAt, d),
        programId: d.program ?? null,
        title,
        system: d.target ?? '',
        runtime,
        elapsed: tree?.elapsed ?? '',
        fps: typeof tree?.live?.fps === 'number' ? `${Math.round(tree.live.fps)} fps` : '',
        detail: tree?.url ?? tree?.emulator ?? '',
        url: tree?.url ?? null,
        error: tree?.live?.error ?? null,
        command: (execution.task.detail ?? '').replace(/\s+\([^)]*\)\s*$/, ''),
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

/**
 * Whether the machine has a WASM build to run a program in. The CLI's own
 * capability report wins when it gives one (`8bs targets --json`); until a
 * toolchain does, the extension's own list of the machines whose build is
 * known to work stands in.
 */
function wasmFor(machine, target) {
  const reported = target?.runtimes?.wasm ?? target?.wasm;
  if (reported && typeof reported.available === 'boolean') {
    return { ok: reported.available, reason: reported.reason };
  }
  if (machine === 'web' || WEB_PREVIEW_READY.has(machine)) return { ok: true };
  return {
    ok: false,
    reason: `The ${target?.title ?? machine} WASM build isn't ready yet, so Editor and Browser can't run it. Native runs the real emulator.`,
  };
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

module.exports = { registerLauncherView, inputsFromDefine, runId, wasmFor };
