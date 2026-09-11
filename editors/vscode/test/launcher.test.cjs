// The launcher page is a real .js file, not a template literal, so `\n` in
// a string stays a two-character escape and the page actually parses. This
// is the regression for the blank System / Hardware dropdowns: the old
// inlined script died on the first newline inside a tooltip string.
//
// The rest of these hold the shape of the panel the side bar was reduced
// to — one launch button that says what it will do, the two choices it
// depends on, everything else folded away, and a Running section that can
// stop what the panel started.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'media', 'launcher.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'media', 'launcher.css'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('launcher webview script is valid JavaScript', () => {
  new vm.Script(JS, { filename: 'launcher.js' });
  assert.ok(JS.includes("type: 'ready'"), 'the page asks for state once it can receive it');
});

test('launcher stylesheet names the panel it lays out', () => {
  assert.match(CSS, /button\.launch\b/, 'the primary action');
  assert.match(CSS, /button\.icon\b/, 'Build and Open on the project row');
  assert.match(CSS, /details\.more\b/, 'the fold the rest lives in');
  assert.match(CSS, /\.run-row\b/, 'the Running rows');
  assert.match(CSS, /\.run-machine\b/, 'a running machine is an expandable tree');
  assert.match(CSS, /--vscode-/, 'every color is the editor theme’s');
  // The Install button and the Running section are laid out with a
  // `display`, which outranks the user agent's rule for [hidden].
  assert.match(CSS, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('the machine is under the button, and Build is on the project row', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  const body = view.slice(view.indexOf('<button class="launch"'));
  const order = ['id="run"', 'for="system"', 'for="project"', 'id="build"', 'id="open"']
    .map((mark) => body.indexOf(mark));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'run, system, project, then its icons');
  assert.ok(order.every((i) => i > -1));
  // Build is an icon on the project's row, not a second big button.
  assert.match(body, /<button class="icon" id="build"/);
  assert.doesNotMatch(body, /class="wide[^"]*" id="build"/);
});

test('Running machines is an expandable tree, not a one-line list', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  assert.match(view, /Running machines/);
  assert.match(view, /machineTree/);
  assert.match(JS, /function renderMachineTree/);
  assert.match(JS, /FPS /);
});

test('examples can be hidden, but ship visible by default', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'src', 'runner.cjs'), 'utf8');
  assert.match(runner, /get visible\(\)/, 'what the picker offers');
  assert.match(runner, /getShowExamples\(\)/);
  assert.match(runner, /hasExamples\(\)/, 'and whether the toggle is worth offering');
  const props = MANIFEST.contributes.configuration.properties['8bitscript.showExamples'];
  assert.equal(props.default, true);
});

test('the panel launches, picks, and stops', () => {
  assert.match(JS, /type: 'launch', action: 'run'/);
  assert.match(JS, /type: 'launch', action: 'build'/);
  assert.match(JS, /key: 'project'/, 'the project is a dropdown, not a tree');
  assert.match(JS, /type: 'stop', dir: entry\.dir/, 'a Running row can end its own task');
  assert.match(JS, /run-machine/, 'a run is an expandable machine, not a one-line row');
  assert.match(JS, /entry\.machine/, 'size, hardware, and live data ride on the row');
});

test('the primary button says what it will do', () => {
  assert.match(JS, /run-title.*'Run ' \+ data\.projectLabel/s);
  assert.match(JS, /run-sub/, 'and on what, fitted how');
});

test('the side bar is one view, and it says 8BitScript', () => {
  const views = MANIFEST.contributes.views['8bitscript'];
  assert.equal(views.length, 1, 'one launcher, no second pane');
  assert.equal(views[0].id, '8bitscript.launcher');
  assert.equal(views[0].name, '8BitScript');
  assert.equal(views[0].type, 'webview');
  assert.equal(MANIFEST.contributes.viewsContainers.activitybar[0].title, '8BitScript');
});

test('the title bar carries the view\u2019s actions, examples first and only where there are any', () => {
  const title = MANIFEST.contributes.menus['view/title'];
  const navigation = title.filter((item) => item.group?.startsWith('navigation')).map((item) => item.command);
  assert.deepEqual(navigation, [
    '8bitscript.toggleExamples',
    '8bitscript.launchStudio',
    '8bitscript.doctor',
    '8bitscript.refresh',
  ]);
  // The toggle is pointless where the toolchain brought no examples along.
  assert.equal(
    title.find((item) => item.command === '8bitscript.toggleExamples').when,
    'view == 8bitscript.launcher && 8bitscript.hasExamples',
  );
  for (const item of title) assert.match(item.when, /^view == 8bitscript\.launcher/);
});

test('every contributed menu names a command that exists', () => {
  const declared = new Set(MANIFEST.contributes.commands.map((c) => c.command));
  for (const items of Object.values(MANIFEST.contributes.menus)) {
    for (const item of items) assert.ok(declared.has(item.command), `${item.command} is not declared`);
  }
});

test('the tree view and the settings only it needed are gone', () => {
  const text = JSON.stringify(MANIFEST);
  for (const gone of ['8bitscript.projects', 'projectsView', 'viewMode']) {
    assert.ok(!text.includes(gone), `${gone} outlived the tree`);
  }
  assert.ok(!('viewsWelcome' in MANIFEST.contributes), 'the empty state is the panel’s own');
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'projectsView.cjs')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'media', 'controls.js')));
});

test('the project’s own systems are a group above the machines', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  assert.match(view, /group: 'This project'/, 'the config’s systems come first');
  assert.match(view, /group: 'Machines'/, 'the bare machines under them');
  assert.match(view, /applySystem/, 'picking one fits machine, hardware and region together');
  // Choosing a project loads what it is set up for.
  assert.match(view, /targets\?\.systems\?\.\[0\]/);
});

test('a system can be saved into the project’s config', () => {
  const declared = MANIFEST.contributes.commands.map((c) => c.command);
  assert.ok(declared.includes('8bitscript.saveSystem'));
  assert.ok(MANIFEST.contributes.menus['view/title'].some((m) => m.command === '8bitscript.saveSystem'));
});

test('every element the page script reaches for is on the page', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  const ids = [...new Set([...JS.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.length > 0, 'the page addresses elements by id');
  for (const id of ids) assert.match(view, new RegExp(`id="${id}"`), `no #${id} in the page`);
});

test('the 8bs task type offers every target this release builds for', () => {
  const { ALL_TARGETS } = require('../src/projects.cjs');
  const definition = MANIFEST.contributes.taskDefinitions.find((d) => d.type === '8bs');
  assert.deepEqual(definition.properties.target.enum, ALL_TARGETS);
});
