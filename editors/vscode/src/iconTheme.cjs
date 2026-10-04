// The file icons (.8bs, .8bx, .8bg, .8ba) are a file icon theme, and a theme
// replaces the whole set. The extension used to switch it on by itself for
// everyone who installed it (`configurationDefaults`, in package.json), which
// silently changed every other file's icon too. It asks now — once — and
// remembers the answer whichever way it went.
const vscode = require('vscode');

const KEY = 'iconThemeOffered';

/**
 * @param {{ globalState?: { get: Function, update: Function } }} context
 */
async function offerIconTheme(context) {
  if (context.globalState?.get(KEY)) return;
  const workbench = vscode.workspace.getConfiguration('workbench');
  await context.globalState?.update(KEY, true);
  if (workbench.get('iconTheme') === '8bitscript') return;
  const choice = await vscode.window.showInformationMessage(
    'Show 8BitScript file icons for .8bs, .8bx, .8bg and .8ba? This sets your file icon theme to "8BitScript Icons"; you can change it back in File Icon Theme.',
    'Use 8BitScript icons',
    'Not now',
  );
  // `true` is the user (global) settings.
  if (choice === 'Use 8BitScript icons') await workbench.update('iconTheme', '8bitscript', true);
}

module.exports = { offerIconTheme };
