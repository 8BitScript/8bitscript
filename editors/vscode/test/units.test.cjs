// units.cjs is the launcher's model of a run: which programs a project has,
// which runtimes each (program, system) can use and why not, what the inputs
// are, and the flags a run is made of. It never touches `vscode`, so all of
// it is exercised here as plain data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  RUNTIMES, UnitLoader, coerceInput, defaultRuntime, formatCommand, inputArgs, legacyProject,
  legacyRuntime, normalizeProject, normalizeRuntime, programNamed, resolveUnit, runKey, runtimeArgs,
  runtimeMatrix,
} = require('../src/units.cjs');

const DIR = '/work/vegas-nights';

/** The shape `8bs project --json` prints (docs/project/units.md), trimmed. */
function projectJson(overrides = {}) {
  return {
    version: 1,
    hasConfig: true,
    configPath: `${DIR}/8bitscript.config.8bs`,
    configError: null,
    dir: DIR,
    name: 'vegas-nights',
    frameRate: 60,
    baseline: { target: 'c64' },
    targetsListed: true,
    targets: [
      { id: 'pet', hardware: { ram: '32k' }, profiles: [], locale: null },
      { id: 'c64', hardware: {}, profiles: [], locale: null },
      { id: 'web', hardware: {}, profiles: [], locale: null },
    ],
    locales: { default: 'en', fallback: 'en', available: ['en', 'de'] },
    locale: null,
    requires: {},
    systems: [{ name: 'Slot C64', layer: 'clone', target: 'c64', profile: null, hardware: {}, region: 'ntsc' }],
    problems: [{ scope: 'programs', message: 'sound-test: a thing' }],
    programs: [
      {
        name: 'main', entry: 'src/lobby/main.8bs', entryExists: true, title: null, description: null, group: null,
        targetsDeclared: null, targets: ['pet', 'c64', 'web'], requires: {}, definesRead: true, defines: [], problems: [],
      },
      {
        name: 'slot5x5', entry: 'src/labs/slot5x5/main.8bs', entryExists: true, title: 'Slot 5×5',
        description: 'Ways pay with a bonus.', group: 'Slots', targetsDeclared: ['c64', 'web'], targets: ['c64', 'web'],
        requires: {}, definesRead: true, definesReadOn: 'c64',
        defines: [
          { name: 'SEED', kind: 'int', default: 10, value: 10, description: 'The first spin', source: 'source' },
          { name: 'FORCE_BONUS', kind: 'bool', default: false, value: false, description: null, source: 'source' },
          { name: 'THEME', kind: 'string', default: 'classic', value: 'cosmic', description: null, source: 'source' },
          { name: 'OLD', kind: 'int', default: null, value: 3, description: null, source: 'config-only' },
        ],
        problems: [],
      },
    ],
    ...overrides,
  };
}

// ---- the project -----------------------------------------------------------

test('normalizeProject: programs carry label, resolved entry, targets and inputs', () => {
  const project = normalizeProject(projectJson());
  assert.equal(project.source, 'cli');
  assert.equal(project.legacy, false);
  assert.deepEqual(project.targets, ['pet', 'c64', 'web']);
  assert.equal(project.several, true);
  assert.equal(project.main, 'main');
  assert.equal(project.problems[0].scope, 'programs');
  const slot = programNamed(project, 'slot5x5');
  assert.equal(slot.label, 'Slot 5×5');
  assert.equal(slot.group, 'Slots');
  assert.equal(slot.entry, path.resolve(DIR, 'src/labs/slot5x5/main.8bs'));
  assert.deepEqual(slot.targets, ['c64', 'web']);
  const seed = slot.defines.find((d) => d.name === 'SEED');
  assert.deepEqual([seed.kind, seed.default, seed.value, seed.description], ['int', 10, 10, 'The first spin']);
  assert.equal(slot.defines.find((d) => d.name === 'THEME').value, 'cosmic', 'the config value rides along');
  assert.equal(slot.defines.find((d) => d.name === 'OLD').source, 'config-only');
  assert.equal(programNamed(project, 'main').label, 'main', 'an untitled program is shown by its name');
});

test('normalizeProject: a one-program project is not "several", and its only program is its main', () => {
  const only = projectJson({ programs: [projectJson().programs[1]] });
  const project = normalizeProject(only);
  assert.equal(project.several, false);
  assert.equal(project.main, 'slot5x5');
  assert.equal(resolveUnit(project, 'nope').name, 'slot5x5');
});

test('normalizeProject: several programs and no main cannot be guessed; a chosen one wins', () => {
  const noMain = projectJson({ programs: projectJson().programs.map((p) => ({ ...p, name: `${p.name}-x` })) });
  const project = normalizeProject(noMain);
  assert.equal(project.main, null);
  assert.equal(resolveUnit(project, undefined), null);
  assert.equal(resolveUnit(project, 'slot5x5-x').name, 'slot5x5-x');
});

test('normalizeProject: ignores malformed rows, defaults missing ones, and refuses a non-description', () => {
  const messy = projectJson({
    targets: [{ id: 'c64' }, 'junk', null],
    systems: [{ name: 'ok', target: 'c64' }, { target: 'nameless' }, 7],
    problems: [{ message: 'with scope', scope: 'systems' }, { message: 'no scope' }, 'junk'],
    locales: { default: 'en', available: 'nope' },
    programs: [{ name: 'a', entry: 'a.8bs', defines: [{ name: 'X' }, { kind: 'int' }, 'junk'], targets: null }, { entry: 'nameless.8bs' }, null],
  });
  const project = normalizeProject(messy);
  assert.deepEqual(project.targets, ['c64']);
  assert.deepEqual(project.systems.map((s) => s.name), ['ok']);
  assert.deepEqual(project.problems.map((p) => p.scope), ['systems', 'project']);
  assert.deepEqual(project.locales.available, []);
  assert.equal(project.programs.length, 1);
  const a = project.programs[0];
  assert.deepEqual(a.targets, ['c64'], 'no targets listed: the project\'s');
  assert.equal(a.defines.length, 1, 'a define needs a name');
  assert.deepEqual([a.defines[0].kind, a.defines[0].default, a.defines[0].value], ['int', null, null]);
  assert.throws(() => normalizeProject({ not: 'a project' }), /not an 8bs project description/);
  assert.throws(() => normalizeProject(null), /not an 8bs project description/);
  assert.throws(() => normalizeProject({ version: 1 }), /not an 8bs project description/);
});

test('normalizeProject: a config that will not load is carried, not thrown', () => {
  const project = normalizeProject(projectJson({ configError: 'unexpected token', programs: [] }));
  assert.equal(project.configError, 'unexpected token');
  assert.equal(project.programs.length, 0);
  assert.equal(project.main, null);
});

test('legacyProject: the regex reader\'s project, flagged, with no titles or inputs', () => {
  const found = {
    name: 'old', dir: '/w/old', configPath: '/w/old/8bitscript.config.8bs', entry: '/w/old/src/main.8bs',
    targets: ['pet', 'c64'],
    programs: [
      { name: 'main', entry: '/w/old/src/main.8bs', targets: null },
      { name: 'lab', entry: '/w/old/src/lab.8bs', targets: ['c64'] },
    ],
  };
  const project = legacyProject(found);
  assert.equal(project.legacy, true);
  assert.equal(project.source, 'legacy');
  assert.equal(project.several, true);
  assert.deepEqual(programNamed(project, 'lab').targets, ['c64']);
  assert.deepEqual(programNamed(project, 'main').targets, ['pet', 'c64']);
  assert.equal(programNamed(project, 'lab').definesRead, false, 'the inputs are unknown, not empty');
  assert.equal(programNamed(project, 'lab').entryRelative, path.join('src', 'lab.8bs'));
  const single = legacyProject({ ...found, programs: [] });
  assert.equal(single.several, false);
  assert.equal(single.programs[0].name, 'main');
  assert.equal(single.programs[0].entry, '/w/old/src/main.8bs');
});

// ---- runtimes ---------------------------------------------------------------

const C64 = {
  native: { available: true, emulator: 'x64sc', installed: true, reason: null },
  wasm: { available: false, reason: 'the C64 package pins arrays at fixed addresses' },
  wasmEmulator: { available: false, reason: 'no real emulator is vendored as WebAssembly for this machine' },
  boot: { available: true, reason: null },
};
const CX16 = {
  native: { available: true, emulator: 'x16emu', installed: true, reason: null },
  wasm: { available: true, reason: null },
  wasmEmulator: { available: true, reason: null },
  boot: { available: true, reason: null },
};
const WEB = {
  native: { available: false, emulator: null, installed: null, reason: 'the browser has no native emulator; it runs in the browser' },
  wasm: { available: true, reason: null },
  wasmEmulator: { available: false, reason: 'no real emulator is vendored as WebAssembly for this machine' },
  boot: { available: false, reason: 'the browser cannot boot bare' },
};

test('runtimeMatrix: a machine with a wasm port has all three; the C64 has only Native, with the CLI\'s reason', () => {
  const cx16 = runtimeMatrix({ runtime: normalizeRuntime(CX16), target: 'cx16' });
  assert.deepEqual([cx16.editor.available, cx16.browser.available, cx16.native.available, cx16.boot.available], [true, true, true, true]);
  assert.equal(cx16.wasmEmulator.available, true);
  const c64 = runtimeMatrix({ runtime: normalizeRuntime(C64), target: 'c64' });
  assert.deepEqual([c64.editor.available, c64.browser.available, c64.native.available], [false, false, true]);
  assert.match(c64.editor.reason, /pins arrays at fixed addresses/);
  assert.equal(c64.editor.fix, null, 'a missing wasm port is not something to fix from here');
});

test('runtimeMatrix: the web has no native emulator and cannot boot', () => {
  const web = runtimeMatrix({ runtime: normalizeRuntime(WEB), target: 'web' });
  assert.deepEqual([web.editor.available, web.browser.available, web.native.available, web.boot.available], [true, true, false, false]);
  assert.match(web.native.reason, /no native emulator/);
});

test('runtimeMatrix: an emulator that is not installed offers to install it, and so does Doctor', () => {
  const notInstalled = { ...C64, native: { ...C64.native, installed: false } };
  const cli = runtimeMatrix({ runtime: normalizeRuntime(notInstalled), target: 'c64' });
  assert.equal(cli.native.available, false);
  assert.equal(cli.native.reason, 'x64sc is not installed');
  assert.equal(cli.native.fix, 'install-emulator');
  assert.equal(cli.boot.available, false, 'a bare emulator needs the emulator too');
  assert.equal(cli.boot.fix, 'install-emulator');

  const doctor = runtimeMatrix({ runtime: normalizeRuntime(C64), target: 'c64', doctor: { notInstalled: ['c64'], failed: [] } });
  assert.equal(doctor.native.fix, 'install-emulator');

  const failed = runtimeMatrix({ runtime: normalizeRuntime(C64), target: 'c64', doctor: { notInstalled: [], failed: ['c64'] } });
  assert.equal(failed.native.fix, 'doctor');
  assert.match(failed.native.reason, /does not pass Doctor/);
});

test('runtimeMatrix: a machine this release does not build is unavailable everywhere, with the CLI\'s reason', () => {
  const nes = normalizeRuntime({
    native: { available: false, emulator: 'fceux', installed: true, reason: 'not built in this release' },
    wasm: { available: false, reason: 'not built in this release' },
    wasmEmulator: { available: false, reason: 'not built in this release' },
    boot: { available: false, reason: 'not built in this release' },
  });
  const matrix = runtimeMatrix({ runtime: nes, target: 'nes' });
  for (const id of ['editor', 'browser', 'native', 'boot']) {
    assert.equal(matrix[id].available, false);
    assert.equal(matrix[id].reason, 'not built in this release');
  }
});

test('runtimeMatrix: a program that does not target the system disables every cell and says so', () => {
  const project = normalizeProject(projectJson());
  const slot = programNamed(project, 'slot5x5');
  const matrix = runtimeMatrix({ runtime: normalizeRuntime(CX16), target: 'pet', program: slot });
  for (const id of ['editor', 'browser', 'native', 'boot']) {
    assert.equal(matrix[id].available, false);
    assert.equal(matrix[id].reason, 'Slot 5×5 does not target pet');
  }
  const ok = runtimeMatrix({ runtime: normalizeRuntime(CX16), target: 'c64', program: slot });
  assert.equal(ok.native.available, true);
});

test('legacy runtimes: an older CLI gets the built-in table, flagged, with the C64 not web-ready', () => {
  const pet = runtimeMatrix({ target: 'pet' });
  assert.equal(pet.legacy, true);
  assert.deepEqual([pet.editor.available, pet.native.available], [true, true]);
  assert.equal(runtimeMatrix({ target: 'c64' }).editor.available, false);
  assert.equal(runtimeMatrix({ target: 'cx16' }).wasmEmulator.available, true);
  const web = runtimeMatrix({ target: 'web' });
  assert.deepEqual([web.editor.available, web.native.available, web.boot.available], [true, false, false]);
  assert.equal(legacyRuntime('c64').native.emulator, 'x64sc');
  assert.equal(legacyRuntime('mystery').native.emulator, null);
  assert.equal(normalizeRuntime(undefined), null);
  assert.equal(normalizeRuntime('nope'), null);
});

test('normalizeRuntime fills the gaps in a partial row', () => {
  const partial = normalizeRuntime({ native: { available: true }, wasm: {} });
  assert.equal(partial.native.available, true);
  assert.equal(partial.native.installed, null);
  assert.equal(partial.wasm.available, false);
  assert.equal(partial.wasm.reason, 'no wasm build');
  assert.equal(partial.boot.available, false);
});

test('defaultRuntime: remembered wins while it works; no history means Editor; Browser is never the guess', () => {
  const all = runtimeMatrix({ runtime: normalizeRuntime(CX16), target: 'cx16' });
  assert.equal(defaultRuntime({ matrix: all }), 'editor');
  assert.equal(defaultRuntime({ matrix: all, preferEditor: false }), 'native');
  assert.equal(defaultRuntime({ matrix: all, remembered: 'browser' }), 'browser');
  assert.equal(defaultRuntime({ matrix: all, remembered: 'native', preferEditor: true }), 'native');
  const c64 = runtimeMatrix({ runtime: normalizeRuntime(C64), target: 'c64' });
  assert.equal(defaultRuntime({ matrix: c64 }), 'native', 'Editor is off, so the next that works');
  assert.equal(defaultRuntime({ matrix: c64, remembered: 'editor' }), 'native', 'a remembered runtime that stopped working is not kept');
  const web = runtimeMatrix({ runtime: normalizeRuntime(WEB), target: 'web' });
  assert.equal(defaultRuntime({ matrix: web, preferEditor: false }), 'editor');
  const none = runtimeMatrix({ target: 'c64', program: { label: 'x', targets: ['pet'] } });
  assert.equal(defaultRuntime({ matrix: none }), null);
  assert.equal(defaultRuntime({ matrix: all, remembered: 'bogus' }), 'editor');
  assert.deepEqual(RUNTIMES, ['editor', 'browser', 'native']);
});

// ---- inputs ----------------------------------------------------------------

test('coerceInput: by kind, and says what it wanted', () => {
  const int = { name: 'SEED', kind: 'int' };
  assert.deepEqual(coerceInput(int, '42'), { ok: true, value: 42 });
  assert.deepEqual(coerceInput(int, 7), { ok: true, value: 7 });
  assert.deepEqual(coerceInput(int, ' 0 '), { ok: true, value: 0 });
  for (const bad of ['-1', '1.5', 'abc', '', 1.5, -2, null, undefined, '9'.repeat(30)]) {
    const result = coerceInput(int, bad);
    assert.equal(result.ok, false, String(bad));
    assert.match(result.error, /SEED is a whole number/);
  }
  const flag = { name: 'FORCE_BONUS', kind: 'bool' };
  assert.deepEqual(coerceInput(flag, 'true'), { ok: true, value: true });
  assert.deepEqual(coerceInput(flag, false), { ok: true, value: false });
  assert.equal(coerceInput(flag, 'yes').ok, false);
  assert.equal(coerceInput(flag, 1).ok, false);
  const text = { name: 'THEME', kind: 'string' };
  assert.deepEqual(coerceInput(text, 'cosmic'), { ok: true, value: 'cosmic' });
  assert.deepEqual(coerceInput(text, 12), { ok: true, value: '12' });
  assert.equal(coerceInput(text, {}).ok, false);
});

test('inputArgs: --define only for what changed, typed, in the order given', () => {
  const slot = programNamed(normalizeProject(projectJson()), 'slot5x5');
  const { args, applied, errors } = inputArgs(slot, { SEED: '42', FORCE_BONUS: true, THEME: 'cosmic' });
  assert.deepEqual(args, ['--define', 'SEED=42', '--define', 'FORCE_BONUS=true'], 'THEME already is cosmic');
  assert.deepEqual(applied, { SEED: 42, FORCE_BONUS: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(inputArgs(slot, { SEED: 10 }).args, [], 'the same as now is nothing to pass');
  assert.deepEqual(inputArgs(slot, {}).args, []);
  assert.deepEqual(inputArgs(slot).args, []);
});

test('inputArgs: reports an unknown name or a bad value and leaves it out', () => {
  const slot = programNamed(normalizeProject(projectJson()), 'slot5x5');
  const { args, errors } = inputArgs(slot, { SEEDD: 1, SEED: 'x', FORCE_BONUS: 'true' });
  assert.deepEqual(args, ['--define', 'FORCE_BONUS=true']);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Slot 5×5 has no input SEEDD/);
  assert.match(errors[1], /SEED is a whole number/);
  const plain = inputArgs({ name: 'p', defines: [{ name: 'A', kind: 'string', value: 'a' }] }, { A: 'has space', B: 1 });
  assert.deepEqual(plain.args, ['--define', 'A=has space']);
  assert.match(plain.errors[0], /p has no input B/, 'a program with no label falls back to its name');
});

// ---- running ---------------------------------------------------------------

test('runtimeArgs: three runtimes, none needing another', () => {
  assert.deepEqual(runtimeArgs('native', 'c64'), []);
  assert.deepEqual(runtimeArgs('editor', 'pet'), ['--web', '--no-open', '--port', '0']);
  assert.deepEqual(runtimeArgs('browser', 'pet'), ['--web'], 'the browser run must not say --no-open');
  assert.deepEqual(runtimeArgs('editor', 'cx16', { x16emu: true }), ['--web', '--no-open', '--port', '0', '--x16emu']);
  assert.deepEqual(runtimeArgs('browser', 'cx16', { x16emu: true }), ['--web', '--x16emu']);
});

test('runtimeArgs: the web target is already a browser page', () => {
  assert.deepEqual(runtimeArgs('browser', 'web'), ['--port', '0']);
  assert.deepEqual(runtimeArgs('editor', 'web'), ['--no-open', '--port', '0']);
  assert.deepEqual(runtimeArgs('browser', 'web', { webLan: false }), ['--port', '0', '--local']);
  assert.deepEqual(runtimeArgs('editor', 'web', { webLan: false }), ['--no-open', '--port', '0', '--local']);
  assert.deepEqual(runtimeArgs('native', 'web'), [], 'native is native whatever the machine');
});

test('runKey: the same program on the same system in the same runtime is one run; another runtime is another', () => {
  const base = { dir: '/w', program: 'slot3x3', target: 'c64', runtime: 'editor' };
  assert.equal(runKey(base), runKey({ ...base }));
  assert.notEqual(runKey(base), runKey({ ...base, runtime: 'native' }));
  assert.notEqual(runKey(base), runKey({ ...base, program: 'slot5x5' }));
  assert.notEqual(runKey(base), runKey({ ...base, target: 'pet' }));
  assert.equal(runKey({ ...base, system: 'Named C64' }), runKey({ ...base, system: 'Named C64', target: 'pet' }), 'a named system is the system');
  assert.equal(runKey({ dir: '/w' }), '/w|||native');
});

test('formatCommand: what a person would type', () => {
  assert.equal(formatCommand(['run', 'c64', '--program', 'slot5x5']), '8bs run c64 --program slot5x5');
  assert.equal(formatCommand(['run', 'c64', '--define', 'THEME=has space']), "8bs run c64 --define 'THEME=has space'");
  assert.equal(formatCommand(['run', '--define', "N=it's"]), "8bs run --define 'N=it'\\''s'");
});

// ---- the loader ------------------------------------------------------------

function fakeProject(overrides = {}) {
  return {
    name: 'vegas-nights', dir: DIR, configPath: `${DIR}/8bitscript.config.8bs`, entry: `${DIR}/src/main.8bs`,
    targets: ['c64'], programs: [], toolchain: { kind: 'local' },
    ...overrides,
  };
}

test('UnitLoader: asks the CLI once per config change, and asks again when the config does', async () => {
  const calls = [];
  let mtime = 1;
  const loader = new UnitLoader({
    mtime: () => mtime,
    exec: async (project, args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify(projectJson()) };
    },
  });
  const first = await loader.load(fakeProject());
  assert.equal(first.source, 'cli');
  assert.deepEqual(calls[0], ['project', '--json']);
  await loader.load(fakeProject());
  assert.equal(calls.length, 1, 'cached');
  mtime = 2;
  await loader.load(fakeProject());
  assert.equal(calls.length, 2, 'the config changed');
  loader.invalidate(DIR);
  await loader.load(fakeProject());
  assert.equal(calls.length, 3, 'invalidated by a saved source file');
  loader.invalidate();
  await loader.load(fakeProject());
  assert.equal(calls.length, 4, 'invalidated wholesale by a refresh');
  await loader.load(fakeProject(), { defines: false });
  assert.deepEqual(calls[4], ['project', '--json', '--no-defines']);
});

test('UnitLoader: a CLI without `project --json` falls back to the regex reader, flagged and logged', async () => {
  const log = [];
  const loader = new UnitLoader({
    exec: async () => ({ code: 2, stdout: 'usage: 8bs <command>\n' }),
    log: (line) => log.push(line),
  });
  const found = fakeProject({ programs: [{ name: 'main', entry: `${DIR}/src/main.8bs`, targets: null }] });
  const project = await loader.load(found);
  assert.equal(project.legacy, true);
  assert.match(project.legacyReason, /exited 2/);
  assert.match(log[0], /reading the config without the CLI/);
  assert.equal(project.programs[0].name, 'main');
});

test('UnitLoader: exit 0 with unreadable output is also the fallback; exit 1 with a JSON body is a config error', async () => {
  const garbled = new UnitLoader({ exec: async () => ({ code: 0, stdout: '{not json' }) });
  const legacy = await garbled.load(fakeProject());
  assert.equal(legacy.legacy, true);

  const broken = new UnitLoader({
    exec: async () => ({ code: 1, stdout: JSON.stringify(projectJson({ configError: 'boom', programs: [] })) }),
  });
  const project = await broken.load(fakeProject());
  assert.equal(project.legacy, false);
  assert.equal(project.configError, 'boom');
});

test('UnitLoader: a project with no toolchain cannot ask, and says why', async () => {
  const loader = new UnitLoader({ exec: async () => { throw new Error('should not run'); } });
  const project = await loader.load(fakeProject({ toolchain: null }));
  assert.equal(project.legacy, true);
  assert.equal(project.legacyReason, 'no toolchain');
});

test('UnitLoader: a missing config file has mtime 0, not an error', async () => {
  const loader = new UnitLoader({ exec: async () => ({ code: 0, stdout: JSON.stringify(projectJson()) }) });
  const project = await loader.load(fakeProject({ configPath: '/definitely/not/here/8bitscript.config.8bs' }));
  assert.equal(project.source, 'cli');
});
