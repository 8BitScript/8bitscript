// The Controller Setup panel's wiring: the page parses, every element it
// reaches for exists, the silhouette names only controls that exist, and
// the command is contributed.
//
// Same shape as launcher.test.cjs, and for the same reasons — the `\n`
// regression that once emptied every dropdown, and the `$('id')` sweep
// that catches a page whose script addresses something the HTML does not
// have. Neither needs the `vscode` API, so neither needs a window.
//
// ---- what a person still has to check by hand ----------------------------
//
// Three things cannot be tested here and are the whole of the manual pass:
//
// 1. **Whether this editor grants the webview gamepad access at all.**
//    Chromium gates `navigator.getGamepads()` behind a permissions policy
//    the extension cannot set on the editor's own iframe. The page detects
//    the refusal and says so (`trouble()` below is asserted to), but
//    whether the refusal happens is a property of the host window.
// 2. **That pressing A on a real pad lights the shape marked A.** Only a
//    pad can prove a driver reports what the standard layout claims.
// 3. **That the walkthrough feels right** — the "let go of everything"
//    step in particular, which exists because of how people actually hold
//    a controller and not because of anything a test can see.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { LOGICAL_CONTROLS } = require('../src/controllerProfile.cjs');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'media', 'controller.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'media', 'controller.css'), 'utf8');
const VIEW = fs.readFileSync(path.join(ROOT, 'src', 'controllerView.cjs'), 'utf8');
const PROFILE = fs.readFileSync(path.join(ROOT, 'src', 'controllerProfile.cjs'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { PAD_SVG } = require('../src/controllerPad.cjs');

test('the page script is valid JavaScript, and asks for state once it can receive it', () => {
  new vm.Script(JS, { filename: 'controller.js' });
  assert.ok(JS.includes("type: 'ready'"));
  assert.ok(JS.includes("type: 'detected'"), 'and reports what it can see');
});

test('the profile module loads in the page under a bare CommonJS shim', () => {
  // The page needs the same deadzone and the same capture rule the host
  // uses, so controllerView.cjs ships the module into the page rather than
  // letting a second copy of those numbers exist. That only works while
  // the module stays loadable with nothing but `module` defined — no
  // `require`, no `process`, no Node globals.
  const context = { module: { exports: {} } };
  vm.createContext(context);
  new vm.Script(PROFILE, { filename: 'controllerProfile.cjs' }).runInContext(context);
  const loaded = context.module.exports;
  for (const name of ['readBinding', 'capture', 'parseBinding', 'resolveDirection', 'deviceKey', 'DEADZONE']) {
    assert.ok(loaded[name] !== undefined, `${name} did not survive the shim`);
  }
  assert.doesNotMatch(PROFILE, /\brequire\(/, 'a require() would not resolve in the page');
  assert.doesNotMatch(PROFILE, /\bprocess\./, 'process does not exist in the page');
  assert.match(VIEW, /var module = \{ exports: \{\} \};/, 'the shim the page is handed');
  assert.match(VIEW, /var Profile = \(function/);
  assert.match(VIEW, /return module\.exports;/);
  assert.doesNotMatch(VIEW, /var Profile = module\.exports;/);
});

test('the profile shim does not leak heldKeys into the page', () => {
  // A classic <script> is one global scope. controllerProfile.cjs names a
  // helper heldKeys, and the page declares const heldKeys for the keyboard.
  // Unwrapped, the second script dies with "heldKeys has already been
  // declared" and the panel is a Controllers heading with nothing under it.
  const shim = `var Profile = (function () {
  var module = { exports: {} };
${PROFILE}
  return module.exports;
})();`;
  const context = {};
  vm.createContext(context);
  new vm.Script(shim, { filename: 'profile-shim.js' }).runInContext(context);
  assert.equal(typeof context.Profile.parseBinding, 'function');
  assert.equal(context.heldKeys, undefined, 'the helper must not become a page global');
  new vm.Script('const heldKeys = new Set();', { filename: 'page.js' }).runInContext(context);
});

test('the page reads bindings through the shared module and invents no thresholds', () => {
  assert.match(JS, /Profile\.readBinding/);
  assert.match(JS, /Profile\.capture/);
  assert.match(JS, /Profile\.resolveDirection/, 'the left-stick fallback is the module’s rule');
  assert.match(JS, /Profile\.DEADZONE/);
  // A second copy of the numbers would be a second definition of what a
  // profile means.
  assert.doesNotMatch(JS, /(const|let|var)\s+DEADZONE/);
  assert.doesNotMatch(JS, /(const|let|var)\s+PRESS_THRESHOLD/);
  // And no control list of its own: the eighteen come down in `state`.
  assert.doesNotMatch(JS, /leftStickY'\s*,\s*'rightStickX/);
});

test('every element the page script reaches for is on the page', () => {
  const ids = [...new Set([...JS.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.length > 0, 'the page addresses elements by id');
  for (const id of ids) assert.match(VIEW, new RegExp(`id="${id}"`), `no #${id} in the page`);
});

test('the silhouette names only real controls, and covers everything it can show', () => {
  const named = [...PAD_SVG.matchAll(/data-control="([^"]+)"/g)]
    .flatMap((match) => match[1].split(' '));
  assert.ok(named.length > 0);
  for (const control of named) {
    assert.ok(LOGICAL_CONTROLS.includes(control), `${control} is not a logical control`);
  }
  // Everything the brief asks the picture to show: a D-pad, four face
  // buttons, shoulders, triggers, Start/Select and two sticks.
  for (const control of ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'lt', 'rt', 'start', 'select']) {
    assert.ok(named.includes(control), `${control} has no shape on the pad`);
  }
  // Each stick is one shape carrying both of its axes: clicking it asks
  // for the horizontal, then the vertical.
  assert.match(PAD_SVG, /data-control="leftStickX leftStickY"/);
  assert.match(PAD_SVG, /data-control="rightStickX rightStickY"/);
  assert.match(PAD_SVG, /data-knob="left"/, 'and a knob that moves with it');
  assert.match(PAD_SVG, /data-knob="right"/);
  // Inline, because the webview's CSP names no image source at all.
  assert.doesNotMatch(PAD_SVG, /href=|url\(/, 'nothing is fetched from outside the page');
});

test('the page can tell a refused permission from an empty controller list', () => {
  // The two look identical on screen and are completely different
  // problems, which is the one thing most likely to cost somebody an
  // afternoon. `pads()` returns null for both refusals — an absent API and
  // a SecurityError from the permissions policy — and the notice says so.
  assert.match(JS, /typeof navigator\.getGamepads !== 'function'/);
  assert.match(JS, /catch \(error\) \{\s*return null;/);
  assert.match(JS, /permissions policy/);
  assert.match(JS, /press a button on it/, 'and the other case says why an idle pad is invisible');
  // Chromium will not list a pad until it has been used in this page, so
  // Look again is a focused re-poll rather than a way around that gate.
  assert.match(VIEW, /id="scan"/);
  assert.match(JS, /\$\('scan'\)\.addEventListener\('click'/);
  assert.match(JS, /Look again|reported = ''/);
  // The third state, which the API itself cannot report: a policy that
  // answers the call with nothing instead of refusing it. The only tell is
  // a `gamepadconnected` event from a window that then lists no pads.
  assert.match(JS, /sawConnect && connected\.length === 0/);
  assert.match(JS, /saw a controller connect and then reported no controllers/);
  assert.match(VIEW, /silenced: this\.silenced/, 'and the host passes it back down');
  // It has to be cleared in both places, or the most ordinary thing
  // anybody does — plug a pad in, use it, unplug it — ends with the panel
  // announcing a sandbox refusal at somebody who pulled a USB cable.
  assert.match(JS, /if \(connected\.length > 0\) sawConnect = false;/);
  assert.match(JS, /gamepaddisconnected', \(\) => \{ sawConnect = false;/);
});

test('two identical controllers are told apart by the same rule at both ends', () => {
  // Two of the same pad report the same `Gamepad.id`, which is the
  // ordinary two-player setup; `deviceKeys` on the same ordered list is
  // the one rule that separates them, and the page and the extension both
  // have to use it or they disagree about which pad is selected.
  assert.match(JS, /Profile\.deviceKeys\(connected\.map/);
  assert.doesNotMatch(JS, /Profile\.deviceKey\(/, 'the page never keys one pad on its own');
  assert.match(VIEW, /keyed\(\)/, 'and the extension keys the list, not an entry');
  assert.doesNotMatch(VIEW, /[^s]deviceKey\(/, 'no bare deviceKey survives on the host either');
});

test('the stylesheet is the editor’s theme, and lays out what it hides', () => {
  assert.match(CSS, /--vscode-/, 'every color is the editor theme’s');
  assert.match(CSS, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(CSS, /#pad \.hit\b/, 'the clickable controls');
  assert.match(CSS, /#pad \.hit\.on\b/, 'lit while pressed');
  assert.match(CSS, /#pad \.hit\.asking\b/, 'and while the walkthrough is waiting for it');
  assert.match(CSS, /table\.preview\b/, 'the per-machine projection');
  assert.match(CSS, /\.axis-bar\b/, 'a signed axis draws from the middle out');
});

test('the panel is one tab, retained, and revealed rather than reopened', () => {
  assert.match(VIEW, /createWebviewPanel/);
  assert.match(VIEW, /retainContextWhenHidden: true/);
  assert.match(VIEW, /open\.panel\.reveal/, 'a second invocation shows the one already open');
  assert.match(VIEW, /panel\.onDidDispose/, 'and its subscriptions are let go');
  assert.match(JS, /document\.hidden/, 'the page stops drawing when it is not being looked at');
});

test('the preview asks the toolchain what each machine has', () => {
  // The rule hardwareCatalog.cjs opens with: the editor never lists an
  // option, a value or a preset of its own. Here that means the port
  // counts are the fact sheet's, resolved with the hardware each machine
  // is actually fitted with — not a machine's stock sheet, since a fitted
  // option changes the answer.
  assert.match(VIEW, /effectiveFacts\(target, settings\.getEffectiveHardware\(id, target\)\)/);
  assert.match(VIEW, /loadTargets/);
  assert.match(VIEW, /target\?\.title \?\? id/, 'and the machine’s name is the toolchain’s');
  const { ALL_TARGETS } = require('../src/projects.cjs');
  assert.match(VIEW, /ALL_TARGETS\.map/, 'every machine that builds gets a row');
  assert.equal(ALL_TARGETS.length, 9);
});

test('the toolchain reads the file itself, so nothing is offered to paste', () => {
  // packages/cli/src/controllers.mjs's `controllerPlayers` takes the very
  // object controllerStore.cjs writes. An earlier version of this panel
  // emitted a `controllers.players` block for 8bitscript.config.ts,
  // because that is where the CLI first read a profile from; offering
  // somebody a snippet to paste into a config nothing consults would now
  // be its own quiet trap.
  for (const gone of ['toConfigBlock', 'configBlock', 'config-block', 'copy-config']) {
    assert.ok(!VIEW.includes(gone), `${gone} outlived the config block`);
    assert.ok(!JS.includes(gone), `${gone} outlived the config block in the page`);
  }
  assert.doesNotMatch(VIEW, /applyEdit|WorkspaceEdit/, 'and the config is still not rewritten from here');
});

test('a keyboard key is a binding the panel can read and capture', () => {
  // atari800 takes a joystick mapping in no other shape, so on that
  // machine a key *is* the controller. The CLI has always read `key:`;
  // this end used to drop one on the next save.
  assert.match(PROFILE, /\^key:\(\[A-Za-z0-9_\]\+\)\$/, 'parseBinding takes the fourth shape');
  assert.match(JS, /heldKeys/, 'and the page knows which keys are down');
  assert.match(JS, /window\.addEventListener\('keyup'/);
  // A key held while the window loses focus never sends its keyup here,
  // and a phantom held key would bind itself to the next control asked
  // for.
  assert.match(JS, /addEventListener\('blur', \(\) => heldKeys\.clear\(\)\)/);
  assert.match(JS, /visibilitychange', \(\) => heldKeys\.clear\(\)/);
  assert.match(JS, /frame\.keys = \[\.\.\.heldKeys\]/, 'keys ride on the same frame as the buttons');
  // The one key that cannot be captured is the one that cancels, and the
  // refusal lives with `capture` rather than being a second opinion here.
  assert.match(PROFILE, /const CANCEL_KEY = 'Escape';/);
  assert.match(JS, /the only mapping the Atari takes/, 'and the prompt says a key is allowed');
});

test('the command is contributed, and reachable from the side bar', () => {
  const command = MANIFEST.contributes.commands.find((c) => c.command === '8bitscript.controllerSetup');
  assert.ok(command, 'the command is declared');
  assert.equal(command.category, '8BitScript');
  assert.equal(command.title, 'Controller Setup');
  const menu = MANIFEST.contributes.menus['view/title']
    .find((item) => item.command === '8bitscript.controllerSetup');
  assert.ok(menu, 'and hung off the launcher’s title menu');
  assert.match(menu.when, /^view == 8bitscript\.launcher/);
  // Registered where every other command is.
  const extension = fs.readFileSync(path.join(ROOT, 'src', 'extension.cjs'), 'utf8');
  assert.match(extension, /registerControllerView\(context, projects\)/);
  assert.match(VIEW, /registerCommand\('8bitscript\.controllerSetup'/);
});

test('the profile is stored as a file of its own, not written into the config', () => {
  // A `systems` entry goes through a WorkspaceEdit because the config is
  // source somebody reads (runner.cjs's saveSystem). Eighteen bindings per
  // device, rewritten on every button press, are not that — so they are
  // JSON in ~/.config/8bitscript, which is also what anything that is not
  // this editor can read. A copy in the project directory is still honoured.
  const store = fs.readFileSync(path.join(ROOT, 'src', 'controllerStore.cjs'), 'utf8');
  assert.match(store, /8bitscript\.controllers\.json/);
  assert.match(store, /\.config\/8bitscript/);
  assert.doesNotMatch(VIEW, /8bitscript\.config\.ts'/, 'the config is not touched');
  assert.doesNotMatch(store, /require\('vscode'\)/, 'so it is testable without a window');
  assert.doesNotMatch(PROFILE, /require\('vscode'\)/);
});
