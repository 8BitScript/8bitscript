// The run commands on top of the unit model: Editor, Browser and Native as
// three independent commands, the matrix that gates them, inputs, locale,
// simultaneous runs, stop-by-run, the entry/reveal commands, and the task
// provider's new definition fields. A fake `8bs` answers `project --json`,
// `targets --json` and `doctor --json`; the task system is a stub that
// records starts and terminations, so no emulator is ever launched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const { TaskProvider, registerRunner } = require('../src/runner.cjs');
const settings = require('../src/settings.cjs');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), '8bs-unitrun-'));

// ---- fixtures ---------------------------------------------------------------

const runtime = (over = {}) => ({
  native: { available: true, emulator: 'xemu', installed: true, reason: null },
  wasm: { available: true, reason: null },
  wasmEmulator: { available: false, reason: 'no real emulator is vendored as WebAssembly for this machine' },
  boot: { available: true, reason: null },
  ...over,
});

function targetsJson(over = {}) {
  const row = (id, region, rt) => ({
    id, title: id, emulator: 'xemu', region, options: {}, presets: {}, profiles: {}, hardware: {}, facts: {}, runtime: rt,
  });
  return {
    targets: [
      row('pet', false, runtime()),
      row('c64', true, runtime({ wasm: { available: false, reason: 'the C64 package pins arrays at fixed addresses' } })),
      row('cx16', false, runtime({ wasmEmulator: { available: true, reason: null } })),
      row('web', false, runtime({
        native: { available: false, emulator: null, installed: null, reason: 'the browser has no native emulator; it runs in the browser' },
        boot: { available: false, reason: 'the browser cannot boot bare' },
      })),
    ].map((r) => over[r.id] ?? r),
    systems: [{ name: 'Slot C64', target: 'c64', origin: 'project', label: 'stock', region: 'ntsc', profile: null, hardware: {} }],
    facts: [],
  };
}

function projectJson(dir) {
  const all = ['pet', 'c64', 'cx16', 'web'];
  const program = (name, targets, extra = {}) => ({
    name, entry: `src/${name}.8bs`, entryExists: true, title: null, description: null, group: null,
    targetsDeclared: null, targets, requires: {}, definesRead: true, defines: [], problems: [], ...extra,
  });
  return {
    version: 1, hasConfig: true, configPath: path.join(dir, '8bitscript.config.8bs'), configError: null,
    dir, name: 'vegas', frameRate: 60, baseline: null, targetsListed: true,
    targets: all.map((id) => ({ id, hardware: {}, profiles: [], locale: null })),
    locales: null, locale: null, requires: {}, systems: [], problems: [],
    programs: [
      program('main', all),
      program('slot5x5', ['pet', 'c64', 'web'], {
        title: 'Slot 5×5',
        defines: [
          { name: 'SEED', kind: 'int', default: 10, value: 10, description: null, source: 'source' },
          { name: 'FORCE_BONUS', kind: 'bool', default: false, value: false, description: null, source: 'source' },
          { name: 'THEME', kind: 'string', default: 'classic', value: 'classic', description: null, source: 'source' },
        ],
      }),
      program('tiny', ['pet']),
    ],
  };
}

function writeProject(dir, { cli = {} } = {}) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const name of ['main', 'slot5x5', 'tiny']) fs.writeFileSync(path.join(dir, 'src', `${name}.8bs`), 'export function main(): void {}\n');
  fs.writeFileSync(path.join(dir, '8bitscript.config.8bs'), `export default {
  programs: {
    main: { entry: 'src/main.8bs' },
    slot5x5: { entry: 'src/slot5x5.8bs', targets: ['pet', 'c64', 'web'] },
    tiny: { entry: 'src/tiny.8bs', targets: ['pet'] },
  },
  targets: ['pet', 'c64', 'cx16', 'web'],
};
`);
  const project = cli.project === null ? null : (cli.project ?? projectJson(dir));
  const targets = cli.targets ?? targetsJson();
  const doctor = cli.doctor ?? { ready: ['pet', 'c64', 'cx16'], notInstalled: [], failed: [] };
  const file = path.join(dir, 'fake-8bs.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, JSON.stringify(args) + '\\n');
const out = (value) => console.log(JSON.stringify(value));
if (args[0] === 'project') {
  ${project === null ? "process.stderr.write('usage: 8bs <command>\\\\n'); process.exit(2);" : `out(${JSON.stringify(project)});`}
} else if (args[0] === 'targets') out(${JSON.stringify(targets)});
else if (args[0] === 'doctor') out(${JSON.stringify(doctor)});
`);
  return file;
}

const callsTo = (dir, command) => {
  const log = path.join(dir, 'calls.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((args) => args[0] === command);
};

function memento() {
  const store = new Map();
  return { store, get: (key, fallback) => (store.has(key) ? store.get(key) : fallback), update: async (key, value) => { store.set(key, value); } };
}

/** Starts and terminations are recorded and announced the way the real task system would. */
function liveTasks() {
  vscode.tasks.executeTask = (task) => {
    const execution = {
      task,
      terminated: false,
      terminate() {
        this.terminated = true;
        vscode.tasks.taskExecutions = vscode.tasks.taskExecutions.filter((e) => e !== this);
        vscode.__mock.taskEmitters.onDidEndTask.fire({ execution: this });
      },
    };
    vscode.__mock.executedTasks.push(execution);
    vscode.tasks.taskExecutions.push(execution);
    vscode.__mock.taskEmitters.onDidStartTask.fire({ execution });
    return Promise.resolve(execution);
  };
}

async function inProject(options, fn) {
  const dir = tmpDir();
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: path.join(dir, '.storage') },
    workspaceState: memento(),
    globalState: memento(),
  };
  try {
    const cli = writeProject(dir, options);
    vscode.__mock.reset();
    liveTasks();
    for (const [key, value] of Object.entries(options.settings ?? {})) vscode.__mock.configStore.set(key, typeof value === 'function' ? value(dir) : value);
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.8bs') }]);
    const projects = registerRunner(context, { appendLine(line) { (options.log ?? []).push(line); } });
    await tick();
    await tick();
    projects.projects[0].toolchain = cli;
    projects.projects[0].installed = true;
    await fn({ dir, projects, context, project: projects.projects[0] });
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The fake CLI is a script, so the task's args begin with it; the rest is the command.
const argsOf = (execution) => execution.task.execution.args.slice(1);
const started = () => vscode.__mock.executedTasks;
const last = () => started().at(-1);
const shown = () => vscode.__mock.executedCommands.filter((c) => c.id === '8bitscript.previewTab.show');

// ---- the three runtimes -----------------------------------------------------

test('Editor: the wasm page on loopback, framed by the Preview tab', async () => {
  await inProject({}, async ({ dir }) => {
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'slot5x5', system: 'pet' });
    await tick();
    const args = argsOf(last());
    assert.deepEqual(args.slice(0, 4), ['run', 'pet', '--program', 'slot5x5']);
    for (const flag of ['--web', '--no-open', '--port', '0']) assert.ok(args.includes(flag), flag);
    assert.ok(!args.includes('--x16emu'));
    assert.equal(last().task.definition.runtime, 'editor');
    assert.equal(last().task.definition.web, true, 'the last-run report is the -web one');
    assert.equal(shown().length, 1, 'the tab followed the run');
    assert.equal(shown()[0].args[0].target, 'pet');
    assert.equal(shown()[0].args[0].dir, dir);
  });
});

test('Browser: the wasm page in the system browser — not --no-open, and no tab', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runBrowser', { program: 'slot5x5', system: 'pet' });
    await tick();
    const args = argsOf(last());
    assert.ok(args.includes('--web'));
    assert.ok(!args.includes('--no-open'), 'the CLI opens the browser itself');
    assert.equal(last().task.definition.runtime, 'browser');
    assert.equal(last().task.definition.web, true);
    assert.match(last().task.name, /in the browser$/);
    assert.equal(shown().length, 0);
  });
});

test('Native: the machine\'s own emulator — no --web at all', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'slot5x5', system: 'c64' });
    await tick();
    const args = argsOf(last());
    assert.deepEqual(args.slice(0, 4), ['run', 'c64', '--program', 'slot5x5']);
    assert.ok(!args.includes('--web') && !args.includes('--no-open'));
    assert.equal(last().task.definition.runtime, 'native');
    assert.equal(last().task.definition.web, undefined);
    assert.equal(shown().length, 0);
  });
});

test('the three do not depend on each other: Native runs with no Editor run ever started, and Browser the same', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.runBrowser', { program: 'main', system: 'cx16' });
    await tick();
    assert.equal(started().length, 2);
    assert.deepEqual(started().map((e) => e.task.definition.runtime), ['native', 'browser']);
    assert.equal(shown().length, 0, 'no Preview tab was needed or opened');
  });
});

test('cx16: x16emu swaps the lightweight page for the real emulator as wasm, only when asked and only there', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'main', system: 'cx16', x16emu: true });
    await vscode.__mock.trigger('8bitscript.runBrowser', { program: 'main', system: 'cx16', x16emu: true });
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'main', system: 'cx16' });
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'main', system: 'pet', x16emu: true });
    await tick();
    const [editorEmu, browserEmu, plain, pet] = started().map(argsOf);
    assert.ok(editorEmu.includes('--x16emu') && editorEmu.includes('--no-open'));
    assert.ok(browserEmu.includes('--x16emu') && !browserEmu.includes('--no-open'));
    assert.ok(!plain.includes('--x16emu'), 'the lightweight page is the default');
    assert.ok(!pet.includes('--x16emu'), 'no real emulator is vendored for the PET');
  });
});

test('a native cx16 run keeps its window flags; the wasm page of the same machine does not get them', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'cx16' });
    await vscode.__mock.trigger('8bitscript.runBrowser', { program: 'main', system: 'cx16' });
    await tick();
    assert.ok(argsOf(started()[0]).includes('--capture-mouse'));
    assert.ok(!argsOf(started()[1]).includes('--capture-mouse'));
  });
});

test('the web target is already a browser page: Browser runs it, Editor serves it without opening one, Native is refused', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runBrowser', { program: 'main', system: 'web' });
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'main', system: 'web' });
    await tick();
    const [browser, editor] = started().map(argsOf);
    assert.deepEqual(browser.slice(0, 2), ['run', 'web']);
    assert.ok(browser.includes('--port') && !browser.includes('--no-open') && !browser.includes('--web'));
    assert.ok(editor.includes('--no-open') && !editor.includes('--web'));
    assert.equal(started()[0].task.definition.web, undefined, 'the synthetic target keeps its one report file');
    const before = started().length;
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'web' });
    await tick();
    assert.equal(started().length, before, 'there is no native web emulator');
    assert.match(vscode.__mock.calls.showWarningMessage.at(-1)[0], /Native is not available.*no native emulator/);
  });
});

// ---- the matrix gates a run --------------------------------------------------

test('a runtime the CLI says does not work is not run, and the reason is shown', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'main', system: 'c64' });
    await vscode.__mock.trigger('8bitscript.runBrowser', { program: 'main', system: 'c64' });
    await tick();
    assert.equal(started().length, 0);
    const messages = vscode.__mock.calls.showWarningMessage.map((call) => call[0]);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /Editor is not available for main on c64: the C64 package pins arrays at fixed addresses/);
    assert.match(messages[1], /Browser is not available/);
  });
});

test('a program that does not target the system is refused with a plain sentence', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'tiny', system: 'c64' });
    await tick();
    assert.equal(started().length, 0);
    assert.equal(vscode.__mock.calls.showWarningMessage.at(-1)[0], 'tiny does not target c64.');
  });
});

test('an unforced run with nothing that can work says so once, in one sentence', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.run', { program: 'tiny', system: 'c64' });
    await tick();
    assert.equal(started().length, 0);
    assert.equal(vscode.__mock.calls.showWarningMessage.at(-1)[0], 'tiny does not target c64.');
  });
});

test('a runtime that is not one of the three is refused, with the machine\'s own reason', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runUnit', { program: 'main', system: 'web', runtime: 'teleport' });
    await tick();
    assert.equal(started().length, 0);
    assert.match(vscode.__mock.calls.showWarningMessage.at(-1)[0], /^main cannot run on web: the browser has no native emulator/);
  });
});

test('an emulator that is not installed offers to install it, and the answer opens that', async () => {
  const targets = targetsJson({
    c64: { ...targetsJson().targets[1], runtime: runtime({ wasm: { available: false, reason: 'no' }, native: { available: true, emulator: 'x64sc', installed: false, reason: null } }) },
  });
  await inProject({ cli: { targets } }, async () => {
    vscode.__mock.queues.showWarningMessage.push('Install emulator…');
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'c64' });
    await tick();
    assert.equal(started().length, 0);
    const [message, ...choices] = vscode.__mock.calls.showWarningMessage.at(-1);
    assert.match(message, /Native is not available for main on c64: x64sc is not installed/);
    assert.deepEqual(choices, ['Install emulator…', 'Run Doctor']);
    assert.ok(vscode.__mock.executedCommands.some((c) => c.id === '8bitscript.doctorSetup'));
  });
});

test('Doctor failing an emulator is a different fix: Run Doctor', async () => {
  await inProject({ cli: { doctor: { ready: [], notInstalled: [], failed: ['pet'] } } }, async () => {
    vscode.__mock.queues.showWarningMessage.push('Run Doctor');
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'pet' });
    await tick();
    assert.equal(started().filter((e) => e.task.definition.command === 'run').length, 0, 'the program did not run');
    assert.deepEqual(vscode.__mock.calls.showWarningMessage.at(-1).slice(1), ['Run Doctor']);
    assert.ok(vscode.__mock.executedCommands.some((c) => c.id === '8bitscript.doctor'), 'the answer opened Doctor');
    assert.ok(started().some((e) => e.task.definition.command === 'doctor'), 'and Doctor is what ran');
  });
});

// ---- which runtime a plain Run means ------------------------------------------

test('a first run is the Editor where the machine has a wasm page, Native where it does not — never a hidden rule', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.run', { program: 'main', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.run', { program: 'main', system: 'c64' });
    await tick();
    assert.deepEqual(started().map((e) => e.task.definition.runtime), ['editor', 'native']);
  });
});

test('the deprecated preferWebPreview only picks a first run\'s default, and the remembered runtime beats it', async () => {
  await inProject({ settings: { preferWebPreview: false } }, async ({ dir, projects }) => {
    await vscode.__mock.trigger('8bitscript.run', { program: 'main', system: 'pet' });
    await tick();
    assert.equal(last().task.definition.runtime, 'native', 'off means Native for a program with no history');
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'main', system: 'pet' });
    await tick();
    assert.equal(projects.unitState.runtime(dir, 'main'), 'editor', 'the choice is remembered');
    await vscode.__mock.trigger('8bitscript.run', { program: 'main', system: 'pet' });
    await tick();
    assert.equal(last().task.definition.runtime, 'editor', 'remembered wins over the setting');
  });
});

test('run remembers per program: another program has its own history', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runBrowser', { program: 'slot5x5', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.run', { program: 'slot5x5', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.run', { program: 'main', system: 'pet' });
    await tick();
    assert.deepEqual(started().map((e) => e.task.definition.runtime), ['browser', 'browser', 'editor']);
  });
});

test('a remembered runtime that stopped working is not used', async () => {
  await inProject({}, async ({ dir, projects }) => {
    await projects.unitState.setRuntime(dir, 'main', 'editor');
    await vscode.__mock.trigger('8bitscript.run', { program: 'main', system: 'c64' });
    await tick();
    assert.equal(last().task.definition.runtime, 'native', 'the C64 has no wasm page');
  });
});

test('the older web flag still means what it meant: true is the tab, false is native', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.run', { program: 'main', system: 'pet', web: true });
    await vscode.__mock.trigger('8bitscript.run', { program: 'main', system: 'pet', web: false });
    await tick();
    assert.deepEqual(started().map((e) => e.task.definition.runtime), ['editor', 'native']);
  });
});

// ---- simultaneous runs --------------------------------------------------------

test('Editor and Native of one program run side by side, each its own run', async () => {
  await inProject({}, async ({ projects }) => {
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'main', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'pet' });
    await tick();
    assert.equal(started().length, 2);
    assert.ok(started().every((e) => !e.terminated), 'neither replaced the other');
    const rows = projects.running.list();
    assert.deepEqual(rows.map((r) => r.runtime), ['editor', 'native']);
    assert.notEqual(rows[0].runId, rows[1].runId);
    assert.ok(rows.every((r) => r.program === 'main' && r.target === 'pet'));
    assert.match(rows[0].commandLine, /^8bs run pet --program main .*--web --no-open --port 0$/);
    assert.doesNotMatch(rows[1].commandLine, /--web/);
  });
});

test('stopping one run by its id leaves its siblings alone', async () => {
  await inProject({}, async ({ projects }) => {
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'main', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'slot5x5', system: 'pet' });
    await tick();
    const [editor, native] = projects.running.list();
    await vscode.__mock.trigger('8bitscript.stop', { runId: editor.runId });
    assert.deepEqual(started().map((e) => e.terminated), [true, false, false]);
    assert.equal(projects.running.stopRun('nope'), false);
    assert.equal(projects.running.stopRun(native.runId), true);
    assert.deepEqual(started().map((e) => e.terminated), [true, true, false]);
  });
});

test('starting the same run again replaces it; another runtime or program is not touched', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.runBrowser', { program: 'main', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'slot5x5', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'pet' });
    await tick();
    assert.deepEqual(started().map((e) => e.terminated), [true, false, false, false]);
  });
});

test('a new Editor run takes the one tab over from the previous Editor run of that machine only', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'main', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'main', system: 'cx16' });
    await vscode.__mock.trigger('8bitscript.runBrowser', { program: 'main', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'slot5x5', system: 'pet' });
    await tick();
    assert.deepEqual(started().map((e) => e.terminated), [true, false, false, false], 'the other machine and the browser run keep going');
    assert.equal(shown().length, 3);
  });
});

test('stop with a directory or with nothing keeps its older meaning', async () => {
  await inProject({}, async ({ dir }) => {
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'pet' });
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'cx16' });
    await tick();
    await vscode.__mock.trigger('8bitscript.stop', { dir, target: 'pet' });
    assert.deepEqual(started().map((e) => e.terminated), [true, false]);
    await vscode.__mock.trigger('8bitscript.stop');
    assert.deepEqual(started().map((e) => e.terminated), [true, true]);
  });
});

// ---- systems, locale, regions -------------------------------------------------

test('a system is a machine id or the name of a named system — the second supplies target and fitting', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'Slot C64' });
    await tick();
    const args = argsOf(last());
    assert.deepEqual(args.slice(0, 3), ['run', '--system', 'Slot C64']);
    assert.equal(last().task.definition.system, 'Slot C64');
    assert.equal(last().task.definition.target, 'c64');
    assert.ok(!args.includes('--hardware') && !args.includes('--profile'), 'a named system already carries its fitting');
  });
});

test('--locale is passed when a locale is given, and never otherwise', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'pet', locale: 'de' });
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'cx16' });
    await tick();
    const args = argsOf(started()[0]);
    assert.equal(args[args.indexOf('--locale') + 1], 'de');
    assert.ok(!argsOf(started()[1]).includes('--locale'));
    assert.equal(started()[0].task.definition.locale, 'de');
  });
});

test('--pal follows the CLI\'s region flag, not a list: the C64 takes it, the PET does not', async () => {
  await inProject({ settings: { region: 'pal' } }, async () => {
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'c64' });
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'pet' });
    await tick();
    assert.ok(argsOf(started()[0]).includes('--pal'));
    assert.ok(!argsOf(started()[1]).includes('--pal'));
    assert.equal(started()[0].task.definition.pal, true);
  });
});

// ---- inputs --------------------------------------------------------------------

test('inputs become --define for what differs from the program\'s own values, in the order given', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runNative', {
      program: 'slot5x5', system: 'pet', inputs: { SEED: '42', FORCE_BONUS: true, THEME: 'classic' },
    });
    await tick();
    const args = argsOf(last());
    const at = args.indexOf('--define');
    assert.deepEqual(args.slice(at, at + 4), ['--define', 'SEED=42', '--define', 'FORCE_BONUS=true']);
    assert.ok(!args.includes('THEME=classic'), 'THEME already is classic');
    assert.deepEqual(last().task.definition.define, { SEED: 42, FORCE_BONUS: true });
  });
});

test('inputs the launcher has remembered ride along on a run with none given, and reset clears them', async () => {
  await inProject({}, async ({ dir, projects }) => {
    await projects.unitState.setInput(dir, 'slot5x5', 'SEED', 7);
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'slot5x5', system: 'pet' });
    await tick();
    assert.ok(argsOf(last()).includes('SEED=7'));
    await projects.unitState.resetInputs(dir, 'slot5x5');
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'slot5x5', system: 'pet' });
    await tick();
    assert.ok(!argsOf(last()).includes('--define'));
  });
});

test('a build is handed the same inputs as a run', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.build', { program: 'slot5x5', target: 'pet', project: undefined, inputs: { SEED: 5 }, locale: 'de' });
    await tick();
    const args = argsOf(last());
    assert.equal(args[0], 'build');
    assert.ok(args.includes('SEED=5'));
    assert.equal(args[args.indexOf('--locale') + 1], 'de');
  });
});

test('a value that does not fit is said so and nothing runs', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'slot5x5', system: 'pet', inputs: { SEED: 'many', NOPE: 1 } });
    await tick();
    assert.equal(started().length, 0);
    const message = vscode.__mock.calls.showErrorMessage.at(-1)[0];
    assert.match(message, /^Not run:/);
    assert.match(message, /SEED is a whole number/);
    assert.match(message, /Slot 5×5 has no input NOPE/);
  });
});

test('a CLI that cannot take inputs says so rather than dropping them without a word', async () => {
  const log = [];
  await inProject({ cli: { project: null }, log }, async () => {
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'slot5x5', system: 'pet', inputs: { SEED: 5 } });
    await tick();
    assert.equal(started().length, 1, 'the run still happens');
    assert.ok(!argsOf(last()).includes('--define'));
    assert.match(vscode.__mock.calls.showWarningMessage.at(-1)[0], /too old to take inputs/);
    assert.ok(log.some((line) => /Inputs ignored for slot5x5/.test(line)));
  });
});

// ---- the legacy fallback -------------------------------------------------------

test('a CLI without `project --json` still runs: programs from the regex reader, runtimes from the built-in table', async () => {
  const log = [];
  const rows = targetsJson().targets.map((row) => { const { runtime: _gone, ...rest } = row; return rest; });
  await inProject({ cli: { project: null, targets: { targets: rows, systems: [], facts: [] } }, log }, async ({ projects, project }) => {
    const unit = await projects.unitProject(project);
    assert.equal(unit.legacy, true);
    assert.ok(log.some((line) => /reading the config without the CLI/.test(line)));
    const matrix = await projects.matrix(project, 'slot5x5', 'pet');
    assert.equal(matrix.legacy, true);
    assert.equal(matrix.editor.available, true);
    assert.equal((await projects.matrix(project, 'slot5x5', 'c64')).editor.available, false, 'the C64 has no wasm page, old CLI or new');
    await vscode.__mock.trigger('8bitscript.runEditor', { program: 'slot5x5', system: 'pet' });
    await tick();
    assert.equal(started().length, 1);
  });
});

// ---- bare emulator ---------------------------------------------------------------

test('open bare emulator boots the machine with nothing loaded — and the old boot id is the same thing', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.openBareEmulator', { system: 'pet' });
    await vscode.__mock.trigger('8bitscript.boot', { system: 'c64' });
    await tick();
    assert.deepEqual(argsOf(started()[0]).slice(0, 2), ['boot', 'pet']);
    assert.deepEqual(argsOf(started()[1]).slice(0, 2), ['boot', 'c64']);
    assert.ok(!argsOf(started()[0]).includes('--program'));
  });
});

test('a bare web emulator does not exist: the reason is shown instead of a CLI error', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.openBareEmulator', { system: 'web' });
    await tick();
    assert.equal(started().length, 0);
    assert.match(vscode.__mock.calls.showWarningMessage.at(-1)[0], /Cannot open a bare web emulator: the browser cannot boot bare/);
  });
});

test('a bare boot is not stopped by the program it is not a part of: no program has to target the machine', async () => {
  await inProject({}, async () => {
    await vscode.__mock.trigger('8bitscript.openBareEmulator', { system: 'cx16' });
    await tick();
    assert.equal(started().length, 1, 'main targets cx16, tiny does not — boot loads neither');
  });
});

// ---- entry and reveal --------------------------------------------------------------

function captureEditors() {
  const shownDocs = [];
  const original = vscode.window.showTextDocument;
  vscode.window.showTextDocument = (target, options) => { shownDocs.push({ target, options }); return original(target, options); };
  return { shownDocs, restore: () => { vscode.window.showTextDocument = original; } };
}

test('open entry opens the SELECTED program\'s entry, not main\'s', async () => {
  await inProject({}, async ({ dir }) => {
    const { shownDocs, restore } = captureEditors();
    try {
      await vscode.__mock.trigger('8bitscript.openEntry', { program: 'slot5x5' });
      assert.equal(shownDocs.at(-1).target.fsPath, path.join(dir, 'src', 'slot5x5.8bs'));
      await vscode.__mock.trigger('8bitscript.openEntry', {});
      assert.equal(shownDocs.at(-1).target.fsPath, path.join(dir, 'src', 'main.8bs'), 'nothing chosen is main');
      vscode.__mock.configStore.set('program', { [dir]: 'tiny' });
      await vscode.__mock.trigger('8bitscript.openEntry');
      assert.equal(shownDocs.at(-1).target.fsPath, path.join(dir, 'src', 'tiny.8bs'), 'the launcher\'s choice');
      await vscode.__mock.trigger('8bitscript.openEntry', { project: dir, program: 'nope' });
      assert.equal(shownDocs.at(-1).target.fsPath, path.join(dir, 'src', 'main.8bs'), 'an unknown program falls back to the project\'s entry');
    } finally { restore(); }
  });
});

test('reveal program puts the cursor on its key in the config', async () => {
  await inProject({}, async ({ dir }) => {
    const { shownDocs, restore } = captureEditors();
    const original = vscode.workspace.openTextDocument;
    vscode.workspace.openTextDocument = async (uri) => {
      const text = fs.readFileSync(uri.fsPath, 'utf8');
      return { uri, getText: () => text, positionAt: (offset) => ({ line: text.slice(0, offset).split('\n').length - 1, character: offset - (text.lastIndexOf('\n', offset - 1) + 1) }) };
    };
    try {
      await vscode.__mock.trigger('8bitscript.revealProgram', { program: 'tiny' });
      const selection = shownDocs.at(-1).options.selection;
      assert.deepEqual(selection.start, { line: 4, character: 4 });
      await vscode.__mock.trigger('8bitscript.revealProgram', { project: dir, program: 'ghost' });
      assert.deepEqual(shownDocs.at(-1).options.selection.start, { line: 0, character: 0 }, 'not found: the top of the file');
    } finally { restore(); vscode.workspace.openTextDocument = original; }
  });
});

// ---- tasks ---------------------------------------------------------------------------

function resolver(projects) {
  const provider = new TaskProvider(projects);
  return (definition) => provider.resolveTask({
    definition: { type: '8bs', command: 'run', target: 'pet', ...definition },
    scope: vscode.TaskScope.Workspace,
    name: 'x',
  });
}

test('resolveTask: runtime, define, locale, system, hardware and profile all reach the command', async () => {
  await inProject({}, async ({ dir, projects }) => {
    const resolve = resolver(projects);
    const withDir = (extra) => ({ projectDir: dir, ...extra });
    let args = resolve(withDir({ runtime: 'browser', program: 'slot5x5' })).execution.args.slice(1);
    assert.ok(args.includes('--web') && !args.includes('--no-open'));
    args = resolve(withDir({ runtime: 'editor' })).execution.args.slice(1);
    assert.ok(args.includes('--web') && args.includes('--no-open'));
    args = resolve(withDir({ runtime: 'native' })).execution.args.slice(1);
    assert.ok(!args.includes('--web'));
    args = resolve(withDir({ program: 'slot5x5', define: { SEED: 7, FORCE_BONUS: true, THEME: 'cosmic' }, locale: 'de' })).execution.args.slice(1);
    const at = args.indexOf('--define');
    assert.deepEqual(args.slice(at, at + 6), ['--define', 'SEED=7', '--define', 'FORCE_BONUS=true', '--define', 'THEME=cosmic']);
    assert.equal(args[args.indexOf('--locale') + 1], 'de');
    args = resolve(withDir({ system: 'Slot C64', target: 'c64' })).execution.args.slice(1);
    assert.deepEqual(args.slice(0, 3), ['run', '--system', 'Slot C64']);
    args = resolve(withDir({ profile: 'p1', hardware: { ram: '32k' } })).execution.args.slice(1);
    assert.equal(args[args.indexOf('--profile') + 1], 'p1');
    assert.equal(args[args.indexOf('--hardware') + 1], 'ram=32k');
  });
});

test('resolveTask: boot is a command a tasks.json entry can name', async () => {
  await inProject({}, async ({ dir, projects }) => {
    const args = resolver(projects)({ projectDir: dir, command: 'boot', target: 'c64' }).execution.args.slice(1);
    assert.deepEqual(args.slice(0, 2), ['boot', 'c64']);
    assert.ok(!args.includes('--program') && !args.includes('--web'));
  });
});

test('resolveTask: the older `web: true` now does what its description said — the browser — except on the web target', async () => {
  await inProject({}, async ({ dir, projects }) => {
    const resolve = resolver(projects);
    assert.ok(resolve({ projectDir: dir, web: true }).execution.args.slice(1).includes('--web'));
    assert.ok(!resolve({ projectDir: dir, web: true, target: 'web' }).execution.args.includes('--web'));
    assert.ok(!resolve({ projectDir: dir }).execution.args.includes('--web'), 'no flag, no change');
    assert.ok(!resolve({ projectDir: dir, command: 'build', web: true }).execution.args.includes('--web'), 'builds have no runtime');
  });
});

test('resolveTask: an old entry (command, target, program, pal) is exactly what it was', async () => {
  await inProject({}, async ({ dir, projects }) => {
    const task = resolver(projects)({ projectDir: dir, target: 'c64', program: 'main', pal: true });
    assert.deepEqual(task.execution.args.slice(1, 5), ['run', 'c64', '--program', 'main']);
    assert.ok(task.execution.args.slice(1).includes('--pal'));
    assert.deepEqual(task.definition, { type: '8bs', command: 'run', target: 'c64', projectDir: dir, program: 'main', pal: true }, 'the definition object is the one it was given');
  });
});

test('provideTasks asks the CLI which machines have a wasm page: the browser task follows the answer', async () => {
  const flipped = targetsJson({
    c64: { ...targetsJson().targets[1], runtime: runtime() },
    pet: { ...targetsJson().targets[0], runtime: runtime({ wasm: { available: false, reason: 'no' } }) },
  });
  await inProject({ cli: { targets: flipped } }, async ({ dir, projects, project }) => {
    await projects.loadTargets(dir);
    await tick();
    const browser = new TaskProvider(projects).provideTasks()
      .filter((t) => t.definition.runtime === 'browser' && t.definition.program === 'main')
      .map((t) => t.definition.target);
    assert.ok(browser.includes('c64') && !browser.includes('pet'), String(browser));
    assert.equal(projects.regional(dir, 'c64'), true);
    assert.equal(projects.regional(dir, 'pet'), false);
    assert.equal(projects.regional(dir, 'unknown'), undefined);
    assert.ok(project);
  });
});

// ---- the machine list ------------------------------------------------------------

test('machines: every machine the CLI lists, with its region flag, emulator and runtime cells', async () => {
  await inProject({}, async ({ projects, project }) => {
    const machines = await projects.machines(project);
    assert.deepEqual(machines.map((m) => m.id), ['pet', 'c64', 'cx16', 'web']);
    const byId = Object.fromEntries(machines.map((m) => [m.id, m]));
    assert.equal(byId.c64.regional, true);
    assert.equal(byId.pet.regional, false);
    assert.equal(byId.c64.emulator, 'xemu');
    assert.equal(byId.c64.runtime.wasm.available, false);
    assert.equal(byId.cx16.runtime.wasmEmulator.available, true);
    assert.equal(byId.web.runtime.native.available, false);
    assert.ok(machines.every((m) => m.inRelease));
  });
});

test('machines: without a CLI to ask, the five this release builds, from the built-in table', async () => {
  await inProject({}, async ({ projects, project }) => {
    projects.projects[0].toolchain = null;
    projects.targetsPromises.clear();
    const machines = await projects.machines(project);
    assert.deepEqual(machines.map((m) => m.id), ['pet', 'c64', 'vic20', 'cx16', 'web']);
    assert.equal(machines.find((m) => m.id === 'c64').regional, true);
    assert.equal(machines.find((m) => m.id === 'pet').regional, false);
    assert.equal(machines.find((m) => m.id === 'pet').runtime.legacy, true);
    assert.equal(machines.find((m) => m.id === 'web').runtime.native.available, false);
  });
});

test('machines: a row without a runtime object (an older CLI) gets the built-in cells', async () => {
  const rows = targetsJson().targets.map((row) => { const { runtime: _gone, inRelease: _also, ...rest } = row; return rest; });
  await inProject({ cli: { targets: { targets: rows, systems: [], facts: [] } } }, async ({ projects, project }) => {
    const machines = await projects.machines(project);
    assert.ok(machines.every((m) => m.runtime.legacy === true && m.inRelease === true));
  });
});

// ---- caching and state ---------------------------------------------------------------

test('the project is described once per config change; a saved source file asks again', async () => {
  await inProject({}, async ({ dir, projects, project }) => {
    await projects.unitProject(project);
    await projects.unitProject(project);
    assert.equal(callsTo(dir, 'project').length, 1);
    vscode.__mock.fireSave({ fileName: path.join(dir, 'src', 'main.8bs') });
    await projects.unitProject(project);
    assert.equal(callsTo(dir, 'project').length, 2, 'a source file may have changed an input');
    vscode.__mock.fireSave({ fileName: path.join(dir, 'README.md') });
    await projects.unitProject(project);
    assert.equal(callsTo(dir, 'project').length, 2, 'a file that is not source says nothing');
    vscode.__mock.fireSave({ fileName: path.join(os.tmpdir(), 'elsewhere', 'x.8bs') });
    await projects.unitProject(project);
    assert.equal(callsTo(dir, 'project').length, 2, 'nor does a file of no project');
    await projects.refresh();
    projects.projects[0].toolchain = project.toolchain;
    await projects.unitProject(projects.projects[0]);
    assert.equal(callsTo(dir, 'project').length, 3, 'a refresh forgets everything');
  });
});

test('what a run remembers is written to the workspace\'s state, never to settings', async () => {
  await inProject({}, async ({ dir, context }) => {
    await vscode.__mock.trigger('8bitscript.runBrowser', { program: 'slot5x5', system: 'pet' });
    await tick();
    const keys = [...context.workspaceState.store.keys()].sort();
    assert.deepEqual(keys, ['launcher.runtime', 'launcher.system']);
    assert.deepEqual(context.workspaceState.store.get('launcher.runtime'), { [dir]: { slot5x5: 'browser' } });
    assert.deepEqual(context.workspaceState.store.get('launcher.system'), { [dir]: { slot5x5: 'pet' } });
    assert.equal(vscode.__mock.configStore.has('launcher.runtime'), false);
  });
});

test('a host without workspace state just forgets: nothing throws', async () => {
  const dir = tmpDir();
  try {
    const cli = writeProject(dir);
    vscode.__mock.reset();
    liveTasks();
    vscode.workspace.findFiles = () => Promise.resolve([{ fsPath: path.join(dir, '8bitscript.config.8bs') }]);
    const context = { subscriptions: [], globalStorageUri: { fsPath: path.join(dir, '.storage') } };
    const projects = registerRunner(context, { appendLine() {} });
    await tick();
    await tick();
    projects.projects[0].toolchain = cli;
    projects.projects[0].installed = true;
    await vscode.__mock.trigger('8bitscript.runNative', { program: 'main', system: 'pet' });
    await tick();
    assert.equal(started().length, 1);
    assert.equal(projects.unitState.runtime(dir, 'main'), null);
    for (const subscription of context.subscriptions) subscription.dispose?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the commands that moved ---------------------------------------------------------

test('select project / select system still work, and say once that they moved', async () => {
  await inProject({}, async ({ context }) => {
    vscode.__mock.queues.showQuickPick.push(undefined, undefined);
    await vscode.__mock.trigger('8bitscript.selectSystem');
    await vscode.__mock.trigger('8bitscript.selectSystem');
    await vscode.__mock.trigger('8bitscript.selectProject');
    const notices = vscode.__mock.calls.showInformationMessage.map((call) => call[0]);
    assert.equal(notices.filter((n) => /system is chosen in the 8BitScript side bar/.test(n)).length, 1, 'once, not every time');
    assert.equal(notices.filter((n) => /project is chosen at the top/.test(n)).length, 1);
    assert.equal(context.globalState.get('notice.selectSystem'), true, 'and remembered across windows');
  });
});

test('settings.getSystem accepts any machine id the CLI lists, not a fixed five', () => {
  vscode.__mock.reset();
  vscode.__mock.configStore.set('system', 'mega65');
  assert.equal(settings.getSystem(), 'mega65');
  vscode.__mock.configStore.set('system', '');
  assert.equal(settings.getSystem(), 'pet', 'nothing chosen is the first');
  vscode.__mock.configStore.set('system', 7);
  assert.equal(settings.getSystem(), 'pet');
});
