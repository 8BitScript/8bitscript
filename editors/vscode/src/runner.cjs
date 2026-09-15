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
// under the `8bs` task type declared in package.json. Run and build pass
// `--size` so the per-function breakdown prints before the emulator starts;
// the Running machines tree reads the same numbers from dist/.8bs-last-<target>.json.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const vscode = require('vscode');

const {
  ALL_TARGETS,
  CONFIG_FILE,
  CONFIG_FILENAMES,
  MACHINE_TARGETS,
  cliCommand,
  commandArgs,
  findConfig,
  findToolchain,
  insertSystem,
  loadApps,
  loadProject,
  loadProjects,
  loadExamples,
  loadExamplesFrom,
  ofKind,
  packageManagerFor,
  packageManagerPath,
  resolvePackageManager,
  systemLine,
  withShipped,
} = require('./projects.cjs');
const settings = require('./settings.cjs');
const { selectionLabel, parseTargets } = require('./hardwareCatalog.cjs');
const { fetchStatus, livePollPlan, readLastRun, rowKey } = require('./runningMachines.cjs');
const { toolchainStatus } = require('./projectInfo.cjs');
const { checkoutCli, isCheckout, managedCheckoutDir, managedUpdateCommand, resolveCheckoutRoot, runCheckout, writeToolchainFile } = require('./checkout.cjs');

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
    this.startedAt = new WeakMap();
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
    if (!this.startedAt.has(execution)) this.startedAt.set(execution, Date.now());
    this.onChange();
  }

  /**
   * What is running, for the panel's Running machines section. `command` is
   * left in so an `install` or a `doctor` is not mistaken for a program on a
   * machine; the panel labels it accordingly.
   *
   * @returns {{ dir: string, target: string|undefined, command: string, name: string, startedAt: number }[]}
   */
  list() {
    return [...this.executions].map((execution) => {
      const definition = execution.task.definition;
      return {
        dir: definition.projectDir ?? '',
        target: definition.target,
        command: definition.command,
        name: execution.task.name,
        startedAt: this.startedAt.get(execution) ?? Date.now(),
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
function makeTask(project, action, target, region, hardware = settings.getHardware(target), extras = {}) {
  const args = commandArgs(action, target, region, extras.system ? undefined : hardware, extras);
  if (action === 'run' && target === 'web') {
    args.push('--port', '0');
    if (!settings.getWebLan()) args.push('--local');
  }
  const pal = region === 'pal' && MACHINE_TARGETS.has(target);
  const definition = {
    type: TASK_TYPE,
    command: action,
    project: relativeDir(project.dir),
    projectDir: project.dir,
    ...(target ? { target } : {}),
    ...(pal ? { pal: true } : {}),
  };
  const fitted = extras.system ? extras.system : selectionLabel(hardware);
  const suffix = extras.system
    ? ` ${extras.system}`
    : (target
      ? ` ${target}${MACHINE_TARGETS.has(target) ? ` (${regionShort(region)})` : ''}${fitted ? ` ${fitted}` : ''}`
      : '');
  const name = `${project.name}: ${action}${suffix}`;
  const invocation = cliCommand(project.toolchain) ?? { command: project.toolchain, args: [] };
  const task = new vscode.Task(
    definition,
    folderOf(project.dir) ?? vscode.TaskScope.Workspace,
    name,
    TASK_TYPE,
    new vscode.ShellExecution(
      { value: invocation.command, quoting: vscode.ShellQuoting.Strong },
      [...invocation.args, ...args],
      { cwd: project.dir, ...(invocation.env ? { env: invocation.env } : {}) },
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
  constructor(output, managedDir) {
    this.output = output;
    this.managedDir = managedDir ?? null;
    /** @type {import('./projects.cjs').Project[]} */
    this.projects = [];
    /** @type {import('./projects.cjs').Project[]} the toolchain's examples */
    this.examples = [];
    /** @type {import('./projects.cjs').Project[]} the apps that ship with the toolchain */
    this.apps = [];
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
    this.running = new RunningTasks(() => this.changed.fire());
    // Live FPS/frames from a web run's GET /status, keyed by project+target.
    this.live = new Map();
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
   * `--checkout` for this workspace: the open monorepo if it is a folder,
   * else an explicit Use local setting. The editor-owned clone is not
   * injected — it only becomes `--checkout` after the user points at it.
   */
  checkoutFlag() {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    return runCheckout({ folders, setting: settings.getCheckout() || null });
  }

  /**
   * What `8bs targets --json` says, **asked in one project's directory**,
   * cached per directory until the next refresh. Which directory matters:
   * the machine catalogs are the toolchain's, but the `hardware` and
   * `profiles` a project fits its targets with are that project's
   * `8bitscript.config.ts` (Studio asks for a 1351 on a C64), so asking in the
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
    const invocation = cliCommand(project.toolchain);
    if (!invocation) return null;
    const checkout = this.checkoutFlag();
    const pending = new Promise((resolvePromise) => {
      execFile(
        invocation.command,
        [
          ...invocation.args,
          'targets', '--json',
          ...(checkout ? ['--checkout', checkout] : []),
        ],
        {
          cwd: project.dir,
          maxBuffer: 4 * 1024 * 1024,
          ...(invocation.env ? { env: { ...process.env, ...invocation.env } } : {}),
        },
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
    const found = await vscode.workspace.findFiles(`**/{${CONFIG_FILENAMES.join(',')}}`, SEARCH_EXCLUDE);
    const checkout = this.checkoutFlag();
    this.projects = loadProjects(found.map((uri) => uri.fsPath), { checkout });
    this.targetsPromises.clear();
    const shipped = this.discoverShipped();
    const withCli = (list) => list.map((project) => ({
      ...project,
      toolchain: findToolchain(project.dir, checkout) ?? project.toolchain,
    }));
    this.examples = withCli(shipped.examples);
    this.apps = withCli(shipped.apps);
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
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => findToolchain(f.uri.fsPath, this.checkoutFlag())),
      checkoutCli(this.managedDir),
      settings.getCheckout() ? checkoutCli(settings.getCheckout()) : null,
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
      ?? loadProject(findConfig(dir) ?? path.join(dir, CONFIG_FILE));
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
  const managedDir = managedCheckoutDir(context.globalStorageUri.fsPath);
  const projects = new Projects(output, managedDir);
  projects.running.listen(context.subscriptions);
  context.subscriptions.push(projects.changed);

  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(TASK_TYPE, new TaskProvider(projects)),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(`**/{${CONFIG_FILENAMES.join(',')}}`);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => projects.refresh()),
    watcher.onDidDelete(() => projects.refresh()),
    watcher.onDidChange(() => projects.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => projects.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('8bitscript.examplesPath') || e.affectsConfiguration('8bitscript.checkout')) {
        projects.refresh();
      } else if (e.affectsConfiguration('8bitscript.showExamples')) projects.changed.fire();
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
    if (node?.project && (node?.target || node?.system)) return node;
    const project = node?.project ?? selected() ?? (await pickProject(action, projects.all));
    if (!project) return undefined;
    const named = node?.system ?? settings.getNamedSystem();
    if (named && !node?.target) {
      const systems = (await projects.loadTargets(project.dir))?.systems ?? [];
      const system = systems.find((entry) => entry.name === named);
      if (system) {
        return {
          project,
          target: system.target,
          system: named,
          region: system.region ?? settings.getRegion(),
          hardware: { profile: system.profile, options: system.hardware },
        };
      }
    }
    const machine = settings.getSystem();
    const target = node?.target
      ?? (project.targets.includes(machine) ? machine : await pickTarget(project, action));
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

  /** `<package manager> install` in a directory, as a task in its terminal. */
  function installTask(target) {
    const dir = target.dir;
    const name = target.name ?? path.basename(dir);
    const manager = target.packageManager ?? packageManagerFor(dir);
    const pathEnv = packageManagerPath();
    const bin = resolvePackageManager(manager);
    if (!path.isAbsolute(bin)) {
      vscode.window.showErrorMessage(
        `${manager} was not found. A GUI-launched editor does not read .zshrc; `
        + (manager === 'pnpm'
          ? 'the installer puts pnpm in ~/.local/share/pnpm/bin.'
          : `put ${manager} on PATH for non-login shells.`),
      );
      return null;
    }
    const task = new vscode.Task(
      { type: TASK_TYPE, command: 'install', project: relativeDir(dir), projectDir: dir },
      folderOf(dir) ?? vscode.TaskScope.Workspace,
      `${name}: install`,
      TASK_TYPE,
      new vscode.ShellExecution(
        { value: bin, quoting: vscode.ShellQuoting.Strong },
        ['install'],
        { cwd: dir, env: { PATH: pathEnv } },
      ),
    );
    task.detail = `${manager} install  (${relativeDir(dir)})`;
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
      showReuseMessage: false,
    };
    return task;
  }

  function shellTask(name, commandLine, cwd) {
    const task = new vscode.Task(
      { type: TASK_TYPE, command: 'install' },
      vscode.TaskScope.Workspace,
      name,
      TASK_TYPE,
      new vscode.ShellExecution(commandLine, { cwd, env: { PATH: packageManagerPath() } }),
    );
    task.detail = commandLine;
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
      showReuseMessage: false,
    };
    return task;
  }

  function afterTask(execution, onOk) {
    const done = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution !== execution) return;
      done.dispose();
      if (e.exitCode === 0) onOk();
    });
    context.subscriptions.push(done);
  }

  function needGitAndPnpm() {
    const git = resolvePackageManager('git');
    const pnpm = resolvePackageManager('pnpm');
    if (!path.isAbsolute(git)) {
      vscode.window.showErrorMessage('git was not found. Install git so the editor can clone 8BitScript.');
      return null;
    }
    if (!path.isAbsolute(pnpm)) {
      vscode.window.showErrorMessage(
        'pnpm was not found. A GUI-launched editor does not read .zshrc; the installer puts pnpm in ~/.local/share/pnpm/bin.',
      );
      return null;
    }
    return { git, pnpm };
  }

  /** One install for the whole 8BitScript tree — never each example or app. */
  async function updateToolchain() {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const status = toolchainStatus({
      folders,
      setting: settings.getCheckout() || null,
      managed: managedDir,
    });

    if (status.clone || status.origin === 'managed') {
      if (!managedDir) {
        vscode.window.showErrorMessage('The editor has no global storage path to clone 8BitScript into.');
        return;
      }
      const bins = needGitAndPnpm();
      if (!bins) return;
      fs.mkdirSync(path.dirname(managedDir), { recursive: true });
      const have = isCheckout(managedDir);
      if (fs.existsSync(managedDir) && !have) {
        fs.rmSync(managedDir, { recursive: true, force: true });
      }
      const { cwd, line, pull } = managedUpdateCommand({
        git: bins.git,
        pnpm: bins.pnpm,
        dest: managedDir,
        have: have || (status.origin === 'managed' && isCheckout(status.dir)),
      });
      const execution = await vscode.tasks.executeTask(
        shellTask(pull ? '8BitScript: update' : '8BitScript: install', line, cwd),
      );
      afterTask(execution, async () => {
        await projects.refresh();
        await vscode.commands.executeCommand('8bitscript.restartServer');
      });
      return;
    }

    if (!status.dir) return;
    await install({
      dir: status.dir,
      name: '8BitScript',
      packageManager: status.packageManager,
    });
  }

  async function install(node) {
    if (node?.toolchain) {
      await updateToolchain();
      return;
    }
    const target = node?.dir
      ? { dir: node.dir, name: node.name, packageManager: node.packageManager }
      : (node?.project ?? selected() ?? (await pickProject('install', projects.all)));
    if (!target) return;
    const task = installTask(target);
    if (!task) return;
    const execution = await vscode.tasks.executeTask(task);
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
    const { project, target, hardware, region, system } = resolved;
    if (!requireToolchain(project)) return;
    if (!(await requireInstalled(project))) return;
    // An explicit hardware selection (a project's own named system, from
    // launch()) rides through untouched; otherwise nothing chosen means
    // the machine's worst RAM-size config, not its catalog stock — see
    // settings.getEffectiveHardware.
    const effectiveHardware = hardware
      ?? settings.getEffectiveHardware(target, (await projects.loadTargets(project.dir))?.get(target));
    const extras = {
      system: system || undefined,
      checkout: projects.checkoutFlag() || undefined,
    };
    await vscode.tasks.executeTask(
      makeTask(project, action, target, region ?? settings.getRegion(), effectiveHardware, extras),
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
        .map((folder) => findToolchain(folder.uri.fsPath, projects.checkoutFlag()))
        .find(Boolean)
      ?? checkoutCli(managedDir);
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

  function availableCheckout() {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    return resolveCheckoutRoot({
      folders,
      setting: settings.getCheckout() || null,
      managed: managedDir,
    })?.dir ?? null;
  }

  async function useLocal(node) {
    let dir = availableCheckout();
    if (!dir) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: '8BitScript checkout',
        openLabel: 'Use this checkout',
      });
      if (!picked?.[0]) return;
      dir = picked[0].fsPath;
    }
    if (!isCheckout(dir)) {
      vscode.window.showErrorMessage(
        `'${dir}' is not an 8BitScript checkout (need pnpm-workspace.yaml listing packages/* and packages/cli/bin/8bs.mjs).`,
      );
      return;
    }
    await settings.setCheckout(dir);
    const project = node?.project ?? selected();
    if (project && !isCheckout(project.dir)) writeToolchainFile(project.dir, dir);
    await projects.refresh();
    await vscode.commands.executeCommand('8bitscript.restartServer');
  }

  async function usePublished(node) {
    await settings.setCheckout('');
    const project = node?.project ?? selected();
    if (project && !isCheckout(project.dir)) writeToolchainFile(project.dir, null);
    await projects.refresh();
    await vscode.commands.executeCommand('8bitscript.restartServer');
  }

  async function chooseSystem() {
    const currentNamed = settings.getNamedSystem();
    const current = settings.getSystem();
    const targets = await projects.loadTargets(selected()?.dir);
    const systems = (targets?.systems ?? []).map((system) => ({
      label: system.name,
      description: system.origin === 'advertised' ? 'advertised' : system.origin,
      detail: system.label === 'stock' ? system.target : `${system.target} · ${system.label}`,
      named: system.name,
      target: system.target,
    }));
    const machines = ALL_TARGETS.map((target) => ({
      label: target,
      detail: targets?.get(target)?.title,
      description: target === current && !currentNamed ? 'current' : undefined,
      named: '',
      target,
    }));
    const items = systems.length > 0
      ? [
        { label: 'Named systems', kind: vscode.QuickPickItemKind.Separator },
        ...systems,
        { label: 'Machines', kind: vscode.QuickPickItemKind.Separator },
        ...machines,
      ]
      : machines;
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Which system should Run and Build use?',
    });
    if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) return;
    await settings.setNamedSystem(picked.named);
    await settings.setSystem(picked.target);
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
        `No ${what} found. Install 8BitScript from the side bar, or install @8bitscript/cli in a project.`,
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
        system: system.name,
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
    const catalogTarget = (await projects.loadTargets(project.dir))?.get(target);
    // What the panel is actually fitted with — the stored selection, or
    // the worst-RAM default it falls back to — not just what was stored,
    // so Save writes down the machine a Run would really use.
    const hardware = settings.getEffectiveHardware(target, catalogTarget);
    const region = settings.getRegion();
    // Whether this machine has a region at all is the toolchain's answer,
    // not this extension's: writing `region: 'pal'` for a machine the CLI
    // says has none would make a config it refuses, and the panel would
    // lose its systems over a Save it was asked to do.
    const hasRegion = catalogTarget?.region ?? false;
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
        `${path.basename(project.configPath)} is not a plain "export default { … }", so the system was not written for you — it is at your cursor to place.`,
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
  command('8bitscript.useLocal', useLocal);
  command('8bitscript.usePublished', usePublished);
  command('8bitscript.run', (node) => execute('run', node));
  command('8bitscript.build', (node) => execute('build', node));
  command('8bitscript.boot', (node) => execute('boot', node));
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
  startLivePoll(projects, context);
  return projects;
}

/**
 * While a run or boot is in flight, reread dist/.8bs-last-<target>.json
 * (compile writes it before the emulator starts) and, when the report
 * names a web URL, poll GET /status for FPS. VICE's binary monitor pauses
 * the machine on any command, so a PET run shows elapsed time and the
 * compile report rather than live registers.
 *
 * @param {Projects} projects
 * @param {vscode.ExtensionContext} context
 */
function startLivePoll(projects, context) {
  let lastStamp = '';
  const tick = async () => {
    const rows = projects.running.list().filter((row) => row.command === 'run' || row.command === 'boot');
    if (rows.length === 0) {
      if (projects.live.size > 0) {
        projects.live.clear();
        projects.changed.fire();
      }
      return;
    }
    let changed = false;
    const reports = new Map();
    for (const row of rows) {
      reports.set(rowKey(row.dir, row.target), readLastRun(row.dir, row.target));
    }
    const plan = livePollPlan(rows, reports);
    for (const { key, url } of plan.fetches) {
      const status = await fetchStatus(url);
      const prev = projects.live.get(key);
      if (status && JSON.stringify(status) !== JSON.stringify(prev)) {
        projects.live.set(key, status);
        changed = true;
      }
    }
    for (const key of [...projects.live.keys()]) {
      if (!plan.seen.has(key)) {
        projects.live.delete(key);
        changed = true;
      }
    }
    if (plan.stamp !== lastStamp) {
      lastStamp = plan.stamp;
      changed = true;
    }
    if (changed) projects.changed.fire();
  };
  const timer = setInterval(() => { tick().catch(() => {}); }, 1000);
  context.subscriptions.push({ dispose() { clearInterval(timer); } });
}

module.exports = { Projects, RunningTasks, labelOf, makeTask, registerRunner, whereLabel };
