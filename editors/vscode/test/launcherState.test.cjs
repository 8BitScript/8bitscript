// How the launcher is told what the unit model decided, with no vscode and no
// page: the runtime table, the model's matrix as the page reads it, the note
// when a remembered runtime stops working, an input as a form field, and what
// a posted state is made safe to draw. (Which runtime works, and which is the
// default, are the model's rules and are tested in units.test.cjs.)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const units = require('../src/units.cjs');
const {
  RUNTIMES, RUNTIME_IDS, availabilityFromMatrix, inputRow, movedNote, normalizeState, sentence,
} = require('../src/launcherState.cjs');

const matrixFor = (target, extra = {}) => units.runtimeMatrix({ runtime: units.legacyRuntime(target), target, ...extra });

test('there are exactly three runtimes, always in the order Editor, Browser, Native, matching the model', () => {
  assert.deepEqual(RUNTIME_IDS, ['editor', 'browser', 'native']);
  assert.deepEqual(RUNTIME_IDS, units.RUNTIMES, 'the page and the model agree on the three and their order');
  assert.deepEqual(RUNTIMES.map((r) => r.label), ['Editor', 'Browser', 'Native']);
  assert.ok(RUNTIMES.every((r) => r.what.length > 10 && r.long && r.icon));
  assert.throws(() => { RUNTIMES.push({}); }, TypeError, 'the table cannot be changed from outside');
});

test('a reason becomes a sentence; one that starts with a program name keeps it', () => {
  assert.equal(sentence('no wasm build for c64 yet'), 'No wasm build for c64 yet.');
  assert.equal(sentence('Already a sentence.'), 'Already a sentence.');
  assert.equal(sentence('x64sc is not installed', { keep: 'x64sc' }), 'x64sc is not installed.');
  assert.equal(sentence('x64sc is not installed'), 'X64sc is not installed.', 'without the name to keep it is capitalised');
  assert.equal(sentence('  '), '');
  assert.equal(sentence(null), '');
});

test('everything working is three open cells with no reasons', () => {
  assert.deepEqual(availabilityFromMatrix(matrixFor('pet'), { emulator: 'xpet' }), { editor: { ok: true }, browser: { ok: true }, native: { ok: true } });
});

test('no WASM build closes Editor and Browser with the model\'s reason and points at Native', () => {
  const av = availabilityFromMatrix(matrixFor('c64'), { emulator: 'x64sc' });
  assert.deepEqual(av.editor, { ok: false, reason: 'No wasm build for c64 yet.', use: 'native' });
  assert.deepEqual(av.browser, av.editor);
  assert.deepEqual(av.native, { ok: true });
});

test('the Web has no native emulator and points at the Editor tab', () => {
  const av = availabilityFromMatrix(matrixFor('web'), { emulator: null });
  assert.equal(av.native.ok, false);
  assert.match(av.native.reason, /^The browser has no native emulator/);
  assert.equal(av.native.use, 'editor');
  assert.equal(av.native.fixable, undefined, 'nothing to install');
});

test('a missing emulator is fixable and names the emulator; an emulator that fails Doctor is fixable too', () => {
  const missing = availabilityFromMatrix(matrixFor('c64', { doctor: { notInstalled: ['c64'], failed: [] } }), { emulator: 'x64sc' });
  assert.deepEqual(missing.native, { ok: false, reason: 'x64sc is not installed.', fixable: true, emulator: 'x64sc' });
  const broken = availabilityFromMatrix(matrixFor('pet', { doctor: { notInstalled: [], failed: ['pet'] } }), { emulator: 'xpet' });
  assert.equal(broken.native.fixable, true);
  assert.match(broken.native.reason, /xpet is installed but does not pass Doctor/);
  assert.equal(broken.native.use, 'editor');
});

test('when nothing works there is nothing to switch to', () => {
  const av = availabilityFromMatrix(matrixFor('c64', { doctor: { notInstalled: ['c64'], failed: [] } }), { emulator: 'x64sc' });
  assert.deepEqual(RUNTIME_IDS.map((id) => av[id].ok), [false, false, false]);
  assert.ok(RUNTIME_IDS.every((id) => av[id].use === undefined));
});

test('a cell the model did not return is closed, not guessed open', () => {
  const av = availabilityFromMatrix({ editor: { available: true } });
  assert.deepEqual(av.editor, { ok: true });
  assert.equal(av.browser.ok, false);
  assert.equal(av.native.ok, false);
});

test('a remembered runtime that stopped working is said so once, and only then', () => {
  const av = availabilityFromMatrix(matrixFor('web'), { emulator: null });
  assert.equal(movedNote('native', 'editor', av), 'Native is unavailable here, so Editor is the default.');
  assert.equal(movedNote('editor', 'editor', av), '', 'it did not move');
  assert.equal(movedNote(null, 'editor', av), '', 'nothing was remembered');
  assert.equal(movedNote('browser', 'editor', av), '', 'a remembered runtime that still works needs no note');
  assert.equal(movedNote('bogus', 'editor', av), '', 'one that never existed moves nothing');
  assert.equal(movedNote('native', null, av), '');
});

test('an input is a form field: its kind, its plain-run value as the default, and what the person typed', () => {
  const seed = { name: 'SEED', kind: 'int', default: 7, value: 7, description: 'Fixes the draws.' };
  assert.deepEqual(inputRow(seed), { name: 'SEED', label: 'Seed', kind: 'number', def: 7, value: 7, help: 'Fixes the draws.', options: [] });
  assert.equal(inputRow(seed, { SEED: 10 }).value, 10);
  assert.equal(inputRow(seed, { SEED: 10 }).def, 7, 'changed means different from a plain run');
  assert.deepEqual(inputRow({ name: 'FORCE_BONUS', kind: 'bool', default: false, value: false, description: null }).kind, 'bool');
  assert.equal(inputRow({ name: 'THEME', kind: 'string', default: 'a', value: 'a', description: null }).kind, 'text');
  assert.equal(inputRow({ name: 'START_CREDITS', kind: 'int', default: 1000, value: 1000, description: null }).label, 'Start credits');
  const configured = { name: 'SEED', kind: 'int', default: 7, value: 99, description: null };
  assert.equal(inputRow(configured).def, 99, 'a value the config sets is what a plain run uses');
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
