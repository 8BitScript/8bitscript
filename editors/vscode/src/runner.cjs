// What the side bar actually does: find the projects, ask the toolchain
// about the machines, and start `8bs` as an editor task.
//
// This is the half of the old projectsView.cjs that survived the tree. The
// tree is gone — the side bar is one launcher panel now (launcherView.cjs)
// — but nothing about *running* changed, and none of it ever belonged to
// the tree: the project scan, the `8bs targets --json` cache, the task
// each button starts, and the commands the palette offers all live here,
// with no view attached.
//
// Like the view it replaced, this module contains no build logic of its
// own: every action is the same `8bs` command a person would type, started
// in the project's own directory with the project's own toolchain. Runs go
// through the editor's task system rather than a hidden child process so
// that output lands in a terminal, a running emulator can be stopped from
// the panel, and the same invocation can be written down in tasks.json
// under the `8bs` task type declared in package.json.
const path = require('path');
const { execFile } = require('child_process');

const vscode = require('vscode');

const {
  ALL_TARGETS,
  CONFIG_FILE,
  MACHINE_TARGETS,
  commandArgs,
  findToolchain,
  insertSystem,
  loadApps,
  loadProject,
  loadProjects,
  loadExamples,
  loadExamplesFrom,
  ofKind,
  systemLine,
  withShipped,
} = require('./projects.cjs');
const settings = require('./settings.cjs');
const { selectionLabel, parseTargets } = require('./hardwareCatalog.cjs');

const { regionShort } = settings;

const TASK_TYPE = '8bs';

// Passing an explicit exclude replaces the editor's files.exclude defaults, so
// everything that hides a project copy has to be listed here: installed
// packages, git internals, and the per-session worktrees the agent tooling
// keeps under .claude/worktrees, each a whole second checkout of the repo.
const SEARCH_EXCLUDE = '{**/node_modules/**,**/.git/**,**/.claude/worktrees/**}';

/** The workspace folder a directory belongs to, for scoping tasks. */
function folderOf(dir) {
  return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir));
}

/** A project directory shown relative to its workspace folder. */
function relativeDir(dir) {
  const folder = folderOf(dir);
  if (!folder) return dir;
  const relative = path.relative(folder.uri.fsPath, dir);
  if (relative === '') return path.basename(dir);
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1
    ? path.join(folder.name, relative)
    : relative;
}

/**
 * Where a project lives, as the grey half of its name in the dropdown: a
 * workspace project's relative path, a shipped example's place in its
 * package (`examples/hello`), or an app's package name.
 */
function whereLabel(project) {
  if (project.kind === 'app') return project.name;
  if (!project.shipped) return relativeDir(project.dir);
  return path.join(path.basename(path.dirname(project.dir)), path.basename(project.dir));
}

/** The name a project is shown by: a shipped app's or example's title, otherwise the package name. */
function labelOf(project) {
  return project.kind === 'project' ? project.name : project.title;
}

/**
 * Tracks which `8bs` tasks are running, so the panel can list them and the
 * Stop button can end them. Keyed by the task definition, which is what
 * both the panel and tasks.json-launched runs have in common.
 */
class RunningTasks {
  constructor(onChange) {
    this.executions = new Set();
    this.onChange = onChange;
  }

  listen(subscriptions) {
    for (const execution of vscode.tasks.taskExecutions) this.track(execution);
    subscriptions.push(
      vscode.tasks.onDidStartTask((e) => this.track(e.execution)),
      vscode.tasks.onDidEndTask((e) => {
        if (this.executions.delete(e.execution)) this.onChange();
      }),
    );
  }

  track(execution) {
    if (execution.task.definition.type !== TASK_TYPE) return;
    this.executions.add(execution);
    this.onChange();
  }

  /**
   * What is running, for the panel's Running section. `command` is left in
   * so an `install` or a `doctor` is not mistaken for a program on a
   * machine; the panel labels it accordingly.
   *
   * @returns {{ dir: string, target: string|undefined, command: string, name: string }[]}
   */
  list() {
    return [...this.executions].map((execution) => {
      const definition = execution.task.definition;
      return {
        dir: definition.projectDir ?? '',
        target: definition.target,
        command: definition.command,
        name: execution.task.name,
      };
    });
  }

  /** @param {string} dir @param {string} [target] */
  matching(dir, target) {
    return [...this.executions].filter((execution) => {
      const definition = execution.task.definition;
      if (definition.projectDir !== dir) return false;
      return target === undefined || definition.target === target;
    });
  }

  stop(dir, target) {
    for (const execution of this.matching(dir, target)) execution.terminate();
  }
}

/**
 * Build the task for one `8bs` invocation.
 *
 * The definition carries `projectDir` as an absolute path so running-state
 * lookups are exact; `project` is the workspace-relative spelling that a
 * person would write in tasks.json.
 *
 * `hardware` defaults to what the panel is set to for that machine, and is
 * given explicitly when the run is not the panel's — launching a shipped
 * app on one of the systems *its* config declares should not rewrite the
 * hardware someone has fitted for their own work.
 */
function makeTask(project, action, target, region, hardware = settings.getHardware(target)) {
  const args = commandArgs(action, target, region, hardware);
  const pal = region === 'pal' && MACHINE_TARGETS.has(target);
  const definition = {
    type: TASK_TYPE,
    command: action,
    project: relativeDir(project.dir),
    projectDir: project.dir,
    ...(target ? { target } : {}),
    ...(pal ? { pal: true } : {}),
  };
  const fitted = selectionLabel(hardware);
  const suffix = target
    ? ` ${target}${MACHINE_TARGETS.has(target) ? ` (${regionShort(region)})` : ''}${fitted ? ` ${fitted}` : ''}`
    : '';
  const name = `${project.name}: ${action}${suffix}`;
  const task = new vscode.Task(
    definition,
    folderOf(project.dir) ?? vscode.TaskScope.Workspace,
    name,
    TASK_TYPE,
    new vscode.ShellExecution(
      { value: project.toolchain, quoting: vscode.ShellQuoting.Strong },
      args,
      { cwd: project.dir },
    ),
  );
  task.detail = `8bs ${args.join(' ')}  (${definition.project})`;
  if (action === 'build') task.group = vscode.TaskGroup.Build;
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    showReuseMessage: false,
  };
  return task;
}

/**
 * Everything the launcher is a view of: the projects in the workspace, the
 * apps and examples the toolchain brought along, what each machine can be
 * fitted with, and what is running.
 */
class Projects {
  constructor(output) {
    this.output = output;
    /** @type {import('./projects.cjs').Project[]} */
    this.projects = [];
    /** @type {import('./projects.cjs').Project[]} the toolchain's examples */
    this.examples = [];
    /** @type {import('./projects.cjs').Project[]} the apps that ship with the toolchain */
    this.apps = [];
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
    this.running = new RunningTasks(() => this.changed.fire());
    // `8bs targets --json` per project directory: a project's own hardware
    // and profiles come from its config, so the answer is not shared.
    this.targetsPromises = new Map();
  }

  /**
   * What the Project dropdown offers: the workspace's own projects, the
   * apps the toolchain ships (always — they are the point of shipping
   * them), and its examples unless hidden (`8bitscript.showExamples`).
   * They sit in a group of their own, so the workspace's projects stay
   * first and easy to reach.
   */
  get visible() {
    const shipped = settings.getShowExamples() ? [...this.examples, ...this.apps] : this.apps;
    return withShipped(this.projects, shipped);
  }

  /** Every project there is, listed or not — what a command resolves against. */
  get all() {
    return withShipped(this.projects, [...this.examples, ...this.apps]);
  }

  /**
   * Whether offering the toggle would change anything. Inside the
   * repository the examples are already workspace projects, so there is
   * nothing to add and the button stays hidden.
   */
  hasExamples() {
    const own = new Set(this.projects.map((p) => p.dir));
    return this.examples.some((example) => !own.has(example.dir));
  }

  /**
   * What `8bs targets --json` says, **asked in one project's directory**,
   * cached per directory until the next refresh. Which directory matters:
   * the machine catalogs are the toolchain's, but the `hardware` and
   * `profiles` a project fits its targets with are that project's
   * `8bs.config.ts` (Studio asks for a 1351 on a C64), so asking in the
   * wrong directory shows the panel someone else's stock machine. Falls
   * back to the first project with a toolchain when `dir` names none, and
   * null when no toolchain can be found or the command fails — the
   * launcher then shows the fixed target list and no hardware.
   *
   * @param {string} [dir] the project to ask in
   * @returns {Promise<Map<string, object>|null>}
   */
  async loadTargets(dir) {
    const all = this.all;
    const project = (dir && all.find((p) => p.dir === dir && p.toolchain))
      ?? all.find((p) => p.toolchain);
    if (!project) return null;
    const cached = this.targetsPromises.get(project.dir);
    if (cached) return cached;
    const pending = new Promise((resolvePromise) => {
      execFile(
        project.toolchain,
        ['targets', '--json'],
        { cwd: project.dir, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            this.output?.appendLine(`8bs targets --json failed: ${error.message}`);
            resolvePromise(null);
            return;
          }
          try {
            resolvePromise(parseTargets(stdout));
          } catch (parseError) {
            this.output?.appendLine(`8bs targets --json: unreadable output: ${parseError.message}`);
            resolvePromise(null);
          }
        },
      );
    });
    this.targetsPromises.set(project.dir, pending);
    return pending;
  }

  async refresh() {
    const found = await vscode.workspace.findFiles(`**/${CONFIG_FILE}`, SEARCH_EXCLUDE);
    this.projects = loadProjects(found.map((uri) => uri.fsPath));
    this.targetsPromises.clear();
    const shipped = this.discoverShipped();
    this.examples = shipped.examples;
    this.apps = shipped.apps;
    this.output.appendLine(
      `Projects: ${this.projects.length === 0 ? 'none found' : this.projects.map((p) => p.name).join(', ')}` +
        (this.examples.length > 0 ? `; examples: ${this.examples.map((p) => p.name).join(', ')}` : '') +
        (this.apps.length > 0 ? `; apps: ${this.apps.map((p) => p.name).join(', ')}` : ''),
    );
    // The toggle in the view's title bar is only offered when there is
    // something for it to show.
    await vscode.commands.executeCommand('setContext', '8bitscript.hasExamples', this.hasExamples());
    this.changed.fire();
  }

  /**
   * What ships with the toolchain in use: its apps, and the examples
   * `@8bitscript/examples` names. Both are looked for beside the first
   * toolchain that has them — a project's own, or the workspace folder's —
   * so a workspace with one 8BitScript project that has installed the CLI
   * has them. An explicit `8bitscript.examplesPath` names a directory of
   * examples instead.
   *
   * @returns {{ examples: import('./projects.cjs').Project[], apps: import('./projects.cjs').Project[] }}
   */
  discoverShipped() {
    const explicit = settings.getExamplesPath();
    let examples = explicit ? loadExamplesFrom(explicit) : [];
    let apps = [];
    const toolchains = [
      ...this.projects.map((p) => p.toolchain),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => findToolchain(f.uri.fsPath)),
    ].filter(Boolean);
    for (const toolchain of toolchains) {
      if (!explicit && examples.length === 0) examples = loadExamples(toolchain);
      if (apps.length === 0) apps = loadApps(toolchain);
      if (examples.length > 0 && apps.length > 0) break;
    }
    return { examples, apps };
  }
}

/**
 * Provide the launcher's run/build tasks to "Tasks: Run Task", and resolve
 * the `8bs` entries a person writes in tasks.json into something executable.
 */
class TaskProvider {
  constructor(projects) {
    this.projects = projects;
  }

  provideTasks() {
    const tasks = [];
    for (const project of this.projects.all) {
      if (!project.toolchain) continue;
      for (const target of project.targets) {
        tasks.push(makeTask(project, 'run', target, 'ntsc'));
        tasks.push(makeTask(project, 'build', target, 'ntsc'));
      }
    }
    return tasks;
  }

  resolveTask(task) {
    const definition = task.definition;
    if (definition.type !== TASK_TYPE || !definition.command) return undefined;

    const folder = task.scope && typeof task.scope === 'object' && 'uri' in task.scope
      ? task.scope
      : vscode.workspace.workspaceFolders?.[0];
    const dir = definition.projectDir
      ?? path.resolve(folder?.uri.fsPath ?? process.cwd(), definition.project ?? '.');
    const project = this.projects.all.find((p) => p.dir === dir)
      ?? loadProject(path.join(dir, CONFIG_FILE));
    if (!project.toolchain) return undefined;

    const resolved = makeTask(
      project,
      definition.command,
      definition.target,
      definition.pal ? 'pal' : 'ntsc',
    );
    // The task must keep the definition object it was given, or the editor
    // treats the resolved task as a different one from the tasks.json entry.
    return new vscode.Task(
      definition,
      task.scope ?? vscode.TaskScope.Workspace,
      task.name,
      TASK_TYPE,
      resolved.execution,
    );
  }
}

/**
 * Wire the project model, the task provider, and every command into the
 * extension. The launcher view is registered separately and reads this.
 *
 * @param {vscode.ExtensionContext} context
 * @param {vscode.LogOutputChannel} output
 * @returns {Projects}
 */
function registerRunner(context, output) {
  const projects = new Projects(output);
  projects.running.listen(context.subscriptions);
  context.subscriptions.push(projects.changed);

  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(TASK_TYPE, new TaskProvider(projects)),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE}`);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => projects.refresh()),
    watcher.onDidDelete(() => projects.refresh()),
    watcher.onDidChange(() => projects.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => projects.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('8bitscript.examplesPath')) projects.refresh();
      else if (e.affectsConfiguration('8bitscript.showExamples')) projects.changed.fire();
    }),
  );

  /** The project the panel acts on: the chosen one, or the first offered. */
  function selected() {
    const chosen = settings.getProject();
    // Resolved against every project, so a chosen example stays chosen
    // while the examples are hidden; the fallback is the visible list, so
    // "whichever comes first" never means one that is not on offer.
    return projects.all.find((project) => project.dir === chosen)
      ?? projects.visible[0] ?? projects.all[0] ?? null;
  }

  /**
   * The project and system an action applies to. The panel passes both; a
   * palette invocation passes nothing and is asked.
   */
  async function targetOf(node, action) {
    if (node?.project && node?.target) return node;
    const project = node?.project ?? selected() ?? (await pickProject(action, projects.all));
    if (!project) return undefined;
    const system = settings.getSystem();
    const target = node?.target
      ?? (project.targets.includes(system) ? system : await pickTarget(project, action));
    return target ? { project, target } : undefined;
  }

  async function pickProject(action, candidates) {
    if (projects.all.length === 0) await projects.refresh();
    if (candidates.length === 0) {
      vscode.window.showInformationMessage(
        `No 8BitScript projects found. A project is a directory with an ${CONFIG_FILE}.`,
      );
      return undefined;
    }
    if (candidates.length === 1) return candidates[0];
    const picked = await vscode.window.showQuickPick(
      candidates.map((project) => ({
        label: labelOf(project),
        description: whereLabel(project),
        detail: project.description || undefined,
        project,
      })),
      { placeHolder: `Which project to ${action}?` },
    );
    return picked?.project;
  }

  /** The selected system is offered first so Enter picks it. */
  async function pickTarget(project, action) {
    if (project.targets.length === 1) return project.targets[0];
    const preferred = settings.getSystem();
    const ordered = [...project.targets].sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
    const picked = await vscode.window.showQuickPick(
      ordered.map((target) => ({
        label: target,
        description: target === preferred ? 'selected system' : undefined,
        target,
      })),
      { placeHolder: `Which system to ${action} ${labelOf(project)} on?` },
    );
    return picked?.target;
  }

  /** `<package manager> install` in the project, as a task in its terminal. */
  function installTask(project) {
    const task = new vscode.Task(
      { type: TASK_TYPE, command: 'install', project: relativeDir(project.dir), projectDir: project.dir },
      folderOf(project.dir) ?? vscode.TaskScope.Workspace,
      `${project.name}: install`,
      TASK_TYPE,
      new vscode.ShellExecution(project.packageManager, ['install'], { cwd: project.dir }),
    );
    task.detail = `${project.packageManager} install  (${relativeDir(project.dir)})`;
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
      showReuseMessage: false,
    };
    return task;
  }

  async function install(node) {
    const project = node?.project ?? selected() ?? (await pickProject('install', projects.all));
    if (!project) return;
    const execution = await vscode.tasks.executeTask(installTask(project));
    // Rescan once the install finishes, so the warning clears on its own.
    const done = vscode.tasks.onDidEndTask((e) => {
      if (e.execution === execution) {
        done.dispose();
        projects.refresh();
      }
    });
    context.subscriptions.push(done);
  }

  /**
   * A project whose dependencies are missing fails inside the compiler with
   * a message about the first package it cannot find, which says nothing
   * about the install. Offer the install instead of letting that happen.
   */
  async function requireInstalled(project) {
    if (project.installed) return true;
    const choice = await vscode.window.showWarningMessage(
      `${project.name} has dependencies that are not installed.`,
      { modal: false },
      `Run ${project.packageManager} install`,
      'Run anyway',
    );
    if (choice === 'Run anyway') return true;
    if (choice) await install({ project });
    return false;
  }

  function requireToolchain(project) {
    if (project.toolchain) return true;
    output.appendLine(`No 8bs toolchain for ${project.name}: searched upward from ${project.dir}`);
    vscode.window
      .showErrorMessage(
        `No 8bs toolchain found for ${project.name}. Run ${project.packageManager} install in ` +
          `${whereLabel(project)}, or ${project.packageManager} add -D @8bitscript/cli.`,
        'Refresh',
      )
      .then((choice) => choice === 'Refresh' && projects.refresh());
    return false;
  }

  async function execute(action, node) {
    const resolved = await targetOf(node, action);
    if (!resolved) return;
    const { project, target, hardware, region } = resolved;
    if (!requireToolchain(project)) return;
    if (!(await requireInstalled(project))) return;
    await vscode.tasks.executeTask(
      makeTask(project, action, target, region ?? settings.getRegion(), hardware),
    );
  }

  async function doctor() {
    if (projects.projects.length === 0) await projects.refresh();
    // The selected project when it has a toolchain of its own, since that
    // is the one whose install doctor should report on; any project with
    // one otherwise.
    const chosen = selected();
    const project = chosen?.toolchain ? chosen : projects.all.find((p) => p.toolchain);
    // A workspace with no project can still have the CLI installed at its
    // root, and doctor is the command that tells someone whether their
    // emulators are ready — worth finding it either way.
    const toolchain = project?.toolchain
      ?? (vscode.workspace.workspaceFolders ?? [])
        .map((folder) => findToolchain(folder.uri.fsPath))
        .find(Boolean);
    if (!toolchain) {
      vscode.window.showErrorMessage('No 8bs toolchain found in this workspace. Run: pnpm add -D @8bitscript/cli (or npm/yarn/bun)');
      return;
    }
    const dir = project?.dir ?? path.dirname(path.dirname(path.dirname(toolchain)));
    await vscode.tasks.executeTask(makeTask(
      project ?? { name: '8bs', dir, toolchain, targets: [] },
      'doctor',
      undefined,
      'ntsc',
    ));
  }

  async function chooseProject() {
    const project = await pickProject('run', projects.all);
    if (project) await settings.setProject(project.dir);
  }

  async function chooseSystem() {
    const current = settings.getSystem();
    const targets = await projects.loadTargets(selected()?.dir);
    const picked = await vscode.window.showQuickPick(
      ALL_TARGETS.map((target) => ({
        label: target,
        detail: targets?.get(target)?.title,
        description: target === current ? 'current' : undefined,
        target,
      })),
      { placeHolder: 'Which system should Run and Build use?' },
    );
    if (picked) await settings.setSystem(picked.target);
  }

  async function chooseRegion() {
    const current = settings.getRegion();
    const picked = await vscode.window.showQuickPick(
      settings.REGIONS.map((r) => ({
        label: `${r.label} — ${r.place}`,
        detail: r.id === 'ntsc' ? `${r.hz} — the default machine model` : `${r.hz} — passes --pal to 8bs`,
        description: r.id === current ? 'current' : undefined,
        region: r.id,
      })),
      { placeHolder: 'Which region should the machines that have one use?' },
    );
    if (picked) await settings.setRegion(picked.region);
  }

  /**
   * Launch something the toolchain ships — an app, or an example — without
   * making it the selected project: pick it when there is a choice, pick
   * the system to open it on (the selected system first), run.
   */
  async function launch(kind, what, filter = () => true) {
    if (projects.all.length === 0) await projects.refresh();
    const candidates = ofKind(projects.all, kind).filter(filter);
    if (candidates.length === 0) {
      vscode.window.showInformationMessage(
        kind === 'app'
          ? `No ${what} found. Apps ship with @8bitscript/cli: install it in a project, then refresh.`
          : `No ${what} found. Examples ship with @8bitscript/cli: install it in a project, then refresh.`,
      );
      return;
    }
    const project = candidates.length === 1 ? candidates[0] : await pickProject('launch', candidates);
    if (!project) return;
    // What the program was set up for, when its config says: Studio on a
    // stock VIC-20 is a viewer and on an expanded one an editor, and that
    // is a choice worth offering by name rather than as `vic20`.
    const systems = (await projects.loadTargets(project.dir))?.systems ?? [];
    if (systems.length > 0) {
      const picked = await vscode.window.showQuickPick(
        systems.map((system) => ({
          label: system.name,
          description: system.target,
          detail: system.label === 'stock' ? undefined : system.label,
          system,
        })),
        { placeHolder: `Which ${labelOf(project)} to launch?` },
      );
      if (!picked) return;
      const { system } = picked;
      await execute('run', {
        project,
        target: system.target,
        region: system.region ?? settings.getRegion(),
        hardware: { profile: system.profile, options: system.hardware },
      });
      return;
    }
    const target = await pickTarget(project, 'launch');
    if (!target) return;
    await execute('run', { project, target });
  }

  /**
   * Write what the panel is set to into the project's config as a named
   * system, so it is one choice next time — and one the whole team gets,
   * since the config is the project's rather than this editor's.
   *
   * The config is source, not a settings file, so the write goes through
   * the editor's own edit: it lands in the undo stack, an open buffer
   * stays in step, and a config this cannot safely rewrite is opened with
   * the entry to paste rather than guessed at.
   */
  async function saveSystem() {
    const project = selected();
    if (!project) {
      vscode.window.showInformationMessage(`No project to save a system into. A project is a directory with an ${CONFIG_FILE}.`);
      return;
    }
    const target = settings.getSystem();
    if (!project.targets.includes(target)) {
      vscode.window.showWarningMessage(`${labelOf(project)} does not target ${target}, so it cannot be one of its systems.`);
      return;
    }
    const hardware = settings.getHardware(target);
    const region = settings.getRegion();
    // Whether this machine has a region at all is the toolchain's answer,
    // not this extension's: writing `region: 'pal'` for a machine the CLI
    // says has none would make a config it refuses, and the panel would
    // lose its systems over a Save it was asked to do.
    const hasRegion = (await projects.loadTargets(project.dir))?.get(target)?.region ?? false;
    const entry = {
      target,
      profile: hardware.profile,
      hardware: hardware.options,
      region: hasRegion && region === 'pal' ? 'pal' : null,
    };
    const fitted = selectionLabel(hardware);
    const name = await vscode.window.showInputBox({
      title: `Save a system in ${labelOf(project)}`,
      prompt: `8bs run ${commandArgs('run', target, region, hardware).slice(1).join(' ')}`,
      value: fitted ? `${target} — ${fitted}` : target,
      validateInput: (value) => (value.trim() === '' ? 'A system needs a name.' : undefined),
    });
    if (name === undefined) return;

    const uri = vscode.Uri.file(project.configPath);
    const document = await vscode.workspace.openTextDocument(uri);
    const updated = insertSystem(document.getText(), name.trim(), entry);
    const editor = await vscode.window.showTextDocument(document);
    if (updated === null) {
      // Not a shape to rewrite — hand the person the same line the write
      // would have made, at their cursor, and let them place it.
      const line = systemLine(name.trim(), entry);
      await editor.edit((builder) => builder.insert(editor.selection.active, `systems: {\n  ${line}\n},\n`));
      vscode.window.showInformationMessage(
        `${CONFIG_FILE} is not a plain "export default { … }", so the system was not written for you — it is at your cursor to place.`,
      );
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), updated);
    await vscode.workspace.applyEdit(edit);
    await document.save();
    projects.refresh();
  }

  const command = (id, handler) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  command('8bitscript.refresh', () => projects.refresh());
  command('8bitscript.toggleExamples', () => settings.setShowExamples(!settings.getShowExamples()));
  command('8bitscript.saveSystem', saveSystem);
  command('8bitscript.selectProject', chooseProject);
  command('8bitscript.selectSystem', chooseSystem);
  command('8bitscript.selectRegion', chooseRegion);
  command('8bitscript.launchStudio', () => launch('app', 'Studio', (p) => p.name === '@8bitscript/studio'));
  command('8bitscript.launchApp', () => launch('app', 'apps'));
  command('8bitscript.launchExample', () => launch('example', 'examples'));
  command('8bitscript.doctor', doctor);
  command('8bitscript.install', install);
  command('8bitscript.run', (node) => execute('run', node));
  command('8bitscript.build', (node) => execute('build', node));
  command('8bitscript.stop', (node) => {
    if (node?.dir) projects.running.stop(node.dir, node.target);
    else for (const execution of projects.running.executions) execution.terminate();
  });
  command('8bitscript.openConfig', (node) => {
    const project = node?.project ?? selected();
    if (project) vscode.window.showTextDocument(vscode.Uri.file(project.configPath));
  });
  command('8bitscript.openEntry', (node) => {
    const project = node?.project ?? selected();
    if (project) vscode.window.showTextDocument(vscode.Uri.file(project.entry));
  });

  projects.refresh();
  return projects;
}

module.exports = { Projects, RunningTasks, labelOf, makeTask, registerRunner, whereLabel };
