// runner.cjs wires the side bar's project model, task provider, and every
// palette command into the extension. Most of it is `vscode` calls that
// have never been loadable under plain `node --test`; the vscode mock
// makes that possible, so these exercise the real class methods and
// command handlers instead of only the vscode-free half projects.cjs
// covers on its own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const { Projects, makeTask, registerRunner } = require('../src/runner.cjs');
const { renderView } = require('../src/assemblyView.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '8bs-runner-'));
}

function writeConfig(dir, entry = 'src/main.8bs', targets = ['c64']) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, entry), 'export function main(): void {}\n');
  fs.writeFileSync(
    path.join(dir, '8bitscript.config.ts'),
    `export default { entry: '${entry}', targets: ${JSON.stringify(targets)} };\n`,
  );
}

/** A fake `8bs` CLI: a .mjs script node can actually run, so loadTargets()
 * exercises a real child process rather than a mocked one. */
function writeFakeCli(dir, behavior = 'targets') {
  const file = path.join(dir, 'fake-8bs.mjs');
  const body = behavior === 'targets'
    ? `console.log(JSON.stringify({ targets: [{ id: 'c64', title: 'C64', emulator: 'x64sc', region: true, options: {}, presets: {}, profiles: {}, hardware: {}, facts: {} }], systems: [{ name: 'Named C64', target: 'c64', origin: 'project', label: 'stock' }], facts: [] }));`
    : `process.stderr.write('boom'); process.exit(1);`;
  fs.writeFileSync(file, body);
  return file;
}

function fakeProject(dir, overrides = {}) {
  return {
    kind: 'project',
    name: 'my-game',
    dir,
    configPath: path.join(dir, '8bitscript.config.ts'),
    entry: path.join(dir, 'src', 'main.8bs'),
    targets: ['c64'],
    toolchain: null,
    packageManager: 'pnpm',
    installed: true,
    ...overrides,
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeContext(storageDir) {
  return { subscriptions: [], globalStorageUri: { fsPath: storageDir } };
}

function disposeContext(context) {
  for (const subscription of context.subscriptions) subscription.dispose?.();
}

/**
 * registerRunner() starts a 1s setInterval (startLivePoll) that only stops
 * via the disposable it pushed onto context.subscriptions — an
 * undisposed one keeps the process (and `node --test`) alive forever, so
 * every test that calls registerRunner must dispose its context.
 */
async function withRunner(storageDir, output, fn) {
  const context = makeContext(storageDir);
  try {
    const projects = registerRunner(context, output);
    await tick();
    await fn(projects, context);
  } finally {
    disposeContext(context);
  }
}

test('makeTask: a plain run names the machine, region, and hardware fitted', () => {
  const project = fakeProject('/proj', { toolchain: '/proj/node_modules/.bin/8bs' });
  const task = makeTask(project, 'run', 'c64', 'ntsc', { profile: null, options: {} });
  assert.equal(task.name, 'my-game: run c64 (NTSC)');
  assert.deepEqual(task.execution.args, ['run', 'c64', '--size']);
  assert.equal(task.definition.target, 'c64');
});

test('makeTask: a web run always adds an ephemeral port; LAN is on by default so no --local', () => {
  const project = fakeProject('/proj', { toolchain: '/proj/node_modules/.bin/8bs' });
  vscode.__mock.reset();
  const task = makeTask(project, 'run', 'web', 'ntsc');
  assert.deepEqual(task.execution.args, ['run', 'web', '--size', '--port', '0']);
});

test('makeTask: LAN explicitly off adds --local to a web run', () => {
  const project = fakeProject('/proj', { toolchain: '/proj/node_modules/.bin/8bs' });
  vscode.__mock.reset();
  vscode.__mock.configStore.set('webLan', false);
  const task = makeTask(project, 'run', 'web', 'ntsc');
  assert.deepEqual(task.execution.args, ['run', 'web', '--size', '--port', '0', '--local']);
});

test('makeTask: a native cx16 run passes capture and fullscreen flags from settings; boot does too; Studio tab does not', () => {
  const project = fakeProject('/proj', { toolchain: '/proj/node_modules/.bin/8bs' });
  vscode.__mock.reset();
  const runCx16 = makeTask(project, 'run', 'cx16', 'ntsc', { profile: null, options: {} });
  assert.deepEqual(runCx16.execution.args, ['run', 'cx16', '--size', '--capture-mouse', '--fullscreen']);
  const bootCx16 = makeTask(project, 'boot', 'cx16', 'ntsc', { profile: null, options: {} });
  assert.deepEqual(bootCx16.execution.args, ['boot', 'cx16', '--capture-mouse', '--fullscreen']);
  vscode.__mock.configStore.set('cx16.captureMouse', false);
  vscode.__mock.configStore.set('cx16.fullscreen', false);
  const runOff = makeTask(project, 'run', 'cx16', 'ntsc', { profile: null, options: {} });
  assert.deepEqual(runOff.execution.args, ['run', 'cx16', '--size', '--no-capture-mouse', '--no-fullscreen']);
  vscode.__mock.reset();
  const studio = makeTask(project, 'run', 'cx16', 'ntsc', { profile: null, options: {} }, { web: true });
  assert.deepEqual(studio.execution.args, ['run', 'cx16', '--size', '--web', '--no-open', '--port', '0']);
  assert.doesNotMatch(studio.execution.args.join(' '), /--capture-mouse/);
});

test('makeTask: a run for the Studio tab adds --web --no-open --port 0, marks the definition, and says so in the name', () => {
  const project = fakeProject('/proj', { toolchain: '/proj/node_modules/.bin/8bs', name: '@8bitscript/studio' });
  vscode.__mock.reset();
  const task = makeTask(project, 'run', 'cx16', 'ntsc', { profile: null, options: {} }, { web: true });
  assert.deepEqual(task.execution.args, ['run', 'cx16', '--size', '--web', '--no-open', '--port', '0']);
  assert.equal(task.definition.web, true);
  assert.equal(task.name, '@8bitscript/studio: run cx16 in a tab');
  const plain = makeTask(project, 'run', 'cx16', 'ntsc', { profile: null, options: {} });
  assert.equal(plain.definition.web, undefined);
  assert.doesNotMatch(plain.name, /in a tab/);
});

test('makeTask: a named system runs by name, not target/hardware', () => {
  const project = fakeProject('/proj', { toolchain: '/proj/node_modules/.bin/8bs' });
  const task = makeTask(project, 'run', 'c64', 'pal', { profile: 'x', options: { port1: 'joystick' } }, { system: 'Named C64' });
  assert.equal(task.name, 'my-game: run Named C64');
  assert.deepEqual(task.execution.args, ['run', '--system', 'Named C64', '--size']);
  // The pal flag on the task definition still follows the (target, region)
  // pair given, independent of whether a named system was also given —
  // execute() is what decides which region a named system actually runs
  // with before it ever calls makeTask.
  assert.equal(task.definition.pal, true);
});

test('makeTask: a .mjs toolchain runs through node, not directly', () => {
  const project = fakeProject('/proj', { toolchain: '/proj/node_modules/@8bitscript/cli/bin/8bs.mjs' });
  const task = makeTask(project, 'build', 'c64', 'ntsc');
  assert.equal(task.execution.commandLine.value, process.execPath);
  assert.deepEqual(task.execution.args.slice(0, 1), [project.toolchain]);
  assert.equal(task.execution.options.env.ELECTRON_RUN_AS_NODE, undefined, 'plain Node does not need ELECTRON_RUN_AS_NODE');
  assert.ok(task.execution.options.env.PATH, 'tasks still get the well-known bins a GUI editor lacks');
});

test('Projects.checkoutFlag: an open workspace folder that is itself a checkout wins', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'packages', 'cli', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    fs.writeFileSync(path.join(dir, 'packages', 'cli', 'bin', '8bs.mjs'), '');
    vscode.__mock.reset();
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir }, name: 'root' }];
    const projects = new Projects({ appendLine() {} });
    assert.equal(projects.checkoutFlag(), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Projects.checkoutFlag: nothing open and no setting is null', () => {
  vscode.__mock.reset();
  const projects = new Projects({ appendLine() {} });
  assert.equal(projects.checkoutFlag(), null);
});

test('Projects.loadTargets: runs the real CLI and caches per directory', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    const cli = writeFakeCli(dir);
    vscode.__mock.reset();
    const output = { lines: [], appendLine(line) { this.lines.push(line); } };
    const projects = new Projects(output);
    projects.projects = [fakeProject(dir, { toolchain: cli })];
    const targets = await projects.loadTargets(dir);
    assert.ok(targets.get('c64'));
    assert.equal(targets.systems[0].name, 'Named C64');
    const again = await projects.loadTargets(dir);
    assert.equal(again, targets, 'the same directory is served from cache until refresh() clears it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Projects.loadTargets: a failing CLI resolves null and logs it', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    const cli = writeFakeCli(dir, 'fail');
    vscode.__mock.reset();
    const output = { lines: [], appendLine(line) { this.lines.push(line); } };
    const projects = new Projects(output);
    projects.projects = [fakeProject(dir, { toolchain: cli })];
    const targets = await projects.loadTargets(dir);
    assert.equal(targets, null);
    assert.ok(output.lines.some((l) => l.includes('8bs targets --json failed')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Projects.loadTargets: no toolchain anywhere resolves null without spawning anything', async () => {
  vscode.__mock.reset();
  const projects = new Projects({ appendLine() {} });
  assert.equal(await projects.loadTargets('/nowhere'), null);
});

test('Projects.refresh: finds workspace projects and fires onDidChange', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    const output = { lines: [], appendLine(line) { this.lines.push(line); } };
    const projects = new Projects(output);
    let changed = false;
    projects.onDidChange(() => { changed = true; });
    await projects.refresh();
    assert.equal(projects.projects.length, 1);
    assert.equal(projects.projects[0].name, path.basename(dir));
    assert.equal(changed, true);
    const setContext = vscode.__mock.executedCommands.find((c) => c.id === 'setContext');
    assert.ok(setContext, 'the examples-toggle context is refreshed too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Projects.visible hides shipped examples when showExamples is off, apps stay', () => {
  vscode.__mock.reset();
  vscode.__mock.configStore.set('showExamples', false);
  const projects = new Projects({ appendLine() {} });
  projects.examples = [fakeProject('/ex', { kind: 'example', name: 'demo' })];
  projects.apps = [fakeProject('/app', { kind: 'app', name: 'studio' })];
  const names = projects.visible.map((p) => p.name);
  assert.ok(!names.includes('demo'));
  assert.ok(names.includes('studio'));
});

test('registerRunner: run resolves a named system through settings and executes the right task', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    const cli = writeFakeCli(dir);
    vscode.__mock.reset();
    vscode.__mock.configStore.set('namedSystem', 'Named C64');
    vscode.__mock.configStore.set('project', dir);
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      // The project the scan found has no toolchain (fake CLI isn't wired
      // through node_modules resolution) — point it at the fake CLI so
      // targetOf's named-system lookup actually runs a real process.
      projects.projects[0].toolchain = cli;
      await vscode.__mock.trigger('8bitscript.run');
      await tick();
      const executed = vscode.__mock.executedTasks.at(-1);
      assert.ok(executed, 'a task was executed');
      assert.match(executed.task.name, /Named C64/);
      // args[0] is the .mjs toolchain path node runs; the CLI args follow.
      assert.deepEqual(executed.task.execution.args.slice(1, 4), ['run', '--system', 'Named C64']);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: install refuses a package manager that cannot be found on PATH', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.install', {
        dir, name: 'my-game', packageManager: 'not-a-real-package-manager-xyz',
      });
      await tick();
      assert.equal(vscode.__mock.calls.showErrorMessage.length, 1);
      assert.match(vscode.__mock.calls.showErrorMessage[0][0], /was not found/);
      assert.equal(vscode.__mock.executedTasks.length, 0, 'nothing was launched');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: missing pnpm offers Run Doctor instead of a PATH lecture', async () => {
  const dir = tmpDir();
  const home = tmpDir();
  const prev = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    PNPM_HOME: process.env.PNPM_HOME,
    NVM_BIN: process.env.NVM_BIN,
  };
  try {
    process.env.HOME = home;
    process.env.PATH = '/usr/bin';
    delete process.env.PNPM_HOME;
    delete process.env.NVM_BIN;
    writeConfig(dir);
    vscode.__mock.reset();
    vscode.__mock.queues.showErrorMessage.push('Run Doctor');
    vscode.workspace.findFiles = () => Promise.resolve([]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.install', {
        dir, name: 'my-game', packageManager: 'pnpm',
      });
      await tick();
      const shown = vscode.__mock.calls.showErrorMessage[0];
      assert.ok(shown, 'the missing-pnpm dialog ran');
      assert.match(shown[0], /Run 8BitScript: Doctor to install it/);
      assert.equal(shown[1], 'Run Doctor');
      await tick();
      assert.ok(
        vscode.__mock.executedCommands.some((c) => c.id === '8bitscript.doctor'),
        'Run Doctor starts 8bs doctor',
      );
    });
  } finally {
    process.env.HOME = prev.HOME;
    process.env.PATH = prev.PATH;
    if (prev.PNPM_HOME === undefined) delete process.env.PNPM_HOME;
    else process.env.PNPM_HOME = prev.PNPM_HOME;
    if (prev.NVM_BIN === undefined) delete process.env.NVM_BIN;
    else process.env.NVM_BIN = prev.NVM_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('registerRunner: useLocal rejects a directory that is not an 8BitScript checkout', async () => {
  const dir = tmpDir();
  const notACheckout = tmpDir();
  try {
    writeConfig(dir);
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    vscode.window.showOpenDialog = () => Promise.resolve([{ fsPath: notACheckout }]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.useLocal');
      await tick();
      assert.match(vscode.__mock.calls.showErrorMessage.at(-1)[0], /not an 8BitScript checkout/);
      assert.equal(vscode.__mock.configStore.get('checkout'), undefined);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(notACheckout, { recursive: true, force: true });
  }
});

test('registerRunner: usePublished clears the checkout setting', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    vscode.__mock.reset();
    vscode.__mock.configStore.set('checkout', '/somewhere/8bitscript');
    vscode.workspace.findFiles = () => Promise.resolve([]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.usePublished');
      await tick();
      assert.equal(vscode.__mock.configStore.get('checkout'), '');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: stop terminates every running execution when no node is given', async () => {
  const dir = tmpDir();
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      let terminated = false;
      const execution = { task: { definition: { type: '8bs' } }, terminate: () => { terminated = true; } };
      projects.running.executions.add(execution);
      await vscode.__mock.trigger('8bitscript.stop');
      assert.equal(terminated, true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: install with a real package manager on PATH launches and refreshes on completion', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.install', { dir, name: 'my-game', packageManager: 'npm' });
      await tick();
      assert.equal(vscode.__mock.calls.showErrorMessage.length, 0);
      const executed = vscode.__mock.executedTasks.at(-1);
      assert.ok(executed, 'the install task was launched');
      assert.match(executed.task.name, /my-game: install/);
      // registerRunner's own onDidEndTask listener refreshes the project
      // list once this specific execution ends.
      vscode.__mock.taskEmitters.onDidEndTask.fire({ execution: executed });
      await tick();
      const setContext = vscode.__mock.executedCommands.filter((c) => c.id === 'setContext');
      assert.ok(setContext.length > 0, 'refresh() ran and touched the examples-toggle context');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: run executes a plain machine target end to end', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    const cli = writeFakeCli(dir);
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      projects.projects[0].toolchain = cli;
      projects.projects[0].installed = true;
      await vscode.__mock.trigger('8bitscript.run', { project: projects.projects[0], target: 'c64' });
      await tick();
      const executed = vscode.__mock.executedTasks.at(-1);
      assert.ok(executed, 'a task was executed');
      assert.equal(executed.task.definition.target, 'c64');
      assert.equal(executed.task.definition.command, 'run');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: run offers to install first when the project is not installed', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      projects.projects[0].toolchain = path.join(dir, 'fake.mjs');
      fs.writeFileSync(projects.projects[0].toolchain, '');
      projects.projects[0].installed = false;
      // Decline the offer: nothing should run.
      await vscode.__mock.trigger('8bitscript.run', { project: projects.projects[0], target: 'c64' });
      await tick();
      assert.equal(vscode.__mock.calls.showWarningMessage.length, 1);
      assert.equal(vscode.__mock.executedTasks.length, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: doctor reports when no toolchain is found anywhere', async () => {
  const dir = tmpDir();
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.doctor');
      await tick();
      assert.match(vscode.__mock.calls.showErrorMessage.at(-1)[0], /No 8bs toolchain found/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: doctor runs against the project with a toolchain', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    const cli = writeFakeCli(dir);
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      projects.projects[0].toolchain = cli;
      await vscode.__mock.trigger('8bitscript.doctor');
      await tick();
      const executed = vscode.__mock.executedTasks.at(-1);
      assert.ok(executed);
      assert.equal(executed.task.definition.command, 'doctor');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: chooseSystem writes the picked named system and machine', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    const cli = writeFakeCli(dir);
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      projects.projects[0].toolchain = cli;
      vscode.__mock.queues.showQuickPick.push({ named: 'Named C64', target: 'c64' });
      await vscode.__mock.trigger('8bitscript.selectSystem');
      await tick();
      assert.equal(vscode.__mock.configStore.get('namedSystem'), 'Named C64');
      assert.equal(vscode.__mock.configStore.get('system'), 'c64');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: chooseSystem does nothing when the separator itself is picked', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    const cli = writeFakeCli(dir);
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      projects.projects[0].toolchain = cli;
      vscode.__mock.queues.showQuickPick.push({ label: 'Named systems', kind: vscode.QuickPickItemKind.Separator });
      await vscode.__mock.trigger('8bitscript.selectSystem');
      await tick();
      assert.equal(vscode.__mock.configStore.get('namedSystem'), undefined);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: chooseRegion writes the picked region', async () => {
  const dir = tmpDir();
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      vscode.__mock.queues.showQuickPick.push({ region: 'pal' });
      await vscode.__mock.trigger('8bitscript.selectRegion');
      await tick();
      assert.equal(vscode.__mock.configStore.get('region'), 'pal');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: launchExample reports when nothing ships', async () => {
  const dir = tmpDir();
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.launchExample');
      await tick();
      assert.match(vscode.__mock.calls.showInformationMessage.at(-1)[0], /No examples found/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: launchApp runs the one shipped app straight away', async () => {
  const dir = tmpDir();
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      const cli = writeFakeCli(dir);
      projects.apps = [fakeProject(dir, {
        kind: 'app', name: '@8bitscript/studio', title: 'Studio', toolchain: cli, installed: true,
      })];
      // The app's own named system ("Named C64", from the fake CLI's
      // systems list) is offered — pick it, same as a person choosing the
      // first (and only) option.
      vscode.__mock.queues.showQuickPick.push({ system: { name: 'Named C64', target: 'c64' } });
      await vscode.__mock.trigger('8bitscript.launchApp');
      await tick();
      const executed = vscode.__mock.executedTasks.at(-1);
      assert.ok(executed, 'the single app launched without asking which project');
      assert.match(executed.task.name, /Named C64/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: openStudio runs Studio on the X16 with no picker and no change to the selection', async () => {
  const dir = tmpDir();
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    vscode.__mock.configStore.set('project', '/somewhere/else');
    vscode.__mock.configStore.set('system', 'pet');
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      const cli = writeFakeCli(dir);
      projects.apps = [fakeProject(dir, {
        kind: 'app', name: '@8bitscript/studio', title: 'Studio', toolchain: cli, installed: true,
      })];
      // Nothing queued for showQuickPick: the command must not ask.
      await vscode.__mock.trigger('8bitscript.openStudio');
      await tick();
      const executed = vscode.__mock.executedTasks.at(-1);
      assert.ok(executed, 'Studio launched');
      assert.equal(executed.task.definition.command, 'run');
      assert.equal(executed.task.definition.target, 'cx16', 'on the machine it is designed on');
      assert.equal(vscode.__mock.configStore.get('project'), '/somewhere/else', 'the selected project is untouched');
      assert.equal(vscode.__mock.configStore.get('system'), 'pet', 'and so is the selected system');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: openStudioTab stops the tab\'s earlier run, starts Studio on the X16 in the WebAssembly emulator, and shows the tab', async () => {
  const dir = tmpDir();
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    const shown = [];
    vscode.commands.registerCommand('8bitscript.studioTab.show', (run) => shown.push(run));
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      const cli = writeFakeCli(dir);
      projects.apps = [fakeProject(dir, {
        kind: 'app', name: '@8bitscript/studio', title: 'Studio', toolchain: cli, installed: true,
      })];
      // An earlier tab run, and a native window: only the former is ended.
      const ended = [];
      const running = (web) => ({ task: { definition: { type: '8bitscript', command: 'run', projectDir: dir, target: 'cx16', ...(web ? { web: true } : {}) }, name: 'x' }, terminate: () => ended.push(web) });
      projects.running.executions.add(running(true));
      projects.running.executions.add(running(false));
      const before = Date.now();
      await vscode.__mock.trigger('8bitscript.openStudioTab');
      await tick();
      assert.deepEqual(ended, [true]);
      const executed = vscode.__mock.executedTasks.at(-1);
      assert.ok(executed, 'Studio launched');
      assert.equal(executed.task.definition.target, 'cx16');
      assert.equal(executed.task.definition.web, true);
      assert.deepEqual(executed.task.execution.args.slice(-4), ['--web', '--no-open', '--port', '0']);
      assert.equal(shown.length, 1);
      assert.equal(shown[0].dir, dir);
      assert.equal(shown[0].target, 'cx16');
      assert.ok(shown[0].launchedAt >= before);
    });
    // No Studio: a message, no task, no tab.
    vscode.__mock.reset();
    vscode.commands.registerCommand('8bitscript.studioTab.show', (run) => shown.push(run));
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.openStudioTab');
      await tick();
      assert.equal(vscode.__mock.executedTasks.length, 0);
      assert.equal(shown.length, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: openStudio opens Studio on the system the menu named — a named system or a bare machine — and on the X16 for one it no longer lists', async () => {
  const dir = tmpDir();
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      const cli = writeFakeCli(dir);
      projects.apps = [fakeProject(dir, {
        kind: 'app', name: '@8bitscript/studio', title: 'Studio', toolchain: cli, installed: true,
      })];
      // The fake CLI lists one named system for the app: "Named C64".
      await vscode.__mock.trigger('8bitscript.openStudio', { system: 'Named C64' });
      await tick();
      let executed = vscode.__mock.executedTasks.at(-1);
      assert.equal(executed.task.definition.target, 'c64');
      assert.match(executed.task.name, /Named C64/);

      await vscode.__mock.trigger('8bitscript.openStudio', { system: 'pet' });
      await tick();
      executed = vscode.__mock.executedTasks.at(-1);
      assert.equal(executed.task.definition.target, 'pet', 'a bare machine from the Machines group');

      await vscode.__mock.trigger('8bitscript.openStudio', { system: 'A system Studio forgot' });
      await tick();
      executed = vscode.__mock.executedTasks.at(-1);
      assert.equal(executed.task.definition.target, 'cx16', 'the baseline, when the name is stale');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: openStudio says so when Studio is not installed', async () => {
  const dir = tmpDir();
  try {
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.openStudio');
      await tick();
      assert.match(vscode.__mock.calls.showInformationMessage.at(-1)[0], /Studio is not installed/);
      assert.equal(vscode.__mock.executedTasks.length, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: saveSystem refuses a target the project does not build for', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    vscode.__mock.reset();
    vscode.__mock.configStore.set('project', dir);
    vscode.__mock.configStore.set('system', 'nes');
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.saveSystem');
      await tick();
      assert.match(vscode.__mock.calls.showWarningMessage.at(-1)[0], /does not target/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: saveSystem writes a system into a plain config', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    const cli = writeFakeCli(dir);
    vscode.__mock.reset();
    vscode.__mock.configStore.set('project', dir);
    vscode.__mock.configStore.set('system', 'c64');
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    vscode.window.showInputBox = () => Promise.resolve('My C64');
    vscode.workspace.openTextDocument = (uri) => Promise.resolve({
      uri,
      getText: () => "export default {\n  targets: ['c64'],\n};\n",
      positionAt: (offset) => ({ offset }),
      save: () => Promise.resolve(true),
    });
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      projects.projects[0].toolchain = cli;
      await vscode.__mock.trigger('8bitscript.saveSystem');
      await tick();
      assert.ok(vscode.__mock.executedCommands.some((c) => c.applyEdit), 'the config was rewritten');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: useLocal accepts a real checkout and wires the project to it', async () => {
  const dir = tmpDir();
  const checkoutDir = tmpDir();
  try {
    writeConfig(dir);
    fs.mkdirSync(path.join(checkoutDir, 'packages', 'cli', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(checkoutDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    fs.writeFileSync(path.join(checkoutDir, 'packages', 'cli', 'bin', '8bs.mjs'), '');
    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    vscode.window.showOpenDialog = () => Promise.resolve([{ fsPath: checkoutDir }]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.useLocal');
      await tick();
      assert.equal(vscode.__mock.configStore.get('checkout'), checkoutDir);
      assert.equal(vscode.__mock.calls.showErrorMessage.length, 0);
      const restarted = vscode.__mock.executedCommands.find((c) => c.id === '8bitscript.restartServer');
      assert.ok(restarted, 'the language server was told to restart against the new checkout');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test('registerRunner: viewGeneratedAssembly shows an info message with no active editor, and does nothing else', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    vscode.__mock.reset();
    vscode.window.activeTextEditor = undefined;
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async () => {
      await vscode.__mock.trigger('8bitscript.viewGeneratedAssembly');
      await tick();
      assert.equal(vscode.__mock.calls.showInformationMessage.length, 1);
      assert.match(vscode.__mock.calls.showInformationMessage[0][0], /Open an \.8bs or \.8bx file/);
    });
  } finally {
    vscode.window.activeTextEditor = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: viewGeneratedAssembly runs 8bs build --debug, opens the filtered listing beside the source, and navigates back to source on selection', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir);
    const sourcePath = path.join(dir, 'src', 'main.8bs');
    const sourceText = 'export function main(): void {\n    let score: utinyint = 0;\n    score += 1;\n}\n';
    fs.writeFileSync(sourcePath, sourceText);

    // A fake CLI that behaves like `8bs build --debug`: writes a real
    // debug map next to a fake artifact and prints the same "debug map:"
    // line packages/cli/src/build.mjs's own --debug support prints.
    const debugMapPath = path.join(dir, 'out.8bs.debug.json');
    const scoreStart = sourceText.indexOf('score += 1');
    const debugMap = {
      format: '8bitscript-debug', version: 1, target: 'c64', modules: [sourcePath], symbols: [],
      instructions: [
        {
          address: 0xc142, artifactOffset: 10, size: 2, bytes: [0xa5, 0x18], assembly: 'LDA $18',
          source: { file: sourcePath, start: scoreStart, length: 10, line: 3, column: 5, text: 'score += 1;' },
          function: 'main', origin: null, component: null,
        },
      ],
    };
    const cliPath = path.join(dir, 'fake-debug-8bs.mjs');
    fs.writeFileSync(cliPath, [
      `import { writeFileSync } from 'node:fs';`,
      `writeFileSync(${JSON.stringify(debugMapPath)}, ${JSON.stringify(JSON.stringify(debugMap))});`,
      `console.log('built out.prg');`,
      `console.log('debug map: ${debugMapPath.replace(/\\/g, '\\\\')}');`,
    ].join('\n'));

    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);

    // A minimal fake TextDocument for the source file — real offsetAt/
    // positionAt over the real text, since this is what samePath()/the
    // cursor-matching logic actually reads.
    const document = {
      uri: { fsPath: sourcePath, scheme: 'file' },
      fileName: sourcePath,
      offsetAt: (position) => position.line === 0 ? position.character
        : sourceText.split('\n').slice(0, position.line).join('\n').length + 1 + position.character,
      positionAt: (offset) => {
        const before = sourceText.slice(0, offset).split('\n');
        return { line: before.length - 1, character: before.at(-1).length };
      },
    };
    vscode.window.activeTextEditor = { document, selection: { active: { line: 2, character: 6 } } };

    const shown = [];
    const originalShowTextDocument = vscode.window.showTextDocument;
    vscode.window.showTextDocument = (docOrUri, options) => {
      shown.push({ docOrUri, options });
      return originalShowTextDocument(docOrUri, options);
    };

    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      projects.projects[0].toolchain = cliPath;
      projects.projects[0].installed = true;
      await vscode.__mock.trigger('8bitscript.viewGeneratedAssembly', { project: projects.projects[0], target: 'c64' });
      await tick();

      assert.equal(vscode.__mock.calls.showErrorMessage.length, 0, JSON.stringify(vscode.__mock.calls.showErrorMessage));
      const asmShown = shown.find((s) => s.options?.viewColumn === vscode.ViewColumn.Beside);
      assert.ok(asmShown, 'the assembly view was opened beside the source');
      const asmUri = asmShown.docOrUri.uri ?? asmShown.docOrUri;
      assert.equal(asmUri.scheme, '8bitscript-asm');

      // Selecting the LDA line in the asm view should navigate back to
      // the exact `score += 1;` span in the source file — the "assembly
      // -> source" half of bidirectional navigation. The line index is
      // derived from renderView() itself (assemblyView.cjs), the same way
      // showForCursor() built it, rather than hard-coded against its
      // current header/blank-line layout.
      const { lineSources } = renderView(sourcePath, [debugMap.instructions[0]], new Set([debugMap.instructions[0]]));
      const ldaLine = lineSources.findIndex((s) => s && s.start === scoreStart);
      assert.ok(ldaLine >= 0, 'renderView should have produced a line for the LDA instruction');
      shown.length = 0;
      vscode.__mock.fireSelectionChange({ textEditor: { document: { uri: asmUri } }, selections: [{ active: { line: ldaLine } }] });
      await tick();
      const navigated = shown.find((s) => s.options?.viewColumn === vscode.ViewColumn.One && s.options?.preserveFocus === true);
      assert.ok(navigated, 'clicking the LDA line should navigate back to the source file');
      assert.equal(navigated.docOrUri.uri.fsPath, sourcePath);
    });
  } finally {
    vscode.window.activeTextEditor = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRunner: viewGeneratedAssemblyFor opens the machine the reader picks (not just the currently selected one), and assemblyView.openForMachine opens another from that tab', async () => {
  const dir = tmpDir();
  try {
    writeConfig(dir, 'src/main.8bs', ['c64', 'vic20']);
    const sourcePath = path.join(dir, 'src', 'main.8bs');

    // A fake CLI that reports which --target it was asked to build for, so
    // this test can tell the vic20 tab apart from the c64 one.
    const cliPath = path.join(dir, 'fake-debug-8bs.mjs');
    fs.writeFileSync(cliPath, [
      `import { writeFileSync } from 'node:fs';`,
      `const target = process.argv[process.argv.indexOf('--target') + 1];`,
      `const debugMapPath = ${JSON.stringify(dir)} + '/out-' + target + '.8bs.debug.json';`,
      `const debugMap = {`,
      `  format: '8bitscript-debug', version: 1, target, modules: [${JSON.stringify(sourcePath)}], symbols: [],`,
      `  instructions: [{`,
      `    address: target === 'vic20' ? 0xd200 : 0xc142, artifactOffset: 0, size: 2, bytes: [0xa5, 0x18], assembly: 'LDA $18',`,
      `    source: { file: ${JSON.stringify(sourcePath)}, start: 0, length: 5, line: 1, column: 1 },`,
      `    function: 'main', origin: null, component: null,`,
      `  }],`,
      `};`,
      `writeFileSync(debugMapPath, JSON.stringify(debugMap));`,
      `console.log('built out.prg');`,
      `console.log('debug map: ' + debugMapPath);`,
    ].join('\n'));

    vscode.__mock.reset();
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.ts') }]);
    const document = {
      uri: { fsPath: sourcePath, scheme: 'file' },
      fileName: sourcePath,
      offsetAt: () => 0,
      positionAt: (offset) => ({ line: 0, character: offset }),
    };
    vscode.window.activeTextEditor = { document, selection: { active: { line: 0, character: 0 } } };

    await withRunner(path.join(dir, '.storage'), { appendLine() {} }, async (projects) => {
      projects.projects[0].toolchain = cliPath;
      projects.projects[0].installed = true;

      // The default command would build c64 (the target this node names);
      // "For…" lets the reader override it, without ever visiting c64.
      vscode.__mock.queues.showQuickPick.push({ target: 'vic20' });
      await vscode.__mock.trigger('8bitscript.viewGeneratedAssemblyFor', { project: projects.projects[0], target: 'c64' });
      await tick();
      const vic20Tab = vscode.window.visibleTextEditors.find((e) => e.document.uri?.toString?.().includes('/vic20/'));
      assert.ok(vic20Tab, 'the picked machine (vic20) was opened, not the node\'s own default (c64)');

      // Open the plain c64 view too — both machines' tabs now coexist.
      await vscode.__mock.trigger('8bitscript.viewGeneratedAssembly', { project: projects.projects[0], target: 'c64' });
      await tick();
      const c64Tab = vscode.window.visibleTextEditors.find((e) => e.document.uri?.toString?.().includes('/c64/'));
      assert.ok(c64Tab, 'the c64 tab was also opened, alongside vic20 rather than replacing it');

      // From the c64 tab's own "Open For Another Machine" button, switch
      // to vic20 — reusing the same picker, sourced from the tab's own
      // stored build context rather than a source editor.
      vscode.window.activeTextEditor = c64Tab;
      vscode.__mock.queues.showQuickPick.push({ target: 'vic20' });
      await vscode.__mock.trigger('8bitscript.assemblyView.openForMachine');
      await tick();
      const revealedVic20 = vscode.window.visibleTextEditors.find((e) => e.document.uri?.toString?.().includes('/vic20/'));
      assert.ok(revealedVic20, 'openForMachine opened/revealed the vic20 tab from the c64 one');
    });
  } finally {
    vscode.window.activeTextEditor = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
