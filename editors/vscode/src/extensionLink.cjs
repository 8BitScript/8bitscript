// The side bar's "..." menu toggle between the official extension and a
// local development build — the UI half of what `pnpm run link-local`
// (linkLocal.cjs) already did from a terminal. Enabling points the
// editor's extensions folder at an 8BitScript checkout's editors/vscode
// via linkLocal(); disabling removes that link and asks the editor's
// own install command for the Marketplace/Open VSX build back, rather
// than fetching or extracting anything itself.
const os = require('os');
const path = require('path');

const { isSourceCheckout } = require('./devReload.cjs');
const { linkLocal, unlinkLocal } = require('./linkLocal.cjs');
const { resolveCheckoutRoot } = require('./checkout.cjs');
const settings = require('./settings.cjs');

const EXTENSION_PUBLISHER = '8bitscript';
const EXTENSION_NAME = '8bitscript-lang';
const EXTENSION_ID = `${EXTENSION_PUBLISHER}.${EXTENSION_NAME}`;

/** Cursor and VS Code both report a real `env.appName`; anything else defaults to vscode. */
function detectEditor(appName = '') {
  return /cursor/i.test(appName) ? 'cursor' : 'vscode';
}

/**
 * `editors/vscode` of a resolvable 8BitScript checkout, if that checkout
 * actually has one that itself looks like a source checkout (a bare
 * `packages/cli` clone with no `editors/vscode` at all is still a valid
 * `--checkout` for the CLI, just not one this feature can link).
 *
 * @param {{ folders?: string[], setting?: string|null, managed?: string|null }} options
 * @returns {string | null}
 */
function findExtensionCheckout({ folders = [], setting = null, managed = null } = {}) {
  const root = resolveCheckoutRoot({ folders, setting, managed })?.dir ?? null;
  if (!root) return null;
  const extensionRoot = path.join(root, 'editors', 'vscode');
  return isSourceCheckout(extensionRoot) ? extensionRoot : null;
}

/**
 * A directory a person pointed at directly: either the monorepo root
 * (its `editors/vscode`) or `editors/vscode` itself.
 *
 * @returns {string | null}
 */
function extensionCheckoutAt(dir) {
  if (isSourceCheckout(dir)) return dir;
  const nested = path.join(dir, 'editors', 'vscode');
  return isSourceCheckout(nested) ? nested : null;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string|null} managedDir
 * @param {{ isLocal: boolean }} devReload from registerDevReload — already
 *   knows whether context.extensionPath is a source checkout
 */
function registerExtensionLink(context, managedDir, devReload) {
  const vscode = require('vscode');

  vscode.commands.executeCommand('setContext', '8bitscript.usingLocalExtension', devReload.isLocal);

  context.subscriptions.push(
    vscode.commands.registerCommand('8bitscript.enableLocalExtension', async () => {
      const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
      let extensionRoot = findExtensionCheckout({
        folders, setting: settings.getCheckout() || null, managed: managedDir,
      });
      if (!extensionRoot) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: '8BitScript checkout',
          openLabel: 'Use this checkout',
        });
        if (!picked?.[0]) return;
        extensionRoot = extensionCheckoutAt(picked[0].fsPath);
        if (!extensionRoot) {
          vscode.window.showErrorMessage(
            `'${picked[0].fsPath}' does not look like an 8BitScript checkout ` +
              '(need editors/vscode/src/extension.cjs).',
          );
          return;
        }
      }
      try {
        linkLocal({ home: os.homedir(), editor: detectEditor(vscode.env.appName), extensionRoot });
      } catch (error) {
        vscode.window.showErrorMessage(`Could not link the local extension: ${error.message}`);
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        `Linked the local extension at ${extensionRoot}.`,
        'Reload Window',
      );
      if (choice) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
    vscode.commands.registerCommand('8bitscript.useOfficialExtension', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Switch back to the official 8BitScript extension? This reinstalls it from the Marketplace.',
        { modal: true },
        'Switch Back',
      );
      if (choice !== 'Switch Back') return;
      try {
        unlinkLocal({
          home: os.homedir(),
          editor: detectEditor(vscode.env.appName),
          publisher: EXTENSION_PUBLISHER,
          name: EXTENSION_NAME,
        });
      } catch (error) {
        vscode.window.showErrorMessage(`Could not remove the local link: ${error.message}`);
        return;
      }
      await vscode.commands.executeCommand('workbench.extensions.installExtension', EXTENSION_ID);
      const choice2 = await vscode.window.showInformationMessage(
        'Reinstalled the official 8BitScript extension.',
        'Reload Window',
      );
      if (choice2) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
  );
}

module.exports = {
  EXTENSION_ID, detectEditor, extensionCheckoutAt, findExtensionCheckout, registerExtensionLink,
};
