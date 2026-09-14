// The "..." menu toggle between the official extension and a local
// checkout: detecting the editor, finding a checkout to link, and the
// two commands that call linkLocal/unlinkLocal plus the editor's own
// install command.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const {
  EXTENSION_ID, detectEditor, extensionCheckoutAt, findExtensionCheckout, registerExtensionLink,
} = require('../src/extensionLink.cjs');
const { extensionsRoot } = require('../src/linkLocal.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '8bs-extlink-'));
}

function writeCheckout(root) {
  fs.mkdirSync(path.join(root, 'packages', 'cli', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  fs.writeFileSync(path.join(root, 'packages', 'cli', 'bin', '8bs.mjs'), '');
  fs.mkdirSync(path.join(root, 'editors', 'vscode', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'editors', 'vscode', 'src', 'extension.cjs'), '');
  fs.writeFileSync(path.join(root, 'editors', 'vscode', 'package.json'), JSON.stringify({
    publisher: '8bitscript', name: '8bitscript-lang', version: '0.9.0',
  }));
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('detectEditor: only Cursor is Cursor', () => {
  assert.equal(detectEditor('Cursor'), 'cursor');
  assert.equal(detectEditor('Visual Studio Code'), 'vscode');
  assert.equal(detectEditor(''), 'vscode');
  assert.equal(detectEditor(undefined), 'vscode');
});

test('EXTENSION_ID is this extension\'s real marketplace id', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(EXTENSION_ID, `${pkg.publisher}.${pkg.name}`);
});

test('extensionCheckoutAt accepts either the monorepo root or editors/vscode itself', () => {
  const dir = tmpDir();
  try {
    writeCheckout(dir);
    assert.equal(extensionCheckoutAt(dir), path.join(dir, 'editors', 'vscode'));
    assert.equal(extensionCheckoutAt(path.join(dir, 'editors', 'vscode')), path.join(dir, 'editors', 'vscode'));
    assert.equal(extensionCheckoutAt(path.join(dir, 'packages')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findExtensionCheckout: a checkout with no editors/vscode is not linkable', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'packages', 'cli', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    fs.writeFileSync(path.join(dir, 'packages', 'cli', 'bin', '8bs.mjs'), '');
    assert.equal(findExtensionCheckout({ folders: [dir] }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findExtensionCheckout: an open workspace checkout with the extension source is found', () => {
  const dir = tmpDir();
  try {
    writeCheckout(dir);
    assert.equal(findExtensionCheckout({ folders: [dir] }), path.join(dir, 'editors', 'vscode'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enableLocalExtension links an already-resolvable checkout without asking', async () => {
  const checkoutDir = tmpDir();
  const home = tmpDir();
  try {
    writeCheckout(checkoutDir);
    vscode.__mock.reset();
    vscode.env.appName = 'Cursor';
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: checkoutDir }, name: 'root' }];
    const originalHomedir = os.homedir;
    os.homedir = () => home;
    try {
      const context = { subscriptions: [] };
      registerExtensionLink(context, null, { isLocal: false });
      let dialogShown = false;
      vscode.window.showOpenDialog = () => { dialogShown = true; return Promise.resolve(undefined); };
      await vscode.__mock.trigger('8bitscript.enableLocalExtension');
      await tick();
      assert.equal(dialogShown, false, 'the workspace checkout was found without asking');
      const dest = path.join(extensionsRoot(home, 'cursor'), '8bitscript.8bitscript-lang-0.9.0');
      assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
      assert.match(vscode.__mock.calls.showInformationMessage.at(-1)[0], /Linked the local extension/);
    } finally {
      os.homedir = originalHomedir;
    }
  } finally {
    fs.rmSync(checkoutDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('enableLocalExtension falls back to a folder picker, and rejects a bad choice', async () => {
  const home = tmpDir();
  const notACheckout = tmpDir();
  try {
    vscode.__mock.reset();
    vscode.workspace.workspaceFolders = undefined;
    const originalHomedir = os.homedir;
    os.homedir = () => home;
    try {
      const context = { subscriptions: [] };
      registerExtensionLink(context, null, { isLocal: false });
      vscode.window.showOpenDialog = () => Promise.resolve([{ fsPath: notACheckout }]);
      await vscode.__mock.trigger('8bitscript.enableLocalExtension');
      await tick();
      assert.match(vscode.__mock.calls.showErrorMessage.at(-1)[0], /does not look like an 8BitScript checkout/);
    } finally {
      os.homedir = originalHomedir;
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(notACheckout, { recursive: true, force: true });
  }
});

test('enableLocalExtension: declining the folder picker does nothing', async () => {
  const home = tmpDir();
  try {
    vscode.__mock.reset();
    vscode.workspace.workspaceFolders = undefined;
    const context = { subscriptions: [] };
    registerExtensionLink(context, null, { isLocal: false });
    vscode.window.showOpenDialog = () => Promise.resolve(undefined);
    await vscode.__mock.trigger('8bitscript.enableLocalExtension');
    await tick();
    assert.equal(vscode.__mock.calls.showErrorMessage.length, 0);
    assert.equal(vscode.__mock.calls.showInformationMessage.length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('useOfficialExtension: declining the confirmation does nothing', async () => {
  vscode.__mock.reset();
  const context = { subscriptions: [] };
  registerExtensionLink(context, null, { isLocal: true });
  await vscode.__mock.trigger('8bitscript.useOfficialExtension');
  await tick();
  assert.equal(vscode.__mock.executedCommands.some((c) => c.id === 'workbench.extensions.installExtension'), false);
});

test('useOfficialExtension: confirming removes the link and asks the editor to install the real one', async () => {
  const home = tmpDir();
  const checkoutDir = tmpDir();
  try {
    writeCheckout(checkoutDir);
    vscode.__mock.reset();
    vscode.env.appName = 'Visual Studio Code';
    const originalHomedir = os.homedir;
    os.homedir = () => home;
    try {
      const { linkLocal } = require('../src/linkLocal.cjs');
      const dest = linkLocal({
        home, editor: 'vscode', extensionRoot: path.join(checkoutDir, 'editors', 'vscode'),
      });
      const context = { subscriptions: [] };
      registerExtensionLink(context, null, { isLocal: true });
      vscode.__mock.queues.showWarningMessage.push('Switch Back');
      await vscode.__mock.trigger('8bitscript.useOfficialExtension');
      await tick();
      assert.equal(fs.existsSync(dest), false, 'the dev symlink is gone');
      const installed = vscode.__mock.executedCommands.find((c) => c.id === 'workbench.extensions.installExtension');
      assert.ok(installed, 'the editor was asked to install the real extension');
      assert.deepEqual(installed.args, [EXTENSION_ID]);
      assert.match(vscode.__mock.calls.showInformationMessage.at(-1)[0], /Reinstalled the official/);
    } finally {
      os.homedir = originalHomedir;
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test('registerExtensionLink sets the usingLocalExtension context from devReload at startup', () => {
  vscode.__mock.reset();
  const context = { subscriptions: [] };
  registerExtensionLink(context, null, { isLocal: true });
  const setContext = vscode.__mock.executedCommands.find(
    (c) => c.id === 'setContext' && c.args[0] === '8bitscript.usingLocalExtension',
  );
  assert.equal(setContext.args[1], true);
});
