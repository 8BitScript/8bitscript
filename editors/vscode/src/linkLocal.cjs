// Replace a VSIX (or any previous folder) of this extension with a
// symlink to this source checkout, named for the version in package.json.
//
// VS Code and Cursor treat a `.vsix` install as pinned: it will not
// auto-update from the Marketplace or Open VSX. A symlink of
// `editors/vscode` is the development install; `bootstrap.cjs` rebuilds
// `dist/` on reload when `src/` is newer, so the linked tree is what
// actually runs.
const fs = require('fs');
const path = require('path');

function extensionDirName(pkg) {
  return `${pkg.publisher}.${pkg.name}-${pkg.version}`;
}

function extensionsRoot(home, editor) {
  return path.join(home, editor === 'vscode' ? '.vscode' : '.cursor', 'extensions');
}

/** Which editors `scripts/link-local.cjs` should link, from argv and $HOME. */
function editorsToLink(args, home, exists = fs.existsSync) {
  const flags = args instanceof Set ? args : new Set(args);
  const editors = [];
  if (flags.has('--vscode')) editors.push('vscode');
  if (flags.has('--cursor')) editors.push('cursor');
  if (editors.length === 0) {
    if (exists(path.join(home, '.cursor'))) editors.push('cursor');
    else if (exists(path.join(home, '.vscode'))) editors.push('vscode');
    else editors.push('cursor');
  }
  if (flags.has('--also-vscode') && !editors.includes('vscode')) editors.push('vscode');
  return editors;
}

/**
 * Remove every `prefix*` entry under `dir`, refusing to remove
 * `protect` (the source tree a caller is about to link in, if any).
 * Shared by linkLocal (protects the tree it is about to symlink) and
 * unlinkLocal (protects nothing — it is just clearing the way for a
 * fresh Marketplace install).
 */
function removeInstalled(dir, prefix, protect, { readdirSync, rmSync }) {
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(dir, name);
    if (protect && path.resolve(full) === protect) {
      throw new Error(`${full} is this source tree; refusing to remove it`);
    }
    rmSync(full, { recursive: true, force: true });
  }
}

/**
 * Remove every `publisher.name-*` install for this extension under
 * `editor`'s extensions folder, then symlink `extensionRoot` in as the
 * current version. Returns the destination path.
 */
function linkLocal({
  home,
  editor = 'cursor',
  extensionRoot,
  mkdirSync = fs.mkdirSync,
  readdirSync = fs.readdirSync,
  rmSync = fs.rmSync,
  symlinkSync = fs.symlinkSync,
  readFileSync = fs.readFileSync,
} = {}) {
  if (!home) throw new Error('home is required');
  if (!extensionRoot) throw new Error('extensionRoot is required');
  if (editor !== 'cursor' && editor !== 'vscode') {
    throw new Error(`editor must be cursor or vscode, not ${editor}`);
  }

  const pkg = JSON.parse(readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
  if (!pkg.publisher || !pkg.name || !pkg.version) {
    throw new Error(`${extensionRoot}/package.json must have publisher, name, and version`);
  }

  const dir = extensionsRoot(home, editor);
  mkdirSync(dir, { recursive: true });

  const prefix = `${pkg.publisher}.${pkg.name}-`;
  const dest = path.join(dir, extensionDirName(pkg));
  const resolvedRoot = path.resolve(extensionRoot);

  removeInstalled(dir, prefix, resolvedRoot, { readdirSync, rmSync });

  symlinkSync(resolvedRoot, dest);
  return dest;
}

/**
 * The other direction of linkLocal: remove a `publisher.name-*` install
 * (the dev symlink, most often) under `editor`'s extensions folder and
 * leave nothing in its place — the caller installs the Marketplace/Open
 * VSX build afterward, through the editor's own install command rather
 * than this script fetching or extracting anything itself.
 */
function unlinkLocal({
  home,
  editor = 'cursor',
  publisher,
  name,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  rmSync = fs.rmSync,
} = {}) {
  if (!home) throw new Error('home is required');
  if (!publisher || !name) throw new Error('publisher and name are required');
  if (editor !== 'cursor' && editor !== 'vscode') {
    throw new Error(`editor must be cursor or vscode, not ${editor}`);
  }
  const dir = extensionsRoot(home, editor);
  if (!existsSync(dir)) return;
  removeInstalled(dir, `${publisher}.${name}-`, null, { readdirSync, rmSync });
}

module.exports = {
  editorsToLink, extensionDirName, extensionsRoot, linkLocal, unlinkLocal,
};
