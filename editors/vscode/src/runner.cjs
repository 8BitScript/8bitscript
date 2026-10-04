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
  hasSeveralPrograms,
  insertSystem,
  doctorWantFromSelection,
  loadApps,
  loadProject,
  loadProjects,
  loadExamples,
  loadExamplesFrom,
  ofKind,
  packageManagerFor,
  packageManagerPath,
  programTargets,
  resolvePackageManager,
  resolveProgram,
  systemLine,
  withShipped,
} = require('./projects.cjs');
const { ALL_TARGETS: STUDIO_MACHINES } = require('./projects.cjs');
/** The bare machine ids the Studio menu can name, as opposed to a named system. */
const MACHINES_FOR_STUDIO = new Set(STUDIO_MACHINES);
const settings = require('./settings.cjs');
const { selectionLabel, parseTargets } = require('./hardwareCatalog.cjs');
const { fetchStatus, livePollPlan, readLastRun, rowKey } = require('./runningMachines.cjs');
const { toolchainStatus } = require('./projectInfo.cjs');
const { checkoutCli, isCheckout, managedCheckoutDir, managedUpdateCommand, resolveCheckoutRoot, runCheckout, writeToolchainFile } = require('./checkout.cjs');
const { AssemblyViewController } = require('./assemblyView.cjs');
const { quietly } = require('./quietly.cjs');
const units = require('./units.cjs');
const { UnitState } = require('./unitState.cjs');

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

/** How a task definition is told apart from its siblings: see units.runKey. */
function runIdOf(definition) {
  return units.runKey({
    dir: definition.projectDir ?? '',
    program: definition.program ?? null,
    system: definition.system ?? null,
    target: definition.target ?? null,
    runtime: definition.runtime ?? (definition.web === true ? 'editor' : 'native'),
  });
}

/**
 * Tracks which `8bs` tasks are running, so the panel can list them and the
 * Stop button can end them. Keyed by the task definition, which is what
 * both the panel and tasks.json-launched runs have in common.
 *
 * A run is identified by (project, program, system, runtime): the same
 * program on the same system in the same runtime is one run, and another
 * runtime of it is another run beside it, so the editor's tab and the
 * native emulator can be compared side by side.
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
   * What is running, for the panel's Running section. `command` is left in
   * so an `install` or a `doctor` is not mistaken for a program on a
   * machine; the panel labels it accordingly.
   *
   * `runId` names the run for `stopRun`; `commandLine` is the exact `8bs`
   * command it was started with, for the panel's Command line.
   *
   * @returns {{ runId: string, dir: string, target: string|undefined, program: string|undefined,
   *   system: string|undefined, runtime: 'editor'|'browser'|'native'|undefined, command: string,
   *   web: boolean, name: string, commandLine: string|undefined, startedAt: number }[]}
   */
  list() {
    return [...this.executions].map((execution) => {
      const definition = execution.task.definition;
      return {
        runId: runIdOf(definition),
        dir: definition.projectDir ?? '',
        target: definition.target,
        program: definition.program,
        system: definition.system,
        runtime: definition.runtime,
        command: definition.command,
        web: definition.web === true,
        name: execution.task.name,
        commandLine: definition.commandLine,
        startedAt: this.startedAt.get(execution) ?? Date.now(),
      };
    });
  }

  /**
   * @param {string} dir
   * @param {string} [target]
   * @param {{ web?: boolean, runtime?: string, program?: string }} [only] `web: true` keeps only runs of
   *   the wasm page (the editor's tab or the browser), `web: false` only native ones; `runtime`
   *   and `program` narrow further. Left out, everything of that project and target.
   */
  matching(dir, target, only = {}) {
    return [...this.executions].filter((execution) => {
      const definition = execution.task.definition;
      if (definition.projectDir !== dir) return false;
      if (only.web !== undefined && (definition.web === true) !== only.web) return false;
      if (only.runtime !== undefined && (definition.runtime ?? (definition.web === true ? 'editor' : 'native')) !== only.runtime) return false;
      if (only.program !== undefined && definition.program !== only.program) return false;
      return target === undefined || definition.target === target;
    });
  }

  stop(dir, target, only = {}) {
    for (const execution of this.matching(dir, target, only)) execution.terminate();
  }

  /** The run `runId` names, if it is still going. */
  find(runId) {
    return [...this.executions].find((execution) => runIdOf(execution.task.definition) === runId);
  }

  /** Stop exactly one run, leaving every other — its sibling runtimes included — alone. */
  stopRun(runId) {
    const found = this.find(runId);
    if (found) found.terminate();
    return found !== undefined;
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
  // Which runtime a run is. `runtime` is the model's word; `web` is the
  // older spelling of "the editor's tab" and stays an alias for it. The
  // synthetic `web` target is itself a browser page, so a plain run of it is
  // the Browser runtime. Nothing here falls back to a hidden rule: a caller
  // that wants a wasm page says so.
  const runtime = action === 'run'
    ? (extras.runtime ?? (extras.web ? 'editor' : (target === 'web' ? 'browser' : 'native')))
    : undefined;
  const args = commandArgs(action, target, region, extras.system ? undefined : hardware, extras);
  // Studio's own tab is always cx16, and always wants the CLI's WebAssembly
  // x16emu, not the lightweight preview every other --web build (and a
  // plain project's own cx16 target) gets — extras.x16emu is how it asks.
  if (runtime) args.push(...units.runtimeArgs(runtime, target, { x16emu: extras.x16emu === true, webLan: settings.getWebLan() }));
  const wasm = runtime === 'editor' || runtime === 'browser';
  if ((action === 'run' || action === 'boot') && target === 'cx16' && !wasm) {
    args.push(...settings.cx16NativeWindowCliArgs({ studio: project.name === '@8bitscript/studio' }));
  }
  const regional = extras.regional ?? MACHINE_TARGETS.has(target);
  const pal = region === 'pal' && regional;
  const definition = {
    type: TASK_TYPE,
    command: action,
    project: relativeDir(project.dir),
    projectDir: project.dir,
    ...(target ? { target } : {}),
    ...(extras.program ? { program: extras.program } : {}),
    ...(extras.system ? { system: extras.system } : {}),
    ...(pal ? { pal: true } : {}),
    // `web` keys the last-run report (dist/.8bs-last-<target>-web.json), so
    // it marks a wasm page of a real machine, in a tab or a browser. The
    // synthetic web target keeps its one file.
    ...(wasm && target !== 'web' ? { web: true } : {}),
    ...(runtime ? { runtime } : {}),
    ...(extras.inputs && Object.keys(extras.inputs).length > 0 ? { define: extras.inputs } : {}),
    ...(extras.locale ? { locale: extras.locale } : {}),
    commandLine: units.formatCommand(args),
  };
  const fitted = extras.system ? extras.system : selectionLabel(hardware);
  const suffix = extras.system
    ? ` ${extras.system}`
    : (target
      ? ` ${target}${regional ? ` (${regionShort(region)})` : ''}${fitted ? ` ${fitted}` : ''}`
      : '');
  const where = runtime === 'editor' ? ' in a tab' : (runtime === 'browser' && target !== 'web' ? ' in the browser' : '');
  const name = `${project.name}: ${action}${extras.program ? ` ${extras.program}` : ''}${suffix}${where}`;
  const invocation = cliCommand(project.toolchain) ?? { command: project.toolchain, args: [] };
  const env = { PATH: packageManagerPath(), ...invocation.env };
  const task = new vscode.Task(
    definition,
    folderOf(project.dir) ?? vscode.TaskScope.Workspace,
    name,
    TASK_TYPE,
    new vscode.ShellExecution(
      { value: invocation.command, quoting: vscode.ShellQuoting.Strong },
      [...invocation.args, ...args],
      { cwd: project.dir, env },
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
    // `8bs doctor --json` is about this host, not a project. One report
    // for the workspace; refresh() and a finished Doctor task clear it.
    this.doctorPromise = null;
    // `8bs project --json` per project, cached by the config's mtime and
    // dropped when a source file is saved (a program's inputs are read from
    // its source). The loader falls back to the regex reader for a CLI that
    // predates the command.
    this.units = new units.UnitLoader({
      exec: (project, args) => this.runCli(project, args),
      log: (line) => this.output?.appendLine(line),
    });
    // What the launcher remembers per program; registerRunner gives it a
    // workspaceState to keep it in.
    /** @type {UnitState} */
    this.unitState = new UnitState({ get: (_key, fallback) => fallback, update: async () => {} });
    // `8bs targets --json` per directory once it has answered, for the code
    // that cannot wait on a promise (the task provider's list).
    this.targetRows = new Map();
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
   * `8bitscript.config.8bs` (Studio asks for a 1351 on a C64), so asking in the
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
    // Remembered for the code that cannot wait on the promise; `pending` itself never rejects.
    void pending.then((rows) => { if (rows) this.targetRows.set(project.dir, rows); });
    this.targetsPromises.set(project.dir, pending);
    return pending;
  }

  /**
   * Run `8bs <args>` in a project's directory with its own toolchain (and the
   * workspace's `--checkout`). Never rejects: `{ code, stdout }` is the
   * whole answer, and a project with no toolchain answers `{ code: -1 }`.
   *
   * @param {{ dir: string, toolchain: any }} project
   * @param {string[]} args
   * @returns {Promise<{ code: number, stdout: string }>}
   */
  runCli(project, args) {
    const invocation = project.toolchain ? cliCommand(project.toolchain) : null;
    if (!invocation) return Promise.resolve({ code: -1, stdout: '' });
    const checkout = this.checkoutFlag();
    return new Promise((resolvePromise) => {
      execFile(
        invocation.command,
        [...invocation.args, ...args, ...(checkout ? ['--checkout', checkout] : [])],
        {
          cwd: project.dir,
          maxBuffer: 16 * 1024 * 1024,
          ...(invocation.env ? { env: { ...process.env, ...invocation.env } } : {}),
        },
        (error, stdout) => {
          resolvePromise({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? '') });
        },
      );
    });
  }

  /**
   * What the project is: its programs (with titles, groups and inputs), the
   * machines it builds for, its systems and its problems. See units.cjs.
   *
   * @param {import('./projects.cjs').Project} project
   * @param {{ defines?: boolean }} [options]
   */
  unitProject(project, options) {
    return this.units.load(project, options);
  }

  /**
   * The Editor / Browser / Native / Boot cells for one program on one machine:
   * available or not, why not, and what would fix it. From the machine's own
   * `runtime` object in `8bs targets --json`, and Doctor's word on whether its
   * emulator is installed; nothing is hard-coded.
   *
   * @param {import('./projects.cjs').Project} project
   * @param {string|null|undefined|false} programName
   * @param {string} target
   */
  async matrix(project, programName, target) {
    const [rows, unit, doctor] = await Promise.all([this.loadTargets(project.dir), this.unitProject(project), this.loadDoctor()]);
    return units.runtimeMatrix({
      runtime: units.normalizeRuntime(rows?.get(target)?.runtime),
      target,
      // `false` is "no program" (a bare boot loads none); null or undefined is
      // the project's main.
      program: programName === false ? null : units.programNamed(unit, programName ?? unit.main),
      doctor,
    });
  }

  /**
   * The machines the System selector offers for a project: every one the
   * CLI lists, with whether this release builds it, whether it takes a
   * region, its emulator, and its runtime cells (not narrowed to a program;
   * `matrix()` does that). When the CLI cannot be asked, the five machines
   * this release builds, from the built-in table.
   *
   * @param {{ dir: string }} project
   * @returns {Promise<{ id: string, inRelease: boolean, regional: boolean, emulator: string|null, runtime: object }[]>}
   */
  async machines(project) {
    const rows = await this.loadTargets(project.dir);
    if (!rows) {
      return ALL_TARGETS.map((id) => {
        const runtime = units.legacyRuntime(id);
        return { id, inRelease: true, regional: MACHINE_TARGETS.has(id), emulator: runtime.native.emulator, runtime };
      });
    }
    return [...rows.values()].map((row) => ({
      id: row.id,
      inRelease: row.inRelease !== false,
      regional: row.region === true,
      emulator: typeof row.emulator === 'string' ? row.emulator : null,
      runtime: units.normalizeRuntime(row.runtime) ?? units.legacyRuntime(row.id),
    }));
  }

  /**
   * Whether a machine takes `--pal`, from the CLI's `region` flag; undefined
   * until it has answered, which leaves the old fixed set to decide.
   *
   * @returns {boolean|undefined}
   */
  regional(dir, target) {
    const region = this.targetRows.get(dir)?.get(target)?.region;
    return typeof region === 'boolean' ? region : undefined;
  }

  /** Whether a machine has a wasm page, for code that cannot wait: the CLI's word once known, else the legacy table. */
  wasmReady(dir, target) {
    const row = units.normalizeRuntime(this.targetRows.get(dir)?.get(target)?.runtime);
    return (row ?? units.legacyRuntime(target)).wasm.available;
  }

  /**
   * What `8bs doctor --json` says about this host: which machines can
   * `8bs run`, which emulators are simply not installed, which are
   * present-but-broken. Cached until refresh() or a Doctor task ends.
   * Doctor exits 1 when a FAIL remains, so stdout is parsed even then —
   * the JSON is the report, the exit code is only the summary.
   *
   * @returns {Promise<{ ready: string[], notInstalled: string[], failed: string[] }|null>}
   */
  async loadDoctor() {
    if (this.doctorPromise) return this.doctorPromise;
    const project = this.all.find((p) => p.toolchain);
    const toolchain = project?.toolchain
      ?? (vscode.workspace.workspaceFolders ?? [])
        .map((folder) => findToolchain(folder.uri.fsPath, this.checkoutFlag()))
        .find(Boolean);
    if (!toolchain) return null;
    const invocation = cliCommand(toolchain);
    if (!invocation) return null;
    const cwd = project?.dir
      ?? (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
    const checkout = this.checkoutFlag();
    this.doctorPromise = new Promise((resolvePromise) => {
      execFile(
        invocation.command,
        [
          ...invocation.args,
          'doctor', '--json', '--quick',
          ...(checkout ? ['--checkout', checkout] : []),
        ],
        {
          cwd,
          maxBuffer: 4 * 1024 * 1024,
          ...(invocation.env ? { env: { ...process.env, ...invocation.env } } : {}),
        },
        (error, stdout) => {
          try {
            const report = JSON.parse(stdout);
            resolvePromise({
              ready: report.ready ?? [],
              notInstalled: report.notInstalled ?? [],
              failed: report.failed ?? [],
            });
          } catch (parseError) {
            if (error) this.output?.appendLine(`8bs doctor --json failed: ${error.message}`);
            else this.output?.appendLine(`8bs doctor --json: unreadable output: ${parseError.message}`);
            resolvePromise(null);
          }
        },
      );
    });
    return this.doctorPromise;
  }

  async refresh() {
    const found = await vscode.workspace.findFiles(`**/{${CONFIG_FILENAMES.join(',')}}`, SEARCH_EXCLUDE);
    const checkout = this.checkoutFlag();
    this.projects = loadProjects(found.map((uri) => uri.fsPath), { checkout });
    this.targetsPromises.clear();
    this.targetRows.clear();
    this.units.invalidate();
    this.doctorPromise = null;
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
      // A project with several programs lists each one's own tasks, on the
      // machines that program is set up for, so Tasks: Run Task reaches a
      // lab without first changing the launcher's choice.
      const programs = hasSeveralPrograms(project) ? project.programs.map((p) => p.name) : [null];
      for (const program of programs) {
        const extras = program ? { program } : {};
        for (const target of programTargets(project, program)) {
          const regional = this.projects.regional?.(project.dir, target);
          const own = regional === undefined ? extras : { ...extras, regional };
          // The native emulator, as always; the same program as a wasm page in
          // the browser where the machine has one; and the build. (The editor
          // tab belongs to the launcher: a task has no tab to show.)
          tasks.push(makeTask(project, 'run', target, 'ntsc', undefined, own));
          if (this.projects.wasmReady?.(project.dir, target) ?? units.legacyRuntime(target).wasm.available) {
            tasks.push(makeTask(project, 'run', target, 'ntsc', undefined, { ...own, runtime: 'browser' }));
          }
          tasks.push(makeTask(project, 'build', target, 'ntsc', undefined, own));
        }
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

    // A tasks.json entry names its program, or leaves it to the one chosen
    // in the launcher (or `main`) — never to an interactive prompt.
    const program = hasSeveralPrograms(project)
      ? (definition.program ?? resolveProgram(project, settings.getProgram(project.dir))) : null;
    // `runtime` says where a run goes. The older `web: true` was declared as
    // "run --web" but never reached the command; it now means the browser,
    // which is what it said.
    const runtime = definition.command === 'run'
      ? (definition.runtime ?? (definition.web === true && definition.target !== 'web' ? 'browser' : undefined))
      : undefined;
    const defines = isPlainObject(definition.define)
      ? Object.entries(definition.define).flatMap(([name, value]) => ['--define', units.defineText(name, value)])
      : [];
    const regional = this.projects.regional?.(project.dir, definition.target);
    const hardware = isPlainObject(definition.hardware) || typeof definition.profile === 'string'
      ? { profile: typeof definition.profile === 'string' ? definition.profile : null, options: isPlainObject(definition.hardware) ? definition.hardware : {} }
      : undefined;
    const resolved = makeTask(
      project,
      definition.command,
      definition.target,
      definition.pal ? 'pal' : 'ntsc',
      hardware,
      {
        ...(program ? { program } : {}),
        ...(typeof definition.system === 'string' && definition.system !== '' ? { system: definition.system } : {}),
        ...(runtime ? { runtime } : {}),
        ...(defines.length > 0 ? { defines } : {}),
        ...(typeof definition.locale === 'string' && definition.locale !== '' ? { locale: definition.locale } : {}),
        ...(regional === undefined ? {} : { regional }),
      },
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  // Per-program memory lives in the workspace's own state, never in
  // settings.json; a host without one (a test) just forgets.
  if (context.workspaceState) projects.unitState = new UnitState(context.workspaceState);
  projects.running.listen(context.subscriptions);
  context.subscriptions.push(projects.changed);
  const assemblyView = new AssemblyViewController(context, output, buildAssemblyArgs);

  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(TASK_TYPE, new TaskProvider(projects)),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(`**/{${CONFIG_FILENAMES.join(',')}}`);
  context.subscriptions.push(
    watcher,
    // projects.refresh() is async; none of these listeners are, so an
    // uncaught rejection (a transient filesystem error, say) would
    // otherwise be an unhandled promise rejection rather than a logged,
    // best-effort refresh — the project tree just stays stale until the
    // next trigger, which is the right failure mode for a watcher.
    watcher.onDidCreate(() => quietly('8BitScript project refresh', () => projects.refresh())),
    watcher.onDidDelete(() => quietly('8BitScript project refresh', () => projects.refresh())),
    watcher.onDidChange(() => quietly('8BitScript project refresh', () => projects.refresh())),
    vscode.workspace.onDidChangeWorkspaceFolders(() => quietly('8BitScript project refresh', () => projects.refresh())),
    // A program's inputs are read from its source, so saving a source file
    // means the cached description of its project may be stale.
    vscode.workspace.onDidSaveTextDocument?.((document) => {
      if (!/\.(8bs|8bx)$/.test(document.fileName ?? '')) return;
      const owner = projects.all.find((project) => document.fileName.startsWith(project.dir + path.sep));
      if (owner) projects.units.invalidate(owner.dir);
    }) ?? { dispose() {} },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('8bitscript.examplesPath') || e.affectsConfiguration('8bitscript.checkout')) {
        void quietly('8BitScript project refresh', () => projects.refresh());
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
    const program = await programOf(project, node, action);
    if (program === undefined) return undefined;
    const named = node?.system ?? settings.getNamedSystem();
    if (named && !node?.target) {
      const systems = (await projects.loadTargets(project.dir))?.systems ?? [];
      const system = systems.find((entry) => entry.name === named);
      if (system) {
        return {
          project,
          program,
          target: system.target,
          system: named,
          region: system.region ?? settings.getRegion(),
          hardware: { profile: system.profile, options: system.hardware },
        };
      }
    }
    const machine = settings.getSystem();
    const fits = programTargets(project, program);
    const target = node?.target
      ?? (fits.includes(machine) ? machine : await pickTarget({ ...project, targets: fits }, action));
    return target ? { project, program, target } : undefined;
  }

  /**
   * The program of a project with several that a command acts on: the one
   * the caller named, else the one chosen for the project in the launcher,
   * else `main`; with none of those, the person is asked and the answer is
   * remembered. `null` is a project that needs no name (one program),
   * `undefined` is a prompt that was dismissed.
   */
  async function programOf(project, node, action) {
    if (!hasSeveralPrograms(project)) return null;
    const known = resolveProgram(project, node?.program ?? settings.getProgram(project.dir));
    if (known) return known;
    return pickProgram(project, action);
  }

  async function pickProgram(project, action) {
    const current = settings.getProgram(project.dir);
    const picked = await vscode.window.showQuickPick(
      project.programs.map((program) => ({
        label: program.name,
        description: program.name === current ? 'selected' : undefined,
        detail: path.relative(project.dir, program.entry),
        program: program.name,
      })),
      { placeHolder: `Which program of ${labelOf(project)} to ${action}?` },
    );
    if (!picked) return undefined;
    await settings.setProgram(project.dir, picked.program);
    return picked.program;
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
      if (manager === 'pnpm') {
        offerDoctor('pnpm was not found. Run 8BitScript: Doctor to install it.');
      } else {
        vscode.window.showErrorMessage(
          `${manager} was not found. Put ${manager} on PATH for non-login shells.`,
        );
      }
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

  function offerDoctor(message) {
    vscode.window.showErrorMessage(message, 'Run Doctor').then((choice) => {
      if (choice === 'Run Doctor') vscode.commands.executeCommand('8bitscript.doctor');
    });
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
      offerDoctor('pnpm was not found. Run 8BitScript: Doctor to install it.');
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
        void quietly('8BitScript project refresh', () => projects.refresh());
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
    // A node that arrives with its project and machine already named (the
    // launcher's buttons, a tree row) skips targetOf, so the program is
    // resolved here when targetOf has not.
    const program = resolved.program !== undefined ? resolved.program : await programOf(project, node, action);
    if (program === undefined) return;
    if (!requireToolchain(project)) return;
    if (!(await requireInstalled(project))) return;
    // An explicit hardware selection (a project's own named system, from
    // launch()) rides through untouched; otherwise nothing chosen means
    // the machine's worst RAM-size config, not its catalog stock — see
    // settings.getEffectiveHardware.
    const effectiveHardware = hardware
      ?? settings.getEffectiveHardware(target, (await projects.loadTargets(project.dir))?.get(target));
    const given = await inputExtras(project, program, node, action);
    if (given.failed) return undefined;
    const extras = {
      system: system || undefined,
      checkout: projects.checkoutFlag() || undefined,
      program: program || undefined,
      // Set only by a caller that already decided and knows how to show
      // the result: launchUnit() below, Studio's own tab, Preview On….
      // Never defaulted in here. launch() (Launch App…/Launch Example…)
      // calls this with nothing set and has no tab of its own to show a
      // --web run in; defaulting it here once made that combination start
      // a real server with nothing pointed at it. `web` is the older
      // spelling of runtime 'editor'.
      runtime: node?.runtime ?? (node?.web ? 'editor' : undefined),
      // Studio's own tab, and an X16 run that asks for it — the real
      // vendored x16emu as WebAssembly, never the lightweight preview.
      x16emu: node?.x16emu ? true : undefined,
      regional: projects.regional(project.dir, target),
      ...given.extras,
    };
    return vscode.tasks.executeTask(
      makeTask(project, action, target, region ?? settings.getRegion(), effectiveHardware, extras),
    );
  }

  /**
   * The inputs and language one run (or build) is handed: the caller's, else
   * what the launcher has remembered for that program. Only what differs from
   * the program's own values becomes `--define`. A value that does not fit
   * is said so and the run does not start; an older CLI that cannot take
   * `--define` is told apart from a program with none, so nothing is silently
   * dropped.
   *
   * @returns {Promise<{ failed?: boolean, extras?: { defines?: string[], inputs?: object, locale?: string } }>}
   */
  async function inputExtras(project, program, node, action) {
    if (action !== 'run' && action !== 'build') return {};
    const locale = typeof node?.locale === 'string' && node.locale !== '' ? node.locale : undefined;
    const overrides = node?.inputs ?? projects.unitState.inputs(project.dir, program ?? '');
    if (!overrides || Object.keys(overrides).length === 0) return { extras: locale ? { locale } : {} };
    const unit = await projects.unitProject(project);
    const unitProgram = units.programNamed(unit, program ?? unit.main);
    if (unit.legacy || !unitProgram?.definesRead) {
      output.appendLine(`Inputs ignored for ${program ?? unit.main ?? project.name}: this project's 8bs cannot list its inputs (update @8bitscript/cli).`);
      if (node?.inputs) {
        vscode.window.showWarningMessage('This project\'s 8bs is too old to take inputs (--define). Update @8bitscript/cli to use them.');
      }
      return { extras: locale ? { locale } : {} };
    }
    const result = units.inputArgs(unitProgram, overrides);
    if (result.errors.length > 0) {
      vscode.window.showErrorMessage(`Not run: ${result.errors.join('; ')}`);
      return { failed: true };
    }
    return { extras: { defines: result.args, inputs: result.applied, ...(locale ? { locale } : {}) } };
  }

  /**
   * The args a `8bs build --debug` for `resolved` (`{ project, target,
   * hardware?, region?, system? }`) would need — everything
   * machine-specific (toolchain, effective hardware, region, checkout)
   * that execute()/makeTask() already resolve for every other command,
   * shared here so assemblyView.cjs never has to duplicate it. `silent`
   * is for a background refresh (assemblyView's own onSourceSaved): it
   * must never pop a "toolchain missing"/"run install?" dialog over
   * whatever the person is actually looking at, so it fails quietly
   * instead (there is no realistic way for a project whose first, manual
   * open already resolved these to fail them on a later save).
   */
  async function buildAssemblyArgs({ project, target, hardware, region, system }, { silent = false } = {}) {
    if (!project.toolchain) {
      if (!silent) requireToolchain(project);
      return null;
    }
    if (!project.installed) {
      if (silent) return null;
      if (!(await requireInstalled(project))) return null;
    }
    const invocation = cliCommand(project.toolchain);
    if (!invocation) return null;
    const effectiveHardware = hardware
      ?? settings.getEffectiveHardware(target, (await projects.loadTargets(project.dir))?.get(target));
    // Never asks: a background rebuild falls back to the first program when
    // several are listed and none is chosen or named `main`.
    const program = hasSeveralPrograms(project)
      ? (resolveProgram(project, settings.getProgram(project.dir)) ?? project.programs[0].name) : undefined;
    const extras = { system: system || undefined, checkout: projects.checkoutFlag() || undefined, program };
    const args = commandArgs('build', target, region ?? settings.getRegion(), effectiveHardware, extras);
    return { invocation, cwd: project.dir, args };
  }

  /**
   * "8BitScript: View Generated Assembly" — unlike every other action
   * above, this needs the build's own result synchronously (which
   * instructions, which file, which debug map path) rather than firing a
   * task into a terminal, so it runs `8bs` through execFile the same way
   * `projects.loadTargets` already does (projects.cjs), not through
   * makeTask()/vscode.tasks.
   */
  async function activeSourceEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !/\.(8bs|8bx)$/.test(editor.document.fileName)) {
      vscode.window.showInformationMessage('Open an .8bs or .8bx file, place the cursor on a statement, and run this command again.');
      return undefined;
    }
    return editor;
  }

  async function viewGeneratedAssembly(node) {
    const editor = await activeSourceEditor();
    if (!editor) return;
    // node is undefined for the real invocations (command palette, editor
    // context menu — neither passes one); accepted anyway, the same way
    // execute() takes one, so a test can supply {project, target} directly
    // instead of exercising settings-based project/system resolution.
    const resolved = await targetOf(node, 'build');
    if (!resolved) return;
    await assemblyView.showForCursor(editor, resolved);
  }

  /** "8BitScript: View Generated Assembly For…" — the same view, for a machine the person picks rather than whatever's currently selected, so several machines' listings can be open side by side. */
  async function viewGeneratedAssemblyFor(node) {
    const editor = await activeSourceEditor();
    if (!editor) return;
    const resolved = await targetOf(node, 'view');
    if (!resolved) return;
    await assemblyView.pickAndShow(editor, resolved);
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
    const extras = {
      want: doctorWantFromSelection(settings.getDoctorEmulators()),
      install: true,
    };
    const execution = await vscode.tasks.executeTask(makeTask(
      project ?? { name: '8bs', dir, toolchain, targets: [] },
      'doctor',
      undefined,
      'ntsc',
      undefined,
      extras,
    ));
    const done = vscode.tasks.onDidEndTask((e) => {
      if (e.execution === execution) {
        done.dispose();
        projects.doctorPromise = null;
        projects.changed.fire();
      }
    });
    context.subscriptions.push(done);
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
    void quietly('8BitScript project refresh', () => projects.refresh());
  }

  /** A project given as the object, or as its directory. */
  function projectOf(value) {
    if (value && typeof value === 'object' && typeof value.dir === 'string') return value;
    if (typeof value === 'string') return projects.all.find((project) => project.dir === value) ?? null;
    return null;
  }

  /**
   * `system` as a caller spells it — a machine id, or the name of one of the
   * project's named systems — as what a run needs: `{ target }`, or the named
   * system's target, region and fitting.
   */
  async function systemFor(project, system) {
    if (!system) return {};
    const named = ((await projects.loadTargets(project.dir))?.systems ?? []).find((entry) => entry.name === system);
    if (!named) return { target: system };
    return {
      target: named.target,
      system: named.name,
      region: named.region ?? settings.getRegion(),
      hardware: { profile: named.profile, options: named.hardware },
    };
  }

  /** Say why a runtime cannot be used and, when the person can fix it, offer to. */
  function explainUnavailable(message, cell) {
    const choices = cell.fix === 'doctor' ? ['Run Doctor'] : (cell.fix === 'install-emulator' ? ['Install emulator…', 'Run Doctor'] : []);
    void Promise.resolve(vscode.window.showWarningMessage(message, ...choices)).then((choice) => {
      if (choice === 'Run Doctor') vscode.commands.executeCommand('8bitscript.doctor');
      else if (choice === 'Install emulator…') vscode.commands.executeCommand('8bitscript.doctorSetup');
    });
  }

  /**
   * Run one program on one system in one runtime — the single place that
   * decides it. Editor, Browser and Native are separate commands that all
   * land here with the runtime fixed; `8bitscript.run` and `runUnit` land
   * here with it open, and the answer is the one remembered for the
   * program, else Editor (Native if the deprecated `preferWebPreview` is off),
   * else whichever works. A runtime that cannot work is not run: the person
   * is told why. Starting the same run again replaces it; another runtime
   * of the same program is left running beside it.
   *
   * @param {{ project?: object|string, program?: string, system?: string,
   *   runtime?: 'editor'|'browser'|'native', inputs?: object, locale?: string,
   *   x16emu?: boolean, web?: boolean }} [node]
   * @param {'editor'|'browser'|'native'} [forced] the runtime the command name fixes
   */
  async function launchUnit(node = {}, forced) {
    if (projects.all.length === 0) await projects.refresh();
    const project = projectOf(node.project) ?? selected() ?? (await pickProject('run', projects.all));
    if (!project) return undefined;
    const { system: spelled, ...rest } = node;
    const resolved = await targetOf({ ...rest, ...(await systemFor(project, spelled)), project }, 'run');
    if (!resolved) return undefined;
    const program = resolved.program !== undefined ? resolved.program : await programOf(project, node, 'run');
    if (program === undefined) return undefined;
    const { target } = resolved;
    const unit = await projects.unitProject(project);
    const stateName = program ?? unit.main ?? '';
    const matrix = await projects.matrix(project, stateName || null, target);
    let runtime = forced ?? node.runtime ?? (node.web === true ? 'editor' : (node.web === false ? 'native' : undefined));
    if (!runtime) {
      runtime = units.defaultRuntime({
        matrix,
        remembered: projects.unitState.runtime(project.dir, stateName),
        preferEditor: settings.getPreferWebPreview(),
      });
    }
    const label = units.programNamed(unit, stateName)?.label ?? project.name;
    if (!runtime || !units.RUNTIMES.includes(runtime)) {
      const why = matrix.native.reason ?? matrix.editor.reason ?? 'no runtime works';
      vscode.window.showWarningMessage(why.startsWith(label) ? `${why}.` : `${label} cannot run on ${target}: ${why}.`);
      return undefined;
    }
    const cell = matrix[runtime];
    if (!cell.available) {
      // "tiny does not target c64" already says it; anything else is a reason
      // this runtime in particular cannot work.
      explainUnavailable(
        cell.reason.startsWith(label)
          ? `${cell.reason}.`
          : `${units.RUNTIME_LABELS[runtime]} is not available for ${label} on ${target}: ${cell.reason}`,
        cell,
      );
      return undefined;
    }
    // The real x16emu as WebAssembly is the X16's own opt-in; every other wasm page is the lightweight one.
    const x16emu = node.x16emu === true && runtime !== 'native' && matrix.wasmEmulator.available;
    // One tab, one editor run per machine: a new Editor run takes the tab over.
    if (runtime === 'editor') projects.running.stop(project.dir, target, { runtime: 'editor' });
    projects.running.stopRun(units.runKey({ dir: project.dir, program: program || undefined, system: resolved.system, target, runtime }));
    const launchedAt = Date.now();
    const started = await execute('run', {
      ...resolved,
      project,
      program,
      runtime,
      x16emu: x16emu || undefined,
      inputs: node.inputs,
      locale: node.locale,
    });
    if (!started) return undefined;
    await projects.unitState.setRuntime(project.dir, stateName, runtime);
    await projects.unitState.setSystem(project.dir, stateName, resolved.system ?? target);
    if (runtime === 'editor') {
      await vscode.commands.executeCommand('8bitscript.previewTab.show', { dir: project.dir, target, launchedAt });
    }
    return started;
  }

  /** Open the machine's emulator with nothing loaded. */
  async function openBareEmulator(node) {
    if (projects.all.length === 0) await projects.refresh();
    const project = projectOf(node?.project) ?? selected() ?? (await pickProject('boot', projects.all));
    if (!project) return undefined;
    const { system: spelled, ...rest } = node ?? {};
    const resolved = await targetOf({ ...rest, ...(await systemFor(project, spelled)), project }, 'boot');
    if (!resolved) return undefined;
    const matrix = await projects.matrix(project, false, resolved.target);
    if (!matrix.boot.available) {
      explainUnavailable(`Cannot open a bare ${resolved.target} emulator: ${matrix.boot.reason}`, matrix.boot);
      return undefined;
    }
    return execute('boot', resolved);
  }

  const command = (id, handler) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  command('8bitscript.refresh', () => projects.refresh());
  command('8bitscript.toggleExamples', () => settings.setShowExamples(!settings.getShowExamples()));
  command('8bitscript.saveSystem', saveSystem);
  // Project and system are chosen in the launcher now; these two palette
  // commands still work, and say so once.
  const withNotice = (id, message, handler) => async (...args) => {
    const key = `notice.${id}`;
    if (!context.globalState?.get(key)) {
      void context.globalState?.update(key, true);
      vscode.window.showInformationMessage(message);
    }
    return handler(...args);
  };
  command('8bitscript.selectProject', withNotice('selectProject', 'The project is chosen at the top of the 8BitScript side bar; this command still works.', chooseProject));
  command('8bitscript.selectSystem', withNotice('selectSystem', 'The system is chosen in the 8BitScript side bar; this command still works.', chooseSystem));
  command('8bitscript.selectRegion', chooseRegion);
  // ── Studio ────────────────────────────────────────────────────────────────
  // The WebAssembly build is the primary way to run anything here: our own
  // backend compiles the program straight to wasm and our own model of the
  // machine runs it (`8bs run <t> --web`), with no vendor emulator in the
  // loop. So Studio opens in an editor tab on the Commander X16's wasm build
  // — the machine it is designed on (packages/studio's baseline) — and the
  // other two ways to run it are explicit, separate commands rather than a
  // hidden fallback: `openStudioNative` (the real x16emu window) and
  // `openStudioX16emu` (the vendored x16emu compiled to wasm, in the tab).
  async function studioProject() {
    if (projects.all.length === 0) await projects.refresh();
    const studio = ofKind(projects.all, 'app').find((p) => p.name === '@8bitscript/studio');
    if (!studio) {
      vscode.window.showInformationMessage('Studio is not installed. Install 8BitScript from the side bar, or install @8bitscript/cli in a project.');
      return null;
    }
    return studio;
  }
  /**
   * Run Studio in the editor tab and follow it there. `x16emu` swaps our wasm
   * model of the X16 for the vendored x16emu in the same tab. A tab's run
   * already in flight is stopped first, so two servers never write the same
   * last-run file, and the tab is then pointed at the new run; a native Studio
   * window is left alone.
   */
  async function openStudioInTab({ x16emu = false } = {}) {
    const studio = await studioProject();
    if (!studio) return;
    projects.running.stop(studio.dir, 'cx16', { web: true });
    const launchedAt = Date.now();
    const started = await execute('run', { project: studio, target: 'cx16', web: true, ...(x16emu ? { x16emu: true } : {}) });
    if (!started) return;
    await vscode.commands.executeCommand('8bitscript.studioTab.show', { dir: studio.dir, target: 'cx16', launchedAt, x16emu });
  }
  command('8bitscript.openStudio', (node) => openStudioInTab({ x16emu: node?.x16emu === true }));
  // The rocket in the title bar and the palette's "Launch Studio" do the same: no picker.
  command('8bitscript.launchStudio', () => openStudioInTab());
  // Kept for people who bound it: it was "Studio in a tab" back when that meant x16emu.
  command('8bitscript.openStudioTab', () => openStudioInTab());
  command('8bitscript.openStudioX16emu', () => openStudioInTab({ x16emu: true }));
  // The real emulator in its own window — a named system or a bare machine can
  // still be asked for, as the side bar's old sliver menu did; nothing named is
  // Studio's baseline, the Commander X16.
  command('8bitscript.openStudioNative', async (node) => {
    const studio = await studioProject();
    if (!studio) return;
    const wanted = typeof node?.system === 'string' ? node.system : '';
    if (wanted && MACHINES_FOR_STUDIO.has(wanted)) {
      await execute('run', { project: studio, target: wanted });
      return;
    }
    const system = wanted
      ? ((await projects.loadTargets(studio.dir))?.systems ?? []).find((entry) => entry.name === wanted)
      : null;
    if (system) {
      await execute('run', {
        project: studio,
        target: system.target,
        system: system.name,
        region: system.region ?? settings.getRegion(),
        hardware: { profile: system.profile, options: system.hardware },
      });
      return;
    }
    await execute('run', { project: studio, target: 'cx16' });
  });
  // The generic Preview tab: any project, whichever of its own targets has
  // a --web build. targetOf() already does the picking (a project quick
  // pick when more than one is open, a target quick pick from that
  // project's own `targets`) — the same machinery every other palette
  // command here shares, so a project with only `pet` and `web` listed is
  // never offered `c64`. `rebind` is the Preview tab's own Rebuild
  // reaching back in with the exact `{dir, target}` it is already
  // showing, skipping both pickers.
  /** Run `project` on `target` in a --web build and follow it in the
   * generic Preview tab — previewOn's own body, and what a plain Run
   * reaches for too once it has decided (WEB_PREVIEW_READY, the
   * preferWebPreview setting) that this run should be one. */
  async function runInPreviewTab(project, target) {
    projects.running.stop(project.dir, target, { web: true });
    const launchedAt = Date.now();
    const started = await execute('run', { project, target, web: true });
    if (!started) return;
    await vscode.commands.executeCommand('8bitscript.previewTab.show', { dir: project.dir, target, launchedAt });
  }
  command('8bitscript.previewOn', async (rebind) => {
    if (projects.all.length === 0) await projects.refresh();
    let resolved;
    if (rebind?.dir && rebind?.target) {
      const project = projects.all.find((p) => p.dir === rebind.dir);
      resolved = project ? { project, target: rebind.target } : undefined;
    } else {
      resolved = await targetOf(undefined, 'preview');
    }
    if (!resolved) return;
    await runInPreviewTab(resolved.project, resolved.target);
  });
  command('8bitscript.launchApp', () => launch('app', 'apps'));
  command('8bitscript.launchExample', () => launch('example', 'examples'));
  command('8bitscript.doctor', doctor);
  command('8bitscript.install', install);
  command('8bitscript.useLocal', useLocal);
  command('8bitscript.usePublished', usePublished);
  // Three runtimes, three commands, none needing another; `runUnit` and the
  // older `run` take the runtime as an argument (or use the one remembered).
  command('8bitscript.runUnit', (node) => launchUnit(node));
  command('8bitscript.runEditor', (node) => launchUnit(node, 'editor'));
  command('8bitscript.runBrowser', (node) => launchUnit(node, 'browser'));
  command('8bitscript.runNative', (node) => launchUnit(node, 'native'));
  command('8bitscript.run', (node) => launchUnit(node));
  command('8bitscript.build', (node) => execute('build', node));
  command('8bitscript.openBareEmulator', openBareEmulator);
  command('8bitscript.boot', openBareEmulator);
  command('8bitscript.viewGeneratedAssembly', viewGeneratedAssembly);
  command('8bitscript.viewGeneratedAssemblyFor', viewGeneratedAssemblyFor);
  command('8bitscript.assemblyView.openForMachine', () => assemblyView.openForMachine(vscode.window.activeTextEditor));
  command('8bitscript.assemblyView.toggleExplain', () => assemblyView.toggleExplain());
  command('8bitscript.stop', (node) => {
    if (node?.runId) projects.running.stopRun(node.runId);
    else if (node?.dir) projects.running.stop(node.dir, node.target);
    else for (const execution of projects.running.executions) execution.terminate();
  });
  command('8bitscript.openConfig', (node) => {
    const project = node?.project ?? selected();
    if (project) vscode.window.showTextDocument(vscode.Uri.file(project.configPath));
  });
  // The entry of the program the caller names, else the one chosen in the
  // launcher — not always the project's `main`, which is what this opened
  // while the program picker was ignored.
  command('8bitscript.openEntry', (node) => {
    const project = projectOf(node?.project) ?? selected();
    if (!project) return;
    const name = node?.program
      ?? (hasSeveralPrograms(project) ? resolveProgram(project, settings.getProgram(project.dir)) : null);
    const program = name ? project.programs.find((entry) => entry.name === name) : null;
    vscode.window.showTextDocument(vscode.Uri.file(program?.entry ?? project.entry));
  });
  // Show where a program is declared in the config.
  command('8bitscript.revealProgram', async (node) => {
    const project = projectOf(node?.project) ?? selected();
    if (!project) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(project.configPath));
    const at = node?.program ? units.programOffset(document.getText(), node.program) : -1;
    const position = document.positionAt(at >= 0 ? at : 0);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
  });

  void quietly('8BitScript project refresh', () => projects.refresh());
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
      // row.web tells apart a real machine's own wasm-backend preview
      // from that same machine's native run — two rows, two files, never
      // one file two readers race over (see lastRunPath's own header).
      reports.set(rowKey(row.dir, row.target, row.web), readLastRun(row.dir, row.target, row.web));
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

module.exports = { Projects, RunningTasks, TaskProvider, labelOf, makeTask, registerRunner, whereLabel };
