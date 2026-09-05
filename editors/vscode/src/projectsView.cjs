// The "Projects" view in the 8BitScript side bar.
//
// It lists every project in the workspace (see projects.cjs for what counts as
// one) and runs `8bs run` / `8bs build` for a chosen system without a trip
// through the terminal. It is the editor equivalent of
// scripts/launch-example.mjs, and like that script it contains no build logic
// of its own: every action is the same `8bs` command a person would type,
// started in the project's own directory with the project's own toolchain.
//
// The list has three layouts, chosen from the dropdowns above it
// (controlsView.cjs) or the view's title bar:
//
//   runnable   the projects that can run on the selected system, flat, with
//              Run/Build on each row for that system and region
//   byProject  each project expanded into the systems it targets
//   bySystem   each system expanded into the projects that target it
//
// Runs go through the editor's task system rather than a hidden child process
// so that output lands in a terminal, a running emulator can be stopped from
// the view, and the same invocation can be written down in tasks.json under
// the `8bs` task type declared in package.json.
const path = require('path');

const vscode = require('vscode');

const {
  ALL_TARGETS,
  CONFIG_FILE,
  MACHINE_TARGETS,
  PROOFS_DIR,
  byKind,
  bySystem,
  commandArgs,
  findProofsDir,
  findToolchain,
  loadApps,
  loadProject,
  loadProjects,
  loadProofs,
  ofKind,
  resolveLlvmMosHome,
  runnableOn,
  withShipped,
} = require('./projects.cjs');
const settings = require('./settings.cjs');

const { regionLabel, regionShort } = settings;

const TASK_TYPE = '8bs';
const VIEW_ID = '8bitscript.projects';

// Passing an explicit exclude replaces the editor's files.exclude defaults, so
// everything that hides a project copy has to be listed here: installed
// packages, git internals, and the per-session worktrees the agent tooling
// keeps under .claude/worktrees, each a whole second checkout of the repo.
const SEARCH_EXCLUDE = '{**/node_modules/**,**/.git/**,**/.claude/worktrees/**}';

function targetIcon(target) {
  return new vscode.ThemeIcon(target === 'web' ? 'globe' : 'device-desktop');
}

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
 * Where a project lives, as the row's grey text: a workspace project's
 * relative path, `proof-of-concept/borders`, or an app's package name.
 */
function whereLabel(project) {
  if (project.kind === 'app') return project.name;
  if (project.kind === 'proof') return path.join(PROOFS_DIR, path.basename(project.dir));
  if (!project.shipped) return relativeDir(project.dir);
  return path.join(path.basename(path.dirname(project.dir)), path.basename(project.dir));
}

/** The name a row shows: an app's title, otherwise the package name. */
function labelOf(project) {
  return project.kind === 'app' ? project.title : project.name;
}

/**
 * The repo (workspace folder) a project belongs to, for grouping by repo.
 * Keyed by the folder's path rather than its name — two workspace folders
 * can share a basename (`~/work/frontend` and `~/oss/frontend`), and that
 * must not merge two different repos into one group.
 */
function repoOf(project) {
  const folder = folderOf(project.dir);
  return folder ? { key: folder.uri.fsPath, name: folder.name } : { key: '\0shipped', name: 'Shipped with the toolchain' };
}

/**
 * Group projects by the repo they live in, for a multi-root workspace.
 *
 * Returns null when there is only one workspace folder, or when every
 * project resolved to it anyway — a single-repo workspace should not grow an
 * extra "repo" level it has no use for.
 *
 * @param {import('./projects.cjs').Project[]} projects
 * @returns {{ name: string, projects: import('./projects.cjs').Project[] }[] | null}
 */
function groupByFolder(projects) {
  if ((vscode.workspace.workspaceFolders?.length ?? 0) < 2) return null;
  const groups = new Map();
  for (const project of projects) {
    const { key, name } = repoOf(project);
    if (!groups.has(key)) groups.set(key, { name, projects: [] });
    groups.get(key).projects.push(project);
  }
  if (groups.size < 2) return null;
  return [...groups.entries()].map(([key, { name, projects }]) => ({ key, name, projects }));
}

/**
 * Tracks which `8bs` tasks are running, so the tree can show it and the stop
 * button can end them. Keyed by the task definition, which is what both the
 * tree and tasks.json-launched runs have in common.
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

  /** @param {string} dir @param {string} [target] */
  matching(dir, target) {
    return [...this.executions].filter((execution) => {
      const definition = execution.task.definition;
      if (definition.projectDir !== dir) return false;
      return target === undefined || definition.target === target;
    });
  }

  isRunning(dir, target) {
    return this.matching(dir, target).length > 0;
  }

  stop(dir, target) {
    for (const execution of this.matching(dir, target)) execution.terminate();
  }
}

/**
 * Environment additions for every `8bs` task: the LLVM-MOS SDK location, when
 * it can be found, since a task's shell does not read the rc file that
 * usually exports it. See resolveLlvmMosHome in projects.cjs.
 */
function taskEnv() {
  const home = resolveLlvmMosHome({
    setting: vscode.workspace.getConfiguration('8bitscript').get('llvmMosHome'),
  });
  return home ? { LLVM_MOS_HOME: home } : {};
}

/**
 * Build the task for one `8bs` invocation.
 *
 * The definition carries `projectDir` as an absolute path so running-state
 * lookups are exact; `project` is the workspace-relative spelling that a
 * person would write in tasks.json.
 */
function makeTask(project, action, target, region) {
  const args = commandArgs(action, target, region);
  const pal = region === 'pal' && MACHINE_TARGETS.has(target);
  const definition = {
    type: TASK_TYPE,
    command: action,
    project: relativeDir(project.dir),
    projectDir: project.dir,
    ...(target ? { target } : {}),
    ...(pal ? { pal: true } : {}),
  };
  const suffix = target ? ` ${target}${MACHINE_TARGETS.has(target) ? ` (${regionShort(region)})` : ''}` : '';
  const name = `${project.name}: ${action}${suffix}`;
  const task = new vscode.Task(
    definition,
    folderOf(project.dir) ?? vscode.TaskScope.Workspace,
    name,
    TASK_TYPE,
    new vscode.ShellExecution(
      { value: project.toolchain, quoting: vscode.ShellQuoting.Strong },
      args,
      { cwd: project.dir, env: taskEnv() },
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
 * Tree nodes:
 *   { kind: 'project', project }          a project expanded into targets
 *   { kind: 'project', project, target }  a project row pinned to one system
 *   { kind: 'target', project, target }   one system under a project
 *   { kind: 'system', target }            one system expanded into projects
 *   { kind: 'message', text }             a placeholder when a list is empty
 */
class ProjectsProvider {
  constructor(output) {
    this.output = output;
    /** @type {import('./projects.cjs').Project[]} */
    this.projects = [];
    /** @type {import('./projects.cjs').Project[]} the toolchain's proofs of concept */
    this.proofs = [];
    /** @type {import('./projects.cjs').Project[]} the apps that ship with the toolchain */
    this.apps = [];
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.running = new RunningTasks(() => this.changed.fire());
  }

  /**
   * The projects the list shows: the workspace's own, the apps that ship
   * with the toolchain (always — they are the point of shipping them), and
   * its proofs of concept when the checkbox asks for them.
   */
  get visible() {
    const shipped = settings.getShowExamples() ? [...this.proofs, ...this.apps] : this.apps;
    return withShipped(this.projects, shipped);
  }

  /** Every project the workspace or the toolchain offers, checkbox or not. */
  get all() {
    return withShipped(this.projects, [...this.proofs, ...this.apps]);
  }

  /**
   * Whether showing the proofs of concept would add anything. Inside the
   * repository they are already workspace projects, so the checkbox stays
   * hidden.
   */
  hasExamples() {
    const own = new Set(this.projects.map((p) => p.dir));
    return this.proofs.some((proof) => !own.has(proof.dir));
  }

  async refresh() {
    const found = await vscode.workspace.findFiles(`**/${CONFIG_FILE}`, SEARCH_EXCLUDE);
    this.projects = loadProjects(found.map((uri) => uri.fsPath));
    const shipped = this.discoverShipped();
    this.proofs = shipped.proofs;
    this.apps = shipped.apps;
    this.output.appendLine(
      `Projects: ${this.projects.length === 0 ? 'none found' : this.projects.map((p) => p.name).join(', ')}` +
        (this.proofs.length > 0 ? `; proofs of concept: ${this.proofs.map((p) => p.name).join(', ')}` : '') +
        (this.apps.length > 0 ? `; apps: ${this.apps.map((p) => p.name).join(', ')}` : ''),
    );
    await vscode.commands.executeCommand('setContext', '8bitscript.hasProjects', this.visible.length > 0);
    await vscode.commands.executeCommand('setContext', '8bitscript.hasExamples', this.hasExamples());
    this.changed.fire();
  }

  /**
   * What ships with the toolchain in use: its apps, and its proofs of
   * concept. Both are looked for beside the first toolchain that has them —
   * a project's own, or the workspace folder's. An explicit
   * `8bitscript.examplesPath` names the proofs directory instead.
   *
   * @returns {{ proofs: import('./projects.cjs').Project[], apps: import('./projects.cjs').Project[] }}
   */
  discoverShipped() {
    const explicit = settings.getExamplesPath();
    let proofs = explicit ? loadProofs(explicit) : [];
    let apps = [];
    const toolchains = [
      ...this.projects.map((p) => p.toolchain),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => findToolchain(f.uri.fsPath)),
    ].filter(Boolean);
    for (const toolchain of toolchains) {
      if (!explicit && proofs.length === 0) {
        const dir = findProofsDir(toolchain);
        if (dir) proofs = loadProofs(dir);
      }
      if (apps.length === 0) apps = loadApps(toolchain);
      if (proofs.length > 0 && apps.length > 0) break;
    }
    return { proofs, apps };
  }

  getChildren(node) {
    if (!node) return this.roots();
    if (node.kind === 'project' && !node.target) {
      return node.project.targets.map((target) => ({ kind: 'target', project: node.project, target }));
    }
    if (node.kind === 'folder') {
      return node.projects.map((project) => ({ kind: 'project', project, target: node.target }));
    }
    if (node.kind === 'section') {
      return this.projectRows(node.projects, node.target);
    }
    if (node.kind === 'system') {
      return this.sectionRows(runnableOn(this.visible, node.target), node.target);
    }
    return [];
  }

  /**
   * Section rows — Projects, Proofs of concept, Apps — when the list mixes
   * kinds, so what the workspace holds is never confused with what the
   * toolchain brought along; the plain project rows when it does not.
   */
  sectionRows(projects, target) {
    const sections = byKind(projects);
    if (sections) {
      return sections.map(({ kind, label, projects }) => ({ kind: 'section', section: kind, label, projects, target }));
    }
    return this.projectRows(projects, target);
  }

  /** Project rows for a list, grouped by repo first when the workspace has more than one. */
  projectRows(projects, target) {
    const groups = groupByFolder(projects);
    if (groups) return groups.map(({ key, name, projects }) => ({ kind: 'folder', key, name, projects, target }));
    return projects.map((project) => ({ kind: 'project', project, target }));
  }

  roots() {
    const projects = this.visible;
    switch (settings.getViewMode()) {
      case 'bySystem':
        return bySystem(projects).map(({ target }) => ({ kind: 'system', target }));
      case 'byProject':
        return this.sectionRows(projects);
      default: {
        const system = settings.getSystem();
        const runnable = runnableOn(projects, system);
        if (runnable.length === 0 && projects.length > 0) {
          return [{ kind: 'message', text: `No project targets ${system}. Pick another system above.` }];
        }
        return this.sectionRows(runnable, system);
      }
    }
  }

  getTreeItem(node) {
    switch (node.kind) {
      case 'project':
        return this.projectItem(node);
      case 'target':
        return this.targetItem(node);
      case 'system':
        return this.systemItem(node);
      case 'folder':
        return this.folderItem(node);
      case 'section':
        return this.sectionItem(node);
      default: {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        item.contextValue = 'message';
        return item;
      }
    }
  }

  projectItem({ project, target }) {
    const pinned = target !== undefined;
    const item = new vscode.TreeItem(
      labelOf(project),
      pinned ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded,
    );
    const running = this.running.isRunning(project.dir, target);
    const states = [
      pinned && 'pinned',
      pinned && MACHINE_TARGETS.has(target) && 'machine',
      running && 'running',
      !project.toolchain && 'notoolchain',
      !project.installed && 'uninstalled',
      project.shipped && 'shipped',
      project.kind !== 'project' && project.kind,
    ].filter(Boolean);
    item.contextValue = ['project', ...states].join('.');
    item.id = pinned ? `${project.dir}\0${target}` : project.dir;
    const region = settings.getRegion();
    item.description = [
      running && 'running',
      !project.toolchain && 'toolchain not installed',
      project.toolchain && !project.installed && 'not installed',
      pinned && MACHINE_TARGETS.has(target) && regionLabel(region),
      whereLabel(project),
    ]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = new vscode.MarkdownString(
      [
        `**${labelOf(project)}**${project.description ? ` — ${project.description}` : ''}`,
        '',
        project.kind === 'app'
          ? `An app that ships with the toolchain (\`${project.name}\`); its version is the toolchain's.`
          : project.kind === 'proof'
            ? 'A proof of concept from the 8bitscript repository, there to exercise the toolchain.'
            : '',
        `Directory: \`${project.dir}\``,
        `Entry: \`${path.relative(project.dir, project.entry)}\``,
        `Targets: ${project.targets.join(', ')}`,
        pinned ? `Run: \`8bs ${commandArgs('run', target, region).join(' ')}\`` : '',
        project.toolchain
          ? `Toolchain: \`${project.toolchain}\``
          : `Toolchain: **not installed** — run \`${project.packageManager} install\` in the project.`,
        project.installed
          ? ''
          : `Dependencies: **not installed** — run \`${project.packageManager} install\`, or use the Install button.`,
      ]
        .filter((line, i) => line !== '' || i === 1)
        .join('\n'),
    );
    item.iconPath = new vscode.ThemeIcon(
      running
        ? 'loading~spin'
        : !project.toolchain || !project.installed
          ? 'warning'
          : project.kind === 'proof'
            ? 'beaker'
            : project.kind === 'app'
              ? 'rocket'
              : 'package',
    );
    item.command = {
      command: 'vscode.open',
      title: 'Open entry file',
      arguments: [vscode.Uri.file(project.entry)],
    };
    return item;
  }

  targetItem({ project, target }) {
    const item = new vscode.TreeItem(target, vscode.TreeItemCollapsibleState.None);
    const machine = MACHINE_TARGETS.has(target);
    const running = this.running.isRunning(project.dir, target);
    const states = [
      machine && 'machine',
      running && 'running',
      !project.toolchain && 'notoolchain',
    ].filter(Boolean);
    item.contextValue = ['target', ...states].join('.');
    item.id = `${project.dir}\0${target}`;
    const region = settings.getRegion();
    item.description = running ? 'running' : machine ? regionLabel(region) : '';
    item.iconPath = running ? new vscode.ThemeIcon('loading~spin') : targetIcon(target);
    item.tooltip = `8bs ${commandArgs('run', target, region).join(' ')}`;
    return item;
  }

  systemItem({ target }) {
    const machine = MACHINE_TARGETS.has(target);
    const count = runnableOn(this.visible, target).length;
    const item = new vscode.TreeItem(
      target,
      target === settings.getSystem()
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `system\0${target}`;
    item.contextValue = ['system', machine && 'machine'].filter(Boolean).join('.');
    item.description = `${count} project${count === 1 ? '' : 's'}${machine ? ` · ${regionLabel(settings.getRegion())}` : ''}`;
    item.iconPath = targetIcon(target);
    return item;
  }

  /** One of the three kinds, when the list holds more than one of them. */
  sectionItem({ section, label, projects, target }) {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `section\0${target ?? ''}\0${section}`;
    item.contextValue = `section.${section}`;
    item.description = `${projects.length}`;
    item.iconPath = new vscode.ThemeIcon(section === 'proof' ? 'beaker' : section === 'app' ? 'rocket' : 'root-folder');
    return item;
  }

  /** A repo, when the workspace has more than one and it is worth splitting on. */
  folderItem({ key, name, projects, target }) {
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `folder\0${target ?? ''}\0${key}`;
    item.contextValue = 'folder';
    item.description = `${projects.length} project${projects.length === 1 ? '' : 's'}`;
    item.iconPath = new vscode.ThemeIcon('root-folder');
    return item;
  }
}

/**
 * Provide the view's run/build tasks to "Tasks: Run Task", and resolve the
 * `8bs` entries a person writes in tasks.json into something executable.
 */
class TaskProvider {
  constructor(provider) {
    this.provider = provider;
  }

  provideTasks() {
    const tasks = [];
    for (const project of this.provider.visible) {
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
    const project = this.provider.visible.find((p) => p.dir === dir)
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
 * Wire the view, its commands, and the task provider into the extension.
 *
 * @param {vscode.ExtensionContext} context
 * @param {vscode.LogOutputChannel} output
 */
function registerProjectsView(context, output) {
  const provider = new ProjectsProvider(output);
  provider.running.listen(context.subscriptions);

  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view, provider.changed);

  /** The grey text after the view's name says what the Run buttons will do. */
  function updateHeader() {
    const system = settings.getSystem();
    const region = MACHINE_TARGETS.has(system) ? ` · ${regionLabel(settings.getRegion())}` : '';
    switch (settings.getViewMode()) {
      case 'bySystem':
        view.description = 'by system';
        break;
      case 'byProject':
        view.description = 'by project';
        break;
      default:
        view.description = `runnable on ${system}${region}`;
    }
  }
  updateHeader();

  context.subscriptions.push(vscode.tasks.registerTaskProvider(TASK_TYPE, new TaskProvider(provider)));

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE}`);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => provider.refresh()),
    watcher.onDidDelete(() => provider.refresh()),
    watcher.onDidChange(() => provider.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('8bitscript.examplesPath')) {
        provider.refresh();
      } else if (settings.affectsAny(e) || e.affectsConfiguration('8bitscript.showExamples')) {
        updateHeader();
        vscode.commands.executeCommand('setContext', '8bitscript.hasProjects', provider.visible.length > 0);
        provider.changed.fire();
      }
    }),
  );

  /** Resolve the project and system an action applies to, asking when needed. */
  async function targetOf(node, action) {
    if (node?.kind === 'target') return node;
    if (node?.kind === 'project') {
      if (node.target) return node;
      const target = await pickTarget(node.project, action);
      return target ? { project: node.project, target } : undefined;
    }
    if (node?.kind === 'system') {
      const project = await pickProject(action, runnableOn(provider.visible, node.target));
      return project ? { project, target: node.target } : undefined;
    }
    const project = await pickProject(action, provider.visible);
    if (!project) return undefined;
    const target = await pickTarget(project, action);
    return target ? { project, target } : undefined;
  }

  async function pickProject(action, candidates) {
    if (provider.all.length === 0) await provider.refresh();
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
      new vscode.ShellExecution(project.packageManager, ['install'], { cwd: project.dir, env: taskEnv() }),
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
    const project = node?.project ?? (await pickProject('install', provider.visible));
    if (!project) return;
    const execution = await vscode.tasks.executeTask(installTask(project));
    // Rescan once the install finishes, so the warning clears on its own.
    const done = vscode.tasks.onDidEndTask((e) => {
      if (e.execution === execution) {
        done.dispose();
        provider.refresh();
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
      .then((choice) => choice === 'Refresh' && provider.refresh());
    return false;
  }

  async function execute(action, region, node) {
    const resolved = await targetOf(node, action);
    if (!resolved) return;
    const { project, target } = resolved;
    if (!requireToolchain(project)) return;
    if (!(await requireInstalled(project))) return;
    const task = makeTask(project, action, target, region ?? settings.getRegion());
    await vscode.tasks.executeTask(task);
  }

  async function doctor() {
    if (provider.projects.length === 0) await provider.refresh();
    const project = provider.visible.find((p) => p.toolchain);
    // A workspace with no project can still have the CLI installed at its
    // root, and doctor is the command that tells someone whether their VICE
    // and LLVM-MOS installs are ready — worth finding it either way.
    const toolchain = project?.toolchain
      ?? (vscode.workspace.workspaceFolders ?? [])
        .map((folder) => findToolchain(folder.uri.fsPath))
        .find(Boolean);
    if (!toolchain) {
      vscode.window.showErrorMessage('No 8bs toolchain found in this workspace. Run: pnpm add -D @8bitscript/cli');
      return;
    }
    const dir = project?.dir ?? path.dirname(path.dirname(path.dirname(toolchain)));
    const task = makeTask(
      project ?? { name: '8bs', dir, toolchain, targets: [] },
      'doctor',
      undefined,
      'ntsc',
    );
    await vscode.tasks.executeTask(task);
  }

  async function chooseViewMode() {
    const current = settings.getViewMode();
    const picked = await vscode.window.showQuickPick(
      settings.VIEW_MODES.map((mode) => ({
        label: mode.label,
        description: mode.id === current ? 'current' : undefined,
        mode,
      })),
      { placeHolder: 'How should the project list be laid out?' },
    );
    if (picked) await settings.setViewMode(picked.mode.id);
  }

  async function chooseSystem() {
    const current = settings.getSystem();
    const picked = await vscode.window.showQuickPick(
      ALL_TARGETS.map((target) => ({
        label: target,
        description: target === current ? 'current' : undefined,
        target,
      })),
      { placeHolder: 'Which system should the Run and Build buttons use?' },
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
      { placeHolder: 'Which region should vic20 and c64 runs use?' },
    );
    if (picked) await settings.setRegion(picked.region);
  }

  /**
   * Launch something the toolchain ships — an app, or a proof of concept —
   * separately from the workspace's own projects: pick it when there is a
   * choice, pick the system to open it on (the selected system first), run.
   * The checkbox that hides the proofs from the list does not hide them
   * here; this is the way to reach them without listing them.
   */
  async function launch(kind, what, filter = () => true) {
    if (provider.all.length === 0) await provider.refresh();
    const candidates = ofKind(provider.all, kind).filter(filter);
    if (candidates.length === 0) {
      vscode.window.showInformationMessage(
        kind === 'app'
          ? `No ${what} found. Apps ship with @8bitscript/cli: install it in a project, then refresh.`
          : `No ${what} found. They live in the 8bitscript repository, under examples/${PROOFS_DIR}.`,
      );
      return;
    }
    const project = candidates.length === 1 ? candidates[0] : await pickProject('launch', candidates);
    if (!project) return;
    const target = await pickTarget(project, 'launch');
    if (!target) return;
    await execute('run', undefined, { kind: 'target', project, target });
  }

  const command = (id, handler) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  command('8bitscript.projects.refresh', () => provider.refresh());
  command('8bitscript.projects.viewMode', chooseViewMode);
  command('8bitscript.selectSystem', chooseSystem);
  command('8bitscript.selectRegion', chooseRegion);
  command('8bitscript.toggleExamples', () => settings.setShowExamples(!settings.getShowExamples()));
  command('8bitscript.launchStudio', () => launch('app', 'Studio', (p) => p.name === '@8bitscript/studio'));
  command('8bitscript.launchApp', () => launch('app', 'apps'));
  command('8bitscript.launchProof', () => launch('proof', 'proofs of concept'));
  command('8bitscript.doctor', doctor);
  command('8bitscript.install', install);
  command('8bitscript.run', (node) => execute('run', undefined, node));
  command('8bitscript.build', (node) => execute('build', undefined, node));
  command('8bitscript.runNtsc', (node) => execute('run', 'ntsc', node));
  command('8bitscript.buildNtsc', (node) => execute('build', 'ntsc', node));
  command('8bitscript.runPal', (node) => execute('run', 'pal', node));
  command('8bitscript.buildPal', (node) => execute('build', 'pal', node));
  command('8bitscript.stop', (node) => {
    if (node?.kind === 'target' || (node?.kind === 'project' && node.target)) {
      provider.running.stop(node.project.dir, node.target);
    } else if (node?.kind === 'project') {
      provider.running.stop(node.project.dir);
    } else {
      for (const execution of provider.running.executions) execution.terminate();
    }
  });
  command('8bitscript.openConfig', (node) => {
    if (node?.project) vscode.window.showTextDocument(vscode.Uri.file(node.project.configPath));
  });
  command('8bitscript.revealProject', (node) => {
    if (node?.project) vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(node.project.configPath));
  });
  command('8bitscript.openTerminal', (node) => {
    if (!node?.project) return;
    const terminal = vscode.window.createTerminal({ name: node.project.name, cwd: node.project.dir });
    terminal.show();
  });

  provider.refresh();
  return provider;
}

module.exports = { registerProjectsView };
