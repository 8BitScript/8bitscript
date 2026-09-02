// The "8BitScript" view: its own Activity Bar icon in the left side bar.
//
// It lists every project in the workspace (see projects.cjs for what counts as
// one), expands each into the systems it builds for, and runs `8bs run` /
// `8bs build` for a chosen system without a trip through the terminal. It is
// the editor equivalent of scripts/launch-example.mjs, and like that script it
// contains no build logic of its own: every action is the same `8bs` command
// a person would type, started in the project's own directory with the
// project's own toolchain.
//
// Runs go through the editor's task system rather than a hidden child process
// so that output lands in a terminal, a running emulator can be stopped from
// the view, and the same invocation can be written down in tasks.json under
// the `8bs` task type declared in package.json.
const path = require('path');

const vscode = require('vscode');

const {
  CONFIG_FILE,
  MACHINE_TARGETS,
  commandArgs,
  findToolchain,
  loadProject,
  loadProjects,
} = require('./projects.cjs');

const TASK_TYPE = '8bs';
const VIEW_ID = '8bitscript.projects';

// Passing an explicit exclude replaces the editor's files.exclude defaults, so
// everything that hides a project copy has to be listed here: installed
// packages, git internals, and the per-session worktrees the agent tooling
// keeps under .claude/worktrees, each a whole second checkout of the repo.
const SEARCH_EXCLUDE = '{**/node_modules/**,**/.git/**,**/.claude/worktrees/**}';

/** @returns {'ntsc' | 'pal'} */
function defaultRegion() {
  return vscode.workspace.getConfiguration('8bitscript').get('region') === 'pal' ? 'pal' : 'ntsc';
}

function regionLabel(region) {
  return region === 'pal' ? 'PAL' : 'NTSC';
}

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
  const suffix = target ? ` ${target}${MACHINE_TARGETS.has(target) ? ` (${regionLabel(region)})` : ''}` : '';
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

class ProjectsProvider {
  constructor(output) {
    this.output = output;
    this.projects = [];
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.running = new RunningTasks(() => this.changed.fire());
  }

  async refresh() {
    const found = await vscode.workspace.findFiles(`**/${CONFIG_FILE}`, SEARCH_EXCLUDE);
    this.projects = loadProjects(found.map((uri) => uri.fsPath));
    this.output.appendLine(
      `Projects: ${this.projects.length === 0 ? 'none found' : this.projects.map((p) => p.name).join(', ')}`,
    );
    await vscode.commands.executeCommand(
      'setContext',
      '8bitscript.hasProjects',
      this.projects.length > 0,
    );
    this.changed.fire();
  }

  getChildren(node) {
    if (!node) return this.projects.map((project) => ({ kind: 'project', project }));
    if (node.kind === 'project') {
      return node.project.targets.map((target) => ({ kind: 'target', project: node.project, target }));
    }
    return [];
  }

  getTreeItem(node) {
    return node.kind === 'project' ? this.projectItem(node.project) : this.targetItem(node);
  }

  projectItem(project) {
    const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.Expanded);
    const running = this.running.isRunning(project.dir);
    const states = [running && 'running', !project.toolchain && 'notoolchain'].filter(Boolean);
    item.contextValue = ['project', ...states].join('.');
    item.id = project.dir;
    item.description = project.toolchain ? relativeDir(project.dir) : 'toolchain not installed';
    item.tooltip = new vscode.MarkdownString(
      [
        `**${project.name}**${project.description ? ` — ${project.description}` : ''}`,
        '',
        `Directory: \`${project.dir}\``,
        `Entry: \`${path.relative(project.dir, project.entry)}\``,
        project.toolchain
          ? `Toolchain: \`${project.toolchain}\``
          : 'Toolchain: **not installed** — run `pnpm install` in the project.',
      ].join('\n'),
    );
    item.iconPath = new vscode.ThemeIcon(
      running ? 'loading~spin' : project.toolchain ? 'package' : 'warning',
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
    item.description = running ? 'running' : machine ? regionLabel(defaultRegion()) : '';
    item.iconPath = running ? new vscode.ThemeIcon('loading~spin') : targetIcon(target);
    item.tooltip = `8bs ${commandArgs('run', target, defaultRegion()).join(' ')}`;
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
    for (const project of this.provider.projects) {
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
    const project = this.provider.projects.find((p) => p.dir === dir)
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

  context.subscriptions.push(vscode.tasks.registerTaskProvider(TASK_TYPE, new TaskProvider(provider)));

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE}`);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => provider.refresh()),
    watcher.onDidDelete(() => provider.refresh()),
    watcher.onDidChange(() => provider.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('8bitscript.region')) provider.changed.fire();
    }),
  );

  /** Resolve the node an action was invoked on, asking when there is none. */
  async function targetOf(node, action) {
    if (node?.kind === 'target') return node;
    if (node?.kind === 'project') {
      const target = await pickTarget(node.project, action);
      return target ? { kind: 'target', project: node.project, target } : undefined;
    }
    const project = await pickProject(action);
    if (!project) return undefined;
    const target = await pickTarget(project, action);
    return target ? { kind: 'target', project, target } : undefined;
  }

  async function pickProject(action) {
    if (provider.projects.length === 0) await provider.refresh();
    if (provider.projects.length === 0) {
      vscode.window.showInformationMessage(
        `No 8BitScript projects found. A project is a directory with an ${CONFIG_FILE}.`,
      );
      return undefined;
    }
    if (provider.projects.length === 1) return provider.projects[0];
    const picked = await vscode.window.showQuickPick(
      provider.projects.map((project) => ({
        label: project.name,
        description: relativeDir(project.dir),
        detail: project.description || undefined,
        project,
      })),
      { placeHolder: `Which project to ${action}?` },
    );
    return picked?.project;
  }

  async function pickTarget(project, action) {
    if (project.targets.length === 1) return project.targets[0];
    const picked = await vscode.window.showQuickPick(
      project.targets.map((target) => ({ label: target, target })),
      { placeHolder: `Which system to ${action} ${project.name} on?` },
    );
    return picked?.target;
  }

  function requireToolchain(project) {
    if (project.toolchain) return true;
    output.appendLine(`No 8bs toolchain for ${project.name}: searched upward from ${project.dir}`);
    vscode.window
      .showErrorMessage(
        `No 8bs toolchain found for ${project.name}. Run pnpm install in ${relativeDir(project.dir)}, ` +
          'or pnpm add -D @8bitscript/cli.',
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
    const task = makeTask(project, action, target, region);
    output.appendLine(`${task.name}: ${task.detail}`);
    await vscode.tasks.executeTask(task);
  }

  async function doctor() {
    if (provider.projects.length === 0) await provider.refresh();
    const project = provider.projects.find((p) => p.toolchain);
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

  const command = (id, handler) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  command('8bitscript.projects.refresh', () => provider.refresh());
  command('8bitscript.doctor', doctor);
  command('8bitscript.run', (node) => execute('run', defaultRegion(), node));
  command('8bitscript.build', (node) => execute('build', defaultRegion(), node));
  command('8bitscript.runNtsc', (node) => execute('run', 'ntsc', node));
  command('8bitscript.buildNtsc', (node) => execute('build', 'ntsc', node));
  command('8bitscript.runPal', (node) => execute('run', 'pal', node));
  command('8bitscript.buildPal', (node) => execute('build', 'pal', node));
  command('8bitscript.stop', (node) => {
    if (node?.kind === 'target') provider.running.stop(node.project.dir, node.target);
    else if (node?.kind === 'project') provider.running.stop(node.project.dir);
    else for (const execution of provider.running.executions) execution.terminate();
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
