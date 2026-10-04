// The rules the launcher is built on, with no vscode and no page: which
// runtimes a program can use on a system, which one the primary button means,
// the command a click runs, and what a posted state is made safe to draw.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  RUNTIMES, RUNTIME_IDS, WEB_NO_NATIVE, availability, changedInputs, commandLine, defineFlags, normalizeState, primaryRuntime,
} = require('../src/launcherState.cjs');

const c64 = { id: 'c64', emulator: 'x64sc' };
const web = { id: 'web', emulator: null };

test('there are exactly three runtimes, always in the order Editor, Browser, Native', () => {
  assert.deepEqual(RUNTIME_IDS, ['editor', 'browser', 'native']);
  assert.deepEqual(RUNTIMES.map((r) => r.label), ['Editor', 'Browser', 'Native']);
  assert.ok(RUNTIMES.every((r) => r.what.length > 10 && r.long && r.icon));
  assert.throws(() => { RUNTIMES.push({}); }, TypeError, 'the table cannot be changed from outside');
});

test('on a machine with everything installed all three runtimes are available', () => {
  assert.deepEqual(availability({ system: c64 }), { editor: { ok: true }, browser: { ok: true }, native: { ok: true } });
});

test('a machine with no WASM build loses Editor and Browser together, for the same reason, and points at Native', () => {
  const av = availability({ system: c64, wasm: { ok: false, reason: 'No WASM build.' } });
  assert.deepEqual(av.editor, { ok: false, reason: 'No WASM build.', use: 'native' });
  assert.deepEqual(av.browser, av.editor);
  assert.equal(av.native.ok, true);
});

test('with no reason given, the loss of WASM still explains itself', () => {
  const av = availability({ system: c64, wasm: { ok: false } });
  assert.match(av.editor.reason, /no WASM build of c64/i);
});

test('the Web system has no native emulator, and says so', () => {
  const av = availability({ system: web });
  assert.deepEqual(av.native, { ok: false, reason: WEB_NO_NATIVE, use: 'editor' });
  assert.equal(av.editor.ok && av.browser.ok, true);
});

test('a missing emulator is fixable and names the emulator; an emulator that cannot boot is too', () => {
  const missing = availability({ system: c64, emulatorMissing: true }).native;
  assert.deepEqual(missing, { ok: false, fixable: true, emulator: 'x64sc', reason: "x64sc isn't installed, so Native can't run.", use: 'editor' });
  const broken = availability({ system: c64, nativeFails: true }).native;
  assert.equal(broken.fixable, true);
  assert.match(broken.reason, /x64sc is installed but cannot boot/);
});

test('both WASM and Native can be lost at once', () => {
  const av = availability({ system: c64, wasm: { ok: false, reason: 'x' }, emulatorMissing: true });
  assert.deepEqual(RUNTIME_IDS.map((id) => av[id].ok), [false, false, false]);
});

test('the default runtime is the Editor tab, then Native; Browser is never a default', () => {
  const all = availability({ system: c64 });
  assert.deepEqual(primaryRuntime(all, undefined), { runtime: 'editor' });
  assert.deepEqual(primaryRuntime(all, undefined, { preferEditor: false }), { runtime: 'native' });
  const onlyBrowser = { editor: { ok: false }, browser: { ok: true }, native: { ok: false } };
  assert.deepEqual(primaryRuntime(onlyBrowser, undefined), { runtime: 'browser' }, 'but it is better than nothing');
  assert.deepEqual(primaryRuntime({ editor: { ok: false }, browser: { ok: false }, native: { ok: false } }, undefined), { runtime: null });
});

test('the last runtime used wins while it still works', () => {
  const all = availability({ system: c64 });
  assert.deepEqual(primaryRuntime(all, 'native'), { runtime: 'native' });
  assert.deepEqual(primaryRuntime(all, 'browser'), { runtime: 'browser' }, 'a remembered Browser stays Browser');
});

test('a remembered runtime that stopped working moves the primary and says why', () => {
  const av = availability({ system: web });
  const got = primaryRuntime(av, 'native');
  assert.equal(got.runtime, 'editor');
  assert.equal(got.moved, 'Native is unavailable here, so Editor is the default.');
  assert.equal(primaryRuntime(av, 'bogus').moved, undefined, 'a runtime that never existed moves nothing');
});

test('changed inputs are the ones that differ from their default, and become --define flags', () => {
  const inputs = [{ name: 'SEED', def: 7, value: 10 }, { name: 'FORCE_BONUS', def: false, value: false }, { name: 'THEME', def: 'a', value: 'b' }];
  assert.deepEqual(changedInputs(inputs).map((i) => i.name), ['SEED', 'THEME']);
  assert.deepEqual(defineFlags(inputs), ['SEED=10', 'THEME=b']);
  assert.deepEqual(defineFlags(), []);
});

test('the command line is the exact argv: runtime flags before --size, defines after', () => {
  const base = ['run', 'c64', '--program', 'slot5x5', '--size'];
  assert.equal(commandLine(base, 'native'), '8bs run c64 --program slot5x5 --size');
  assert.equal(commandLine(base, 'editor'), '8bs run c64 --program slot5x5 --web --no-open --port 0 --size');
  assert.equal(commandLine(base, 'browser'), '8bs run c64 --program slot5x5 --web --size');
  assert.equal(commandLine(base, 'native', ['SEED=10', 'FORCE_BONUS=true']), '8bs run c64 --program slot5x5 --size --define SEED=10 --define FORCE_BONUS=true');
  assert.equal(commandLine(['run', 'pet'], 'browser'), '8bs run pet --web', 'without --size the flags simply follow');
  assert.deepEqual(base, ['run', 'c64', '--program', 'slot5x5', '--size'], 'the base argv is not mutated');
});

test('normalizeState makes a short or hostile message safe to draw', () => {
  const s = normalizeState({});
  assert.equal(s.phase, 'ready');
  assert.deepEqual([s.programs, s.systems, s.projects, s.notices, s.running, s.history], [[], [], [], [], [], []]);
  assert.equal(s.runtimes, RUNTIMES);
  assert.equal(s.program, null);
  assert.equal(normalizeState({ phase: 'weird' }).phase, 'ready');
  assert.equal(normalizeState({ phase: 'loading' }).phase, 'loading');
});

test('normalizeState gives every program a complete record and picks a real selected program', () => {
  const s = normalizeState({
    program: 'nope',
    programs: [{ id: 'a' }, { id: 'b', title: 'B', onSystem: false, primary: 'bogus', live: ['native', 'nonsense'], inputs: [{ name: 'N', kind: 'weird', def: 1 }, { name: 'M', kind: 'bool', def: false, value: true }], runtimes: { native: { ok: true } } }],
  });
  assert.equal(s.program, 'a', 'an unknown selection falls back to the first');
  const [a, b] = s.programs;
  assert.equal(a.title, 'a');
  assert.deepEqual(RUNTIME_IDS.map((id) => a.runtimes[id].ok), [false, false, false], 'nothing is available unless the host says so');
  assert.equal(b.onSystem, false);
  assert.equal(b.primary, null);
  assert.deepEqual(b.live, ['native']);
  assert.equal(b.runtimes.native.ok, true);
  assert.deepEqual(b.inputs.map((i) => [i.name, i.kind, i.value]), [['N', 'text', 1], ['M', 'bool', true]], 'an unknown kind is text, and an unset value is the default');
  assert.equal(normalizeState({ programs: [{ id: 'x' }], program: 'x' }).program, 'x');
});
