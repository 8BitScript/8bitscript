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
  assert.match(CSS, /button\.icon\b/, 'Open and details icons');
  assert.match(CSS, /\.packages\b/, 'package status sits above quick launch');
  assert.match(CSS, /\.pkg-row\b/);
  assert.match(CSS, /\.run-row\b/, 'the Running rows');
  assert.match(CSS, /\.run-machine\b/, 'a running machine is an expandable tree');
  assert.match(CSS, /\.lan-qr\b/, 'a web run’s LAN QR');
  assert.match(CSS, /--vscode-/, 'every color is the editor theme’s');
  assert.match(CSS, /\.dev-reload\b/, 'source-checkout rebuild prompt, then reload');
  assert.match(CSS, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('the side bar updates 8BitScript and workspace programs, not each example', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  // The view's title already says 8BitScript; the packages block has no
  // label of its own, and is hidden until a root needs installing.
  assert.doesNotMatch(view, /8BitScript<\/h2>/);
  assert.match(view, /<section class="packages" id="packages-block" hidden>/);
  assert.match(view, /\.filter\(\(status\) => !status\.installed\)/, 'only what needs doing is a row');
  assert.match(JS, /\$\('packages-block'\)\.hidden = rows\.length === 0/);
  assert.match(view, />Program</);
  assert.doesNotMatch(view, />Project</);
  assert.doesNotMatch(view, /Projects and packages/);
  assert.match(JS, /entry\.kind === 'toolchain'/);
  assert.match(JS, /Install' : 'Update'/);
  const kinds = fs.readFileSync(path.join(ROOT, 'src', 'projects.cjs'), 'utf8');
  assert.match(kinds, /label: 'Programs'/);
  assert.match(kinds, /label: 'Examples'/);
  const runner = fs.readFileSync(path.join(ROOT, 'src', 'runner.cjs'), 'utf8');
  assert.match(runner, /updateToolchain/);
  assert.match(runner, /managedUpdateCommand/);
  assert.doesNotMatch(runner, /setCheckout\(managedDir\)/, 'Install does not silently rewrite a consumer onto the clone');
  const extension = fs.readFileSync(path.join(ROOT, 'src', 'extension.cjs'), 'utf8');
  assert.match(extension, /managed: null/);
});

test('packages sit above quick launch, and the hardware matrix is not in the side bar', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  const body = view.slice(view.indexOf('id="packages-block"'));
  const order = ['id="packages-block"', 'for="project"', 'for="system"', 'id="fitted"', 'id="run"']
    .map((mark) => body.indexOf(mark));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((i) => i > -1));
  assert.doesNotMatch(view, /id="profile"/);
  assert.doesNotMatch(view, /id="options"/);
  assert.doesNotMatch(view, /details\.more/);
});

test('Open Studio is the largest button on the panel, above quick launch: a split button whose sliver opens a menu of Studio\'s systems', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  const runner = fs.readFileSync(path.join(ROOT, 'src', 'runner.cjs'), 'utf8');
  const body = view.slice(view.indexOf('id="packages-block"'));
  // Packages, then Studio, then the project's own quick launch.
  const order = ['id="packages-block"', 'id="studio"', 'for="project"', 'id="run"'].map((mark) => body.indexOf(mark));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((i) => i > -1));
  assert.match(body, /class="launch studio" id="studio"/, 'the same launch shape as Run, marked as Studio');
  assert.match(CSS, /\.split > button\.launch\.studio \{[^}]*padding: 8px 12px/, 'the same size as Run, in the secondary style so Run stays the one primary button');
  assert.match(CSS, /\.split > button\.launch\.studio-more \{[\s\S]*?background: var\(--vscode-button-secondaryBackground\)/, 'no color of its own');
  assert.match(body, /class="launch studio-more" id="studio-more"[^>]*aria-haspopup="menu"/, 'the sliver on its right edge');
  assert.match(CSS, /\.split > button\.launch\.studio-more \{[^}]*width: 24px/, 'is a sliver');
  assert.match(body, /<div class="menu" id="studio-menu" role="menu" hidden>/, 'and opens a menu');
  assert.match(JS, /id: option\.command \|\| '8bitscript\.openStudio', system: option\.id/, 'whose items launch Studio on that system — or, for the first entry, in the editor\'s own tab');
  assert.match(view, /\{ group: 'In an editor tab' \},\n\s+\{ id: 'tab', command: '8bitscript\.openStudioTab', label: 'Commander X16'/, 'the tab is the first entry, X16 only');
  assert.ok(MANIFEST.contributes.commands.some((c) => c.command === '8bitscript.openStudioTab'), 'and on the palette');
  assert.ok(MANIFEST.contributes.menus.commandPalette.some((m) => m.command === '8bitscript.studioTab.show' && m.when === 'false'), 'the show step is not');
  assert.equal(MANIFEST.contributes.configuration.properties['8bitscript.studioSystem'], undefined, 'nothing to remember: a pick is a launch');
  // The page names the command, the view allows it, and the command runs
  // Studio on cx16 — its baseline — with no picker and no change to the
  // panel's selection.
  assert.match(JS, /id: '8bitscript\.openStudio'/);
  assert.match(view, /'8bitscript\.openStudio', '8bitscript\.openStudioTab',\n\s+\]\.includes\(message\.id\)/);
  assert.match(runner, /command\('8bitscript\.openStudio'/);
  assert.match(runner, /p\.name === '@8bitscript\/studio'\);\n\s+if \(!studio\)/);
  assert.match(runner, /execute\('run', \{ project: studio, target: 'cx16' \}\)/);
  assert.match(runner, /execute\('run', \{ project: studio, target: 'cx16', web: true \}\)/, 'missing x16emu falls back to the tab, not another machine');
  assert.doesNotMatch(runner.slice(runner.indexOf("command('8bitscript.openStudio'"), runner.indexOf("command('8bitscript.launchApp'")), /showQuickPick|setProject|setSystem/);
  assert.ok(MANIFEST.contributes.commands.some((c) => c.command === '8bitscript.openStudio'), 'and it is on the palette');
});

test('Running machines is an expandable tree, not a one-line list', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  assert.match(view, /Running machines/);
  assert.match(view, /machineTree/);
  assert.match(JS, /function renderMachineTree/);
  assert.match(JS, /FPS /);
  assert.match(JS, /lan-qr/, 'a web run shows a QR of the LAN URL');
  assert.match(JS, /machine.qrSvg/);
});

test('examples can be hidden, but ship visible by default', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'src', 'runner.cjs'), 'utf8');
  assert.match(runner, /get visible\(\)/, 'what the picker offers');
  assert.match(runner, /getShowExamples\(\)/);
  assert.match(runner, /hasExamples\(\)/, 'and whether the toggle is worth offering');
  const props = MANIFEST.contributes.configuration.properties['8bitscript.showExamples'];
  assert.equal(props.default, true);
});

test('a native cx16 run from the launcher includes capture and fullscreen flags by default', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'src', 'runner.cjs'), 'utf8');
  assert.match(runner, /cx16NativeWindowCliArgs/);
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  assert.match(view, /system === 'cx16' \? settings\.cx16NativeWindowCliArgs\(\)/);
  const props = MANIFEST.contributes.configuration.properties;
  assert.equal(props['8bitscript.cx16.captureMouse'].default, true);
  assert.equal(props['8bitscript.cx16.fullscreen'].default, true);
});

test('a web run from the launcher listens on the LAN by default', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'src', 'runner.cjs'), 'utf8');
  assert.match(runner, /getWebLan\(\)/);
  assert.match(runner, /args\.push\('--port', '0'\)/, 'an ephemeral port so two web runs can coexist');
  assert.match(runner, /args\.push\('--local'\)/);
  const settings = fs.readFileSync(path.join(ROOT, 'src', 'settings.cjs'), 'utf8');
  assert.match(settings, /function getWebLan/);
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  assert.match(view, /--port', '0'/);
  assert.match(view, /--local/);
  const props = MANIFEST.contributes.configuration.properties['8bitscript.webLan'];
  assert.equal(props.default, true);
  assert.equal(props.type, 'boolean');
});

test('Install/Refresh runs an absolute package manager, not a bare `pnpm` the task shell cannot see', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'src', 'runner.cjs'), 'utf8');
  assert.match(runner, /resolvePackageManager\(manager\)/);
  assert.match(runner, /packageManagerPath\(\)/);
  assert.match(runner, /path\.isAbsolute\(bin\)/, 'refuse to spawn a name that would 127');
  assert.match(runner, /env: \{ PATH: pathEnv \}/);
  assert.match(runner, /Run 8BitScript: Doctor to install it/);
  assert.match(runner, /'Run Doctor'/);
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

test('every panel draws in the editor\'s own theme: no color of its own outside the QR code', () => {
  // Light, dark and high-contrast come from VS Code's --vscode-* variables;
  // a literal color would be right in one theme and wrong in the others.
  // The one exception is the LAN QR code, which a phone's camera has to
  // read: black on white whatever the theme.
  const media = path.join(ROOT, 'media');
  for (const file of fs.readdirSync(media).filter((name) => name.endsWith('.css'))) {
    const source = fs.readFileSync(path.join(media, file), 'utf8');
    const literal = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\bhsla?\(/g)].map((m) => m.index);
    const allowed = literal.filter((at) => source.slice(Math.max(0, at - 120), at).includes('.lan-qr'));
    assert.deepEqual(literal, allowed, `${file} names a color the theme does not`);
  }
  const qr = fs.readFileSync(path.join(ROOT, 'src', 'qr.cjs'), 'utf8');
  assert.match(qr, /fill="#fff"/, 'the QR is drawn black on white by design');
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

test('Reload this window is hidden until a local rebuild the user triggered has finished', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  const reload = fs.readFileSync(path.join(ROOT, 'src', 'devReload.cjs'), 'utf8');
  assert.match(view, /id="dev-reload" hidden/);
  assert.match(view, /id="rebuild-extension" hidden/);
  assert.match(view, /id="reload-window" hidden/);
  assert.match(JS, /type: 'rebuildExtension'/);
  assert.match(JS, /type: 'reloadWindow'/);
  assert.match(JS, /The local 8BitScript extension has changed/);
  assert.match(JS, /Rebuilding the local extension/);
  assert.match(JS, /The local 8BitScript extension was rebuilt successfully/);
  assert.match(JS, /phase !== 'ready'/);
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

test('an empty named system selects the machine id, not a blank the dropdown would turn into pet', () => {
  const { installVscodeMock } = require('./support/vscodeMock.cjs');
  installVscodeMock();
  const { selectedSystemId } = require('../src/launcherView.cjs');
  assert.equal(selectedSystemId(null, '', 'c64'), 'c64');
  assert.equal(selectedSystemId(undefined, '', 'vic20'), 'vic20');
  assert.equal(selectedSystemId({ name: 'PET 3032' }, 'PET 3032', 'pet'), 'PET 3032');
  assert.equal(selectedSystemId(null, 'Commodore 64', 'c64'), 'Commodore 64');
});

test('named systems are grouped by origin above the machines', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src', 'launcherView.cjs'), 'utf8');
  assert.match(view, /This clone/, 'project-personal first');
  assert.match(view, /This machine/, 'then user');
  assert.match(view, /Advertised/, 'then the config');
  assert.match(view, /groupedMachineOptions/, 'bare machines are grouped by family');
  assert.match(view, /applySystem/, 'picking one fits machine, hardware and region together');
  assert.match(view, /targets\?\.systems\?\.\[0\]/);
});

test('Doctor: Choose Emulators is a first-class panel, defaulting to all emulators', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'src', 'runner.cjs'), 'utf8');
  assert.match(runner, /getDoctorEmulators/);
  assert.match(runner, /doctorWantFromSelection/);
  const props = MANIFEST.contributes.configuration.properties['8bitscript.doctorEmulators'];
  assert.equal(props.default, null);
  const declared = MANIFEST.contributes.commands.map((c) => c.command);
  assert.ok(declared.includes('8bitscript.doctorSetup'));
  assert.ok(MANIFEST.contributes.menus['view/title'].some((m) => m.command === '8bitscript.doctorSetup'));
});

test('Configure System and Show Project are first-class commands', () => {
  const declared = MANIFEST.contributes.commands.map((c) => c.command);
  assert.ok(declared.includes('8bitscript.configureSystem'));
  assert.ok(declared.includes('8bitscript.showProject'));
  assert.ok(declared.includes('8bitscript.useLocal'));
  assert.ok(declared.includes('8bitscript.usePublished'));
  assert.ok(MANIFEST.contributes.menus['view/title'].some((m) => m.command === '8bitscript.configureSystem'));
  assert.ok(MANIFEST.contributes.menus['view/title'].some((m) => m.command === '8bitscript.showProject'));
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
  // The Studio tab's run is told apart from a native one by this key, so
  // it has to be part of the declared definition, not a private extra.
  assert.equal(definition.properties.web?.type, 'boolean');
  assert.match(definition.properties.web.description, /cx16 --web/);
});
