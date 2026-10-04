// A project with several `programs` — vegas-nights' lobby and its slot labs —
// has to be able to say which one Run and Build mean. These drive the real
// runner against the vscode mock: the tasks it builds, the tasks it offers,
// and what the palette's Run does with and without a choice made.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const { TaskProvider, makeTask, registerRunner } = require('../src/runner.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '8bs-programs-'));
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A project in the shape of vegas-nights: a lobby and two small labs. */
function writeLabConfig(dir, { withMain = true } = {}) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const entry of ['main', 'reels', 'tiny']) {
    fs.writeFileSync(path.join(dir, 'src', `${entry}.8bs`), 'export function main(): void {}\n');
  }
  fs.writeFileSync(path.join(dir, '8bitscript.config.8bs'), `export default {
  programs: {
    ${withMain ? "main: { entry: 'src/main.8bs' }," : "lobby: { entry: 'src/main.8bs' },"}
    reels: { entry: 'src/reels.8bs' },
    tiny: { entry: 'src/tiny.8bs', targets: ['pet', 'vic20'] },
  },
  targets: ['pet', 'vic20', 'c64'],
};
`);
}

/** A fake `8bs` that knows no named systems: enough for loadTargets() to answer. */
function writeFakeCli(dir) {
  const file = path.join(dir, 'fake-8bs.mjs');
  fs.writeFileSync(file, 'console.log(JSON.stringify({ targets: [], systems: [] }));\n');
  return file;
}

function labProject(dir) {
  return {
    kind: 'project',
    name: 'my-game',
    dir,
    configPath: path.join(dir, '8bitscript.config.8bs'),
    entry: path.join(dir, 'src', 'main.8bs'),
    targets: ['pet', 'vic20', 'c64'],
    toolchain: '/proj/node_modules/.bin/8bs',
    packageManager: 'pnpm',
    installed: true,
    programs: [
      { name: 'main', entry: path.join(dir, 'src/main.8bs'), targets: null },
      { name: 'reels', entry: path.join(dir, 'src/reels.8bs'), targets: null },
      { name: 'tiny', entry: path.join(dir, 'src/tiny.8bs'), targets: ['pet', 'vic20'] },
    ],
  };
}

/** registerRunner() starts a poll that only its disposables stop; always dispose. */
async function withRunner(storageDir, fn) {
  const context = { subscriptions: [], globalStorageUri: { fsPath: storageDir } };
  try {
    const projects = registerRunner(context, { appendLine() {} });
    await tick();
    await fn(projects);
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose?.();
  }
}

/** The palette's Run/Build against a lab project the mock workspace finds. */
async function inLabProject({ withMain = true, settings = {} }, fn) {
  const dir = tmpDir();
  try {
    writeLabConfig(dir, { withMain });
    const cli = writeFakeCli(dir);
    vscode.__mock.reset();
    vscode.__mock.configStore.set('project', dir);
    vscode.__mock.configStore.set('system', 'c64');
    for (const [key, value] of Object.entries(settings)) vscode.__mock.configStore.set(key, typeof value === 'function' ? value(dir) : value);
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.8bs') }]);
    await withRunner(path.join(dir, '.storage'), async (projects) => {
      projects.projects[0].toolchain = cli;
      await fn(dir);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const lastArgs = () => vscode.__mock.executedTasks.at(-1).task.execution.args.slice(1);

test('makeTask: a program shows in the task\'s name and definition, and reaches the CLI as --program', () => {
  const project = labProject('/proj');
  const none = { profile: null, options: {} };
  const task = makeTask(project, 'run', 'c64', 'ntsc', none, { program: 'reels' });
  assert.equal(task.name, 'my-game: run reels c64 (NTSC)');
  assert.deepEqual(task.execution.args, ['run', 'c64', '--program', 'reels', '--size']);
  assert.equal(task.definition.program, 'reels');
  const build = makeTask(project, 'build', 'pet', 'ntsc', none, { program: 'tiny' });
  assert.deepEqual(build.execution.args, ['build', '--target', 'pet', '--program', 'tiny', '--size']);
  const plain = makeTask(project, 'run', 'c64', 'ntsc', none);
  assert.equal(plain.definition.program, undefined, 'no program named: nothing added');
  assert.ok(!plain.execution.args.includes('--program'));
});

test('TaskProvider lists each program on the machines it is set up for', () => {
  const project = labProject('/proj');
  const tasks = new TaskProvider({ all: [project] }).provideTasks();
  const labels = tasks.map((t) => `${t.definition.command} ${t.definition.program} ${t.definition.target}`);
  assert.ok(labels.includes('run tiny pet') && labels.includes('build tiny vic20'));
  assert.ok(!labels.some((l) => l.includes('tiny c64')), 'tiny is not set up for the C64');
  assert.ok(labels.includes('run reels c64') && labels.includes('run main c64'));
  // A native run and a build on each of 3 + 3 + 2 program/machine pairs, and the
  // same program as a wasm page in the browser on the six whose machine has one
  // (the PET and VIC-20; the C64 has none yet).
  assert.equal(tasks.length, 2 * (3 + 3 + 2) + 6);
  const browser = tasks.filter((t) => t.definition.runtime === 'browser');
  assert.equal(browser.length, 6);
  assert.ok(browser.every((t) => t.definition.web === true && ['pet', 'vic20'].includes(t.definition.target)));
  assert.ok(!browser.some((t) => t.definition.target === 'c64'), 'no wasm page for the C64: no task for one');
  assert.equal(tasks.filter((t) => t.definition.command === 'run' && t.definition.runtime === 'native').length, 8, 'the native run stays, now saying so');
  const single = { ...project, programs: [project.programs[0]], targets: ['c64', 'pet'] };
  const plain = new TaskProvider({ all: [single] }).provideTasks();
  assert.equal(plain.length, 2 * 2 + 1, 'a native run and a build on each machine, and the PET\'s browser run');
  assert.ok(plain.every((t) => t.definition.program === undefined), 'a one-program project\'s tasks name none');
});

test('TaskProvider resolves a tasks.json entry to its named program, else the chosen one, else main', () => {
  const project = labProject('/proj');
  const provider = new TaskProvider({ all: [project] });
  const resolve = (definition) => provider.resolveTask({
    definition: { type: '8bs', command: 'run', target: 'c64', projectDir: '/proj', ...definition },
    scope: vscode.TaskScope.Workspace,
    name: 'x',
  }).execution.args;
  assert.deepEqual(resolve({ program: 'reels' }), ['run', 'c64', '--program', 'reels', '--size']);
  assert.deepEqual(resolve({}), ['run', 'c64', '--program', 'main', '--size'], 'unnamed: main, never a prompt');
});

test('Run in a project with several programs passes the one chosen for it', async () => {
  await inLabProject({ settings: { program: (dir) => ({ [dir]: 'reels' }) } }, async () => {
    await vscode.__mock.trigger('8bitscript.run');
    await tick();
    assert.ok(vscode.__mock.executedTasks.length > 0, 'a task was executed');
    assert.deepEqual(lastArgs().slice(0, 4), ['run', 'c64', '--program', 'reels']);
    assert.equal(vscode.__mock.queues.showQuickPick.length, 0, 'nothing was asked');
  });
});

test('Build with a main and nothing chosen means main — no prompt, nothing stored', async () => {
  await inLabProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.build');
    await tick();
    assert.deepEqual(lastArgs().slice(0, 5), ['build', '--target', 'c64', '--program', 'main']);
    assert.equal(vscode.__mock.configStore.get('program'), undefined);
  });
});

test('several programs and no main: asked once, the answer runs and is remembered', async () => {
  await inLabProject({ withMain: false }, async (dir) => {
    vscode.__mock.queues.showQuickPick.push({ program: 'reels' });
    await vscode.__mock.trigger('8bitscript.run');
    await tick();
    assert.deepEqual(lastArgs().slice(0, 4), ['run', 'c64', '--program', 'reels']);
    assert.deepEqual(vscode.__mock.configStore.get('program'), { [dir]: 'reels' });
    // The second run does not ask again (nothing is queued to answer it).
    await vscode.__mock.trigger('8bitscript.run');
    await tick();
    assert.equal(vscode.__mock.executedTasks.length, 2);
    assert.deepEqual(lastArgs().slice(0, 4), ['run', 'c64', '--program', 'reels']);
  });
});

test('dismissing the program prompt runs nothing', async () => {
  await inLabProject({ withMain: false }, async () => {
    await vscode.__mock.trigger('8bitscript.run');
    await tick();
    assert.equal(vscode.__mock.executedTasks.length, 0);
  });
});

test('a choice the config no longer has falls back to main instead of passing a name the CLI would refuse', async () => {
  await inLabProject({ settings: { program: (dir) => ({ [dir]: 'deleted-lab' }) } }, async () => {
    await vscode.__mock.trigger('8bitscript.run');
    await tick();
    assert.deepEqual(lastArgs().slice(0, 4), ['run', 'c64', '--program', 'main']);
  });
});

test('the machine prompt offers only the program\'s own machines', async () => {
  await inLabProject({ settings: { program: (dir) => ({ [dir]: 'tiny' }) } }, async () => {
    // The panel is on the C64, which `tiny` is not set up for.
    let offered = null;
    const original = vscode.window.showQuickPick;
    vscode.window.showQuickPick = (items) => {
      offered = items.map((i) => i.target);
      return Promise.resolve(items[0]);
    };
    try {
      await vscode.__mock.trigger('8bitscript.run');
      await tick();
    } finally {
      vscode.window.showQuickPick = original;
    }
    assert.deepEqual(offered, ['pet', 'vic20']);
    assert.deepEqual(lastArgs().slice(0, 4), ['run', 'pet', '--program', 'tiny']);
  });
});

test('a project with one program never gets --program', async () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'main.8bs'), 'export function main(): void {}\n');
    fs.writeFileSync(path.join(dir, '8bitscript.config.8bs'), "export default { entry: 'src/main.8bs', targets: ['c64'] };\n");
    const cli = writeFakeCli(dir);
    vscode.__mock.reset();
    vscode.__mock.configStore.set('project', dir);
    vscode.__mock.configStore.set('system', 'c64');
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.8bs') }]);
    await withRunner(path.join(dir, '.storage'), async (projects) => {
      projects.projects[0].toolchain = cli;
      await vscode.__mock.trigger('8bitscript.run');
      await tick();
      assert.deepEqual(lastArgs().slice(0, 2), ['run', 'c64']);
      assert.ok(!lastArgs().includes('--program'));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
