const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'media', 'system.js'), 'utf8');
const HARDWARE = fs.readFileSync(path.join(ROOT, 'media', 'hardware.js'), 'utf8');
const VIEW = fs.readFileSync(path.join(ROOT, 'src', 'systemView.cjs'), 'utf8');

test('system builder scripts are valid JavaScript', () => {
  new vm.Script(HARDWARE, { filename: 'hardware.js' });
  new vm.Script(JS, { filename: 'system.js' });
});

test('every element the system page reaches for is on the page', () => {
  const ids = [...new Set([...JS.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.length > 0);
  for (const id of ids) assert.match(VIEW, new RegExp(`id="${id}"`), `no #${id}`);
});

test('the builder has the five tabs the plan names', () => {
  for (const tab of ['machine', 'hardware', 'region', 'facts', 'save']) {
    assert.match(VIEW, new RegExp(`data-tab="${tab}"`));
    assert.match(VIEW, new RegExp(`id="pane-${tab}"`));
  }
});

test('a save writes one of the three layers, not a private shape', () => {
  assert.match(VIEW, /upsertSystem/);
  assert.match(VIEW, /insertSystem/);
  assert.match(VIEW, /saveLayer/);
  assert.match(VIEW, /id: 'advertised'/);
  assert.match(VIEW, /id: 'project'/);
  assert.match(VIEW, /id: 'user'/);
});
