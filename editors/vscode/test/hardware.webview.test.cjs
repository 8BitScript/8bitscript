// media/hardware.js runs unmodified in every webview that shows the
// hardware/facts matrix (the launcher, and the System builder). These
// tests execute it for real against a stub DOM instead of only checking
// it parses, so a broken render actually fails a test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runWebviewScripts } = require('./support/runWebview.cjs');

const HARDWARE_JS = path.join(__dirname, '..', 'media', 'hardware.js');

// Objects built inside the vm sandbox belong to its own realm, so their
// prototype never strictly-equals this process's Object.prototype even
// when every enumerable property matches — round-tripping through JSON
// normalizes back to a plain object here before comparing.
const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  return runWebviewScripts([HARDWARE_JS]);
}

test('fillSelect: plain options, a group, and the "not a target" suffix', () => {
  const { dom, sandbox } = load();
  const select = dom.document.createElement('select');
  sandbox.fillSelect(select, [
    { id: 'c64', label: 'C64' },
    { group: 'Unusual' },
    { id: 'nes', label: 'NES', runnable: false },
  ], 'nes');
  assert.equal(select.children.length, 2, 'a plain option, then a group');
  assert.equal(select.children[0].value, 'c64');
  assert.equal(select.children[0].selected, false);
  const group = select.children[1];
  assert.equal(group.tagName, 'OPTGROUP');
  assert.equal(group.label, 'Unusual');
  const nes = group.children[0];
  assert.equal(nes.textContent, 'NES  (not a target)');
  assert.equal(nes.selected, true);
});

test('renderFacts: no facts at all', () => {
  const { dom, sandbox } = load();
  const root = dom.document.createElement('div');
  sandbox.renderFacts(root, []);
  assert.equal(root.children.length, 1);
  assert.match(root.children[0].textContent, /No toolchain found/);
});

test('renderFacts: groups by the key\'s first segment, flags, run-time facts', () => {
  const { dom, sandbox } = load();
  const root = dom.document.createElement('div');
  sandbox.renderFacts(root, [
    { key: 'memory.ram', doc: 'RAM size', when: 'build', type: 'number', value: 64 },
    { key: 'memory.hasExpansion', doc: 'expansion slot', when: 'run', type: 'flag', value: true },
    { key: 'video.pal', doc: 'PAL video', when: 'build', type: 'flag', value: false },
  ]);
  const table = root.children[0];
  assert.equal(table.className, 'facts');
  // One group row per distinct leading segment: memory, then video.
  const groupRows = table.children.filter((row) => row.className === 'group');
  assert.equal(groupRows.length, 2);
  assert.equal(groupRows[0].children[0].textContent, 'Memory');
  assert.equal(groupRows[1].children[0].textContent, 'Video');
  const dataRows = table.children.filter((row) => row.className !== 'group');
  assert.equal(dataRows.length, 3);
  const hasExpansionRow = dataRows[1];
  assert.match(hasExpansionRow.title, /run time: the build may use it/, 'run-time facts get the extra hint');
  assert.equal(hasExpansionRow.children[1].textContent, 'may use', 'a true run-time flag');
  const palRow = dataRows[2];
  assert.equal(palRow.children[1].textContent, 'no', 'a false build-time flag');
});

test('renderHardware: no toolchain to ask, so the profile select is disabled', () => {
  const { dom, sandbox } = load();
  const root = dom.document.createElement('div');
  const profileSelect = dom.document.createElement('select');
  sandbox.renderHardware(root, profileSelect, null, { postMessage() {} });
  assert.equal(profileSelect.disabled, true);
  assert.match(root.children[0].textContent, /No toolchain found/);
});

test('renderHardware: profiles, tagged options (build/probe), and posting a change', () => {
  const { dom, sandbox } = load();
  const root = dom.document.createElement('div');
  const profileSelect = dom.document.createElement('select');
  const posted = [];
  const vscode = { postMessage: (m) => posted.push(m) };
  const hardware = {
    profiles: [{ id: '8k', label: '8K expansion' }],
    selection: { profile: '8k', options: { port1: 'joystick' } },
    effective: { port1: 'joystick' },
    options: [
      {
        id: 'port1',
        label: 'Port 1',
        default: 'none',
        values: [
          { id: 'none', label: 'Nothing' },
          { id: 'joystick', label: 'Joystick', affectsBuild: true },
          { id: 'mouse1351', label: '1351 Mouse', detect: true },
        ],
      },
    ],
  };
  sandbox.renderHardware(root, profileSelect, hardware, vscode);
  assert.equal(profileSelect.disabled, false);
  assert.equal(profileSelect.children[0].value, '8k');
  const optionRow = root.children[0];
  assert.equal(optionRow.className, 'option set', 'a stored selection marks the row set');
  const label = optionRow.children[0];
  assert.match(label.children[0].textContent, /build.*probe|probe.*build/);
  const select = optionRow.children[1];
  select.value = 'mouse1351';
  select.dispatch('change');
  assert.deepEqual(plain(posted[0]), { type: 'set', key: 'option', option: 'port1', value: 'mouse1351' });
  const resetButton = root.children[root.children.length - 1];
  assert.equal(resetButton.textContent, 'Back to stock');
  resetButton.dispatch('click');
  assert.deepEqual(plain(posted[1]), { type: 'set', key: 'stock' });
});

test('renderHardware: no options at all says so', () => {
  const { dom, sandbox } = load();
  const root = dom.document.createElement('div');
  const profileSelect = dom.document.createElement('select');
  sandbox.renderHardware(root, profileSelect, {
    profiles: [],
    selection: { profile: null, options: {} },
    effective: {},
    options: [],
  }, { postMessage() {} });
  const none = root.children.find((child) => child.className === 'none');
  assert.ok(none, 'the "nothing to fit" notice is rendered');
});
