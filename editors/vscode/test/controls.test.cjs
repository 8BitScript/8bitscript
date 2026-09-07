// The webview for Run Settings is a real .js file, not a template
// literal, so `\n` in a string stays a two-character escape and the
// page actually parses. This is the regression for the blank System /
// Hardware / View dropdowns: the old inlined script died on the first
// newline inside a tooltip string.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS = path.join(__dirname, '..', 'media', 'controls.js');
const CSS = path.join(__dirname, '..', 'media', 'controls.css');

test('controls webview script is valid JavaScript', () => {
  const source = fs.readFileSync(JS, 'utf8');
  new vm.Script(source, { filename: 'controls.js' });
  assert.ok(source.includes("type: 'ready'"), 'the page asks for state once it can receive it');
});

test('controls stylesheet is present and names the panel layout', () => {
  const css = fs.readFileSync(CSS, 'utf8');
  assert.match(css, /details\.panel\b/);
  assert.match(css, /button\.action\b/);
  assert.match(css, /\.option\b/);
});

test('the panel drives the project and its Run and Build buttons', () => {
  const source = fs.readFileSync(JS, 'utf8');
  assert.match(source, /key: 'project'/, 'the project is a dropdown, not the tree');
  assert.match(source, /type: 'launch', action: 'run'/);
  assert.match(source, /type: 'launch', action: 'build'/);
  assert.doesNotMatch(source, /\$\('view'\)/, 'the view layout moved to the Projects title bar');
});
