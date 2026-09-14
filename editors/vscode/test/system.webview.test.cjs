// media/system.js is the System builder page; it calls hardware.js's
// fillSelect/renderHardware/renderFacts directly, exactly as the real
// page does with both scripts sharing one document.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runWebviewScripts } = require('./support/runWebview.cjs');

const HARDWARE_JS = path.join(__dirname, '..', 'media', 'hardware.js');
const SYSTEM_JS = path.join(__dirname, '..', 'media', 'system.js');
const plain = (value) => JSON.parse(JSON.stringify(value));
const TABS = ['machine', 'hardware', 'region', 'facts', 'save'];

function load() {
  return runWebviewScripts([HARDWARE_JS, SYSTEM_JS], (dom) => {
    const tabs = dom.document.createElement('nav');
    tabs.id = 'tabs';
    for (const tab of TABS) {
      const button = dom.document.createElement('button');
      button.dataset.tab = tab;
      tabs.appendChild(button);
    }
    dom.seed('tabs', tabs);
  });
}

function baseState(overrides = {}) {
  return {
    type: 'state',
    tab: 'machine',
    project: 'my-game',
    draft: { name: '', target: 'c64', region: 'ntsc', layer: 'project' },
    machines: [{ id: 'c64', label: 'c64 — Commodore 64', runnable: true, region: true }],
    machine: true,
    fitted: 'stock machine',
    hardware: null,
    collision: { layer: 'project' },
    layers: [{ id: 'project', label: 'This clone only', where: '.8bitscript/systems.json' }],
    ...overrides,
  };
}

test('a project state shows the tab, the lede, and the region controls', () => {
  const { dom, sandbox } = load();
  sandbox.window.dispatch('message', { data: baseState({ tab: 'hardware' }) });
  const tabsEl = dom.getElementById('tabs');
  const active = tabsEl.children.find((b) => b.classList.contains('active'));
  assert.equal(active.dataset.tab, 'hardware');
  assert.equal(dom.getElementById('lede').textContent, 'my-game · c64 · stock machine');
  assert.equal(dom.getElementById('region').value, 'ntsc');
  assert.equal(dom.getElementById('region').disabled, false);
  assert.equal(dom.getElementById('region-note').textContent, '');
});

test('no project yet: the lede says so, and a machine with no region explains why', () => {
  const { dom, sandbox } = load();
  sandbox.window.dispatch('message', { data: baseState({
    project: '',
    machine: false,
    draft: { name: '', target: 'pet', region: 'ntsc', layer: 'project' },
  }) });
  assert.equal(dom.getElementById('lede').textContent, 'No project here yet.');
  assert.equal(dom.getElementById('region').disabled, true);
  assert.match(dom.getElementById('region-note').textContent, /The PET has no region/);
});

test('a non-PET machine with no region gets the generic note', () => {
  const { dom, sandbox } = load();
  sandbox.window.dispatch('message', { data: baseState({
    machine: false,
    draft: { name: '', target: 'nes', region: 'ntsc', layer: 'project' },
  }) });
  assert.match(dom.getElementById('region-note').textContent, /no NTSC\/PAL choice/);
});

test('save-note reflects a collision with an existing name', () => {
  const { dom, sandbox } = load();
  sandbox.window.dispatch('message', { data: baseState({ collision: { reason: 'more-specific' } }) });
  assert.match(dom.getElementById('save-note').textContent, /a save lands there/);
  sandbox.window.dispatch('message', { data: baseState({ collision: { reason: 'shadowed' } }) });
  assert.match(dom.getElementById('save-note').textContent, /would still win over an advertised one/);
  sandbox.window.dispatch('message', { data: baseState({ collision: {} }) });
  assert.equal(dom.getElementById('save-note').textContent, '');
});

test('clicking a tab, changing a field, and Save each post the right message', () => {
  const { dom, sandbox, posted } = load();
  sandbox.window.dispatch('message', { data: baseState() });
  posted.length = 0;

  dom.getElementById('tabs').children[1].dispatch('click');
  const target = dom.getElementById('target');
  target.value = 'vic20';
  target.dispatch('change');
  const region = dom.getElementById('region');
  region.value = 'pal';
  region.dispatch('change');
  const profile = dom.getElementById('profile');
  profile.value = '8k';
  profile.dispatch('change');
  const name = dom.getElementById('name');
  name.value = 'My VIC';
  name.dispatch('change');
  const layer = dom.getElementById('layer');
  layer.value = 'user';
  layer.dispatch('change');
  dom.getElementById('save').dispatch('click');
  dom.getElementById('open-config').dispatch('click');

  assert.deepEqual(posted.map(plain), [
    { type: 'set', key: 'tab', value: 'hardware' },
    { type: 'set', key: 'target', value: 'vic20' },
    { type: 'set', key: 'region', value: 'pal' },
    { type: 'set', key: 'profile', value: '8k' },
    { type: 'set', key: 'name', value: 'My VIC' },
    { type: 'set', key: 'layer', value: 'user' },
    { type: 'save' },
    { type: 'command', id: '8bitscript.openConfig' },
  ]);
});

test('the page asks for state once loaded', () => {
  const { posted } = load();
  assert.deepEqual(plain(posted[0]), { type: 'ready' });
});
