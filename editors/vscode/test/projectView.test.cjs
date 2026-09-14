const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'media', 'project.js'), 'utf8');
const VIEW = fs.readFileSync(path.join(ROOT, 'src', 'projectView.cjs'), 'utf8');

test('project details script is valid JavaScript', () => {
  new vm.Script(JS, { filename: 'project.js' });
});

test('every element the project page reaches for is on the page', () => {
  const ids = [...new Set([...JS.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.length > 0);
  for (const id of ids) assert.match(VIEW, new RegExp(`id="${id}"`), `no #${id}`);
});

test('the page can install, refresh, and switch toolchain without rewriting package.json', () => {
  assert.match(JS, /8bitscript.install/);
  assert.match(JS, /8bitscript.useLocal/);
  assert.match(JS, /8bitscript.usePublished/);
  assert.doesNotMatch(VIEW, /package\.json/);
});
