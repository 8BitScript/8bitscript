// What the launcher remembers per program lives in the editor's workspaceState,
// not settings.json. unitState.cjs takes the memento as an argument, so a Map
// is enough to test all of it.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { KEYS, UnitState } = require('../src/unitState.cjs');

function memento(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    update: async (key, value) => { store.set(key, value); },
  };
}

test('runtime and system are remembered per project and per program', async () => {
  const state = new UnitState(memento());
  assert.equal(state.runtime('/w', 'slot3x3'), null);
  await state.setRuntime('/w', 'slot3x3', 'native');
  await state.setRuntime('/w', 'slot5x5', 'browser');
  await state.setRuntime('/other', 'slot3x3', 'editor');
  assert.equal(state.runtime('/w', 'slot3x3'), 'native');
  assert.equal(state.runtime('/w', 'slot5x5'), 'browser');
  assert.equal(state.runtime('/other', 'slot3x3'), 'editor');
  await state.setSystem('/w', 'slot3x3', 'c64');
  assert.equal(state.system('/w', 'slot3x3'), 'c64');
  assert.equal(state.system('/w', 'slot5x5'), null);
});

test('a runtime that is not one of the three is not stored, and clears what was', async () => {
  const state = new UnitState(memento());
  await state.setRuntime('/w', 'p', 'editor');
  await state.setRuntime('/w', 'p', 'teleport');
  assert.equal(state.runtime('/w', 'p'), null);
  await state.setSystem('/w', 'p', 'c64');
  await state.setSystem('/w', 'p', '');
  assert.equal(state.system('/w', 'p'), null);
});

test('a project with one program and no name still has a slot', async () => {
  const state = new UnitState(memento());
  await state.setRuntime('/w', null, 'native');
  assert.equal(state.runtime('/w', undefined), 'native');
  assert.equal(state.runtime('/w', ''), 'native');
});

test('inputs hold changed values only, one at a time, and reset together', async () => {
  const state = new UnitState(memento());
  assert.deepEqual(state.inputs('/w', 'slot5x5'), {});
  await state.setInput('/w', 'slot5x5', 'SEED', 42);
  await state.setInput('/w', 'slot5x5', 'FORCE_BONUS', true);
  assert.deepEqual(state.inputs('/w', 'slot5x5'), { SEED: 42, FORCE_BONUS: true });
  await state.setInput('/w', 'slot5x5', 'SEED', undefined);
  assert.deepEqual(state.inputs('/w', 'slot5x5'), { FORCE_BONUS: true });
  await state.resetInputs('/w', 'slot5x5');
  assert.deepEqual(state.inputs('/w', 'slot5x5'), {});
  await state.setInput('/w', 'p', 'A', 1);
  assert.deepEqual(state.inputs('/w', 'other'), {}, 'another program is untouched');
});

test('the returned inputs are a copy: editing them does not edit the store', async () => {
  const state = new UnitState(memento());
  await state.setInput('/w', 'p', 'A', 1);
  const copy = state.inputs('/w', 'p');
  copy.A = 99;
  assert.deepEqual(state.inputs('/w', 'p'), { A: 1 });
});

test('clearing the last value of a project leaves no empty husk behind', async () => {
  const m = memento();
  const state = new UnitState(m);
  await state.setRuntime('/w', 'p', 'native');
  await state.setRuntime('/w', 'p', null);
  assert.deepEqual(m.store.get(KEYS.runtime), {});
});

test('ui flags are per project and merge', async () => {
  const state = new UnitState(memento());
  assert.deepEqual(state.ui('/w'), { collapsedGroups: [], open: [] });
  await state.setUi('/w', { collapsedGroups: ['Test rigs'] });
  await state.setUi('/w', { open: ['inputs'] });
  assert.deepEqual(state.ui('/w'), { collapsedGroups: ['Test rigs'], open: ['inputs'] });
  assert.deepEqual(state.ui('/other'), { collapsedGroups: [], open: [] });
});

test('damaged stored state reads as empty rather than throwing', () => {
  const state = new UnitState(memento({
    [KEYS.runtime]: 'nonsense',
    [KEYS.system]: ['x'],
    [KEYS.inputs]: { '/w': 'nope' },
    [KEYS.ui]: { '/w': { collapsedGroups: 'x', open: [1, 'ok'] } },
  }));
  assert.equal(state.runtime('/w', 'p'), null);
  assert.equal(state.system('/w', 'p'), null);
  assert.deepEqual(state.inputs('/w', 'p'), {});
  assert.deepEqual(state.ui('/w'), { collapsedGroups: [], open: ['ok'] });
});
