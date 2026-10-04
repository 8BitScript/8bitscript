// The extension's contributed surface and the behaviour around the side bar
// that is not the page itself: the one view, its title-bar actions, the
// settings, the task type, the commands that must exist, the runner's package
// manager and window flags. These lived in launcher.test.cjs beside tests of
// the old page; the page is tested over a real DOM in launcher.test.cjs now,
// and these are kept as they were so nothing they guard goes unguarded.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'media', 'launcher.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('launcher webview script is valid JavaScript', () => {
  new vm.Script(JS, { filename: 'launcher.js' });
  assert.ok(JS.includes("type: 'ready'"), 'the page asks for state once it can receive it');
});

test('the side bar updates 8BitScript and workspace programs, not each example', () => {
  const view = read('src', 'launcherView.cjs');
  // A root that needs installing is a notice; one that does not is no row at all.
  assert.match(view, /\.filter\(\(status\) => !status\.installed\)/, 'only what needs doing is a row');
  const kinds = read('src', 'projects.cjs');
  assert.match(kinds, /label: 'Programs'/);
  assert.match(kinds, /label: 'Examples'/);
  const runner = read('src', 'runner.cjs');
  assert.match(runner, /updateToolchain/);
  assert.match(runner, /managedUpdateCommand/);
  assert.doesNotMatch(runner, /setCheckout\(managedDir\)/, 'Install does not silently rewrite a consumer onto the clone');
  assert.match(read('src', 'extension.cjs'), /managed: null/);
});

test('examples can be hidden, but ship visible by default', () => {
  const runner = read('src', 'runner.cjs');
  assert.match(runner, /get visible\(\)/, 'what the picker offers');
  assert.match(runner, /getShowExamples\(\)/);
  assert.match(runner, /hasExamples\(\)/, 'and whether the toggle is worth offering');
  assert.equal(MANIFEST.contributes.configuration.properties['8bitscript.showExamples'].default, true);
});

test('a native cx16 run from the launcher includes capture and fullscreen flags by default', () => {
  assert.match(read('src', 'runner.cjs'), /cx16NativeWindowCliArgs/);
  assert.match(read('src', 'launcherView.cjs'), /machine === 'cx16' && runtime === 'native' \? settings\.cx16NativeWindowCliArgs\(/);
  const props = MANIFEST.contributes.configuration.properties;
  assert.equal(props['8bitscript.cx16.captureMouse'].default, true);
  assert.equal(props['8bitscript.cx16.fullscreen'].default, false);
});

test('a web run from the launcher listens on the LAN by default', () => {
  const runner = read('src', 'runner.cjs');
  assert.match(runner, /getWebLan\(\)/);
  assert.match(runner, /args\.push\('--port', '0'\)/, 'an ephemeral port so two web runs can coexist');
  assert.match(runner, /args\.push\('--local'\)/);
  assert.match(read('src', 'settings.cjs'), /function getWebLan/);
  const view = read('src', 'launcherView.cjs');
  assert.match(view, /--port', '0'/);
  assert.match(view, /--local/);
  const props = MANIFEST.contributes.configuration.properties['8bitscript.webLan'];
  assert.equal(props.default, true);
  assert.equal(props.type, 'boolean');
});

test('Install/Refresh runs an absolute package manager, not a bare `pnpm` the task shell cannot see', () => {
  const runner = read('src', 'runner.cjs');
  assert.match(runner, /resolvePackageManager\(manager\)/);
  assert.match(runner, /packageManagerPath\(\)/);
  assert.match(runner, /path\.isAbsolute\(bin\)/, 'refuse to spawn a name that would 127');
  assert.match(runner, /env: \{ PATH: pathEnv \}/);
  assert.match(runner, /Run 8BitScript: Doctor to install it/);
  assert.match(runner, /'Run Doctor'/);
});

test('every panel draws in the editor\'s own theme: no color of its own outside the QR code', () => {
  // Light, dark and high-contrast come from VS Code's --vscode-* variables;
  // a literal color would be right in one theme and wrong in the others.
  // The one exception is the network QR code, which a phone's camera has to
  // read: black on white whatever the theme.
  const media = path.join(ROOT, 'media');
  for (const file of fs.readdirSync(media).filter((name) => name.endsWith('.css'))) {
    const source = fs.readFileSync(path.join(media, file), 'utf8');
    const literal = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\bhsla?\(/g)].map((m) => m.index);
    const allowed = literal.filter((at) => /\.(?:lan-)?qr\b/.test(source.slice(Math.max(0, at - 120), at)));
    assert.deepEqual(literal, allowed, `${file} names a color the theme does not`);
  }
  assert.match(read('src', 'qr.cjs'), /fill="#fff"/, 'the QR is drawn black on white by design');
});

test('the side bar is one view, and it says 8BitScript', () => {
  const views = MANIFEST.contributes.views['8bitscript'];
  assert.equal(views.length, 1, 'one launcher, no second pane');
  assert.equal(views[0].id, '8bitscript.launcher');
  assert.equal(views[0].name, '8BitScript');
  assert.equal(views[0].type, 'webview');
  assert.equal(MANIFEST.contributes.viewsContainers.activitybar[0].title, '8BitScript');
});

test('the title bar carries the view’s actions, examples first and only where there are any', () => {
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

test('Reload this window is hidden until a local rebuild the user triggered has finished', () => {
  const reload = read('src', 'devReload.cjs');
  assert.match(reload, /createDevReloadState/);
  assert.doesNotMatch(reload, /createReloadQueue/);
  const rebuild = MANIFEST.contributes.commands.find((c) => c.command === '8bitscript.rebuildExtension');
  assert.ok(rebuild, 'the palette command exists');
  const rebuildPalette = MANIFEST.contributes.menus.commandPalette.find((m) => m.command === '8bitscript.rebuildExtension');
  assert.equal(rebuildPalette.when, '8bitscript.localRebuildNeeded');
  const command = MANIFEST.contributes.commands.find((c) => c.command === '8bitscript.reloadWindow');
  assert.ok(command, 'the palette command exists');
  const palette = MANIFEST.contributes.menus.commandPalette.find((m) => m.command === '8bitscript.reloadWindow');
  assert.equal(palette.when, '8bitscript.localReloadPending');
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

test('Doctor: Choose Emulators is a first-class panel, defaulting to all emulators', () => {
  const runner = read('src', 'runner.cjs');
  assert.match(runner, /getDoctorEmulators/);
  assert.match(runner, /doctorWantFromSelection/);
  assert.equal(MANIFEST.contributes.configuration.properties['8bitscript.doctorEmulators'].default, null);
  const declared = MANIFEST.contributes.commands.map((c) => c.command);
  assert.ok(declared.includes('8bitscript.doctorSetup'));
  assert.ok(MANIFEST.contributes.menus['view/title'].some((m) => m.command === '8bitscript.doctorSetup'));
});

test('Configure System and Show Project are first-class commands', () => {
  const declared = MANIFEST.contributes.commands.map((c) => c.command);
  for (const id of ['configureSystem', 'showProject', 'useLocal', 'usePublished']) assert.ok(declared.includes(`8bitscript.${id}`));
  assert.ok(MANIFEST.contributes.menus['view/title'].some((m) => m.command === '8bitscript.configureSystem'));
  assert.ok(MANIFEST.contributes.menus['view/title'].some((m) => m.command === '8bitscript.showProject'));
});

test('the 8bs task type offers every target this release builds for', () => {
  const { ALL_TARGETS } = require('../src/projects.cjs');
  const definition = MANIFEST.contributes.taskDefinitions.find((d) => d.type === '8bs');
  assert.deepEqual(definition.properties.target.enum, ALL_TARGETS);
  // The Studio tab's run is told apart from a native one by this key, so
  // it has to be part of the declared definition, not a private extra.
  assert.equal(definition.properties.web?.type, 'boolean');
  assert.match(definition.properties.web.description, /cx16 --web/);
});

test('every command the page can name is one the extension registers', () => {
  const view = read('src', 'launcherView.cjs');
  const table = view.slice(view.indexOf('const COMMANDS = {'), view.indexOf('};', view.indexOf('const COMMANDS = {')));
  const ids = [...new Set([
    ...table.matchAll(/'(8bitscript\.[A-Za-z.]+)'/g),
    ...view.matchAll(/executeCommand\(\s*'(8bitscript\.[A-Za-z.]+)'/g),
  ].map((m) => m[1]))];
  assert.ok(ids.length >= 8, 'the page names a real set of commands');
  const declared = new Set(MANIFEST.contributes.commands.map((c) => c.command));
  // runUnit is the unit model's command, not yet declared on every build; the
  // view asks the editor whether it exists before using it.
  const optional = new Set(['8bitscript.runUnit']);
  for (const id of ids) assert.ok(declared.has(id) || optional.has(id), `${id} is neither declared nor optional`);
});
