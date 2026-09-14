#!/usr/bin/env node
// Link this source checkout into Cursor (default) or VS Code as the
// 8BitScript extension. Replaces a VSIX copy, which would never update.
const os = require('os');
const path = require('path');

const { isBundleStale, isSourceCheckout, rebuildSync } = require('../src/devReload.cjs');
const { editorsToLink, linkLocal } = require('../src/linkLocal.cjs');

const args = new Set(process.argv.slice(2));
const home = os.homedir();
const extensionRoot = path.join(__dirname, '..');
const editors = editorsToLink(args, home);

if (!isSourceCheckout(extensionRoot)) {
  process.stderr.write(`Not a source checkout: ${extensionRoot}\n`);
  process.exit(1);
}

if (isBundleStale(extensionRoot)) {
  process.stderr.write('Rebuilding dist/extension.cjs…\n');
  rebuildSync(extensionRoot);
}

for (const editor of editors) {
  const dest = linkLocal({ home, editor, extensionRoot });
  process.stdout.write(`Linked ${editor}: ${dest} -> ${extensionRoot}\n`);
}
process.stdout.write('Reload the window to load it.\n');
