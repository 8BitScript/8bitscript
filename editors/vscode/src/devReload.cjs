// Local source-checkout installs: detect them, rebuild the bundled
// `dist/extension.cjs` the editor host actually loads, and decide when a
// window reload would pick the new bytes up.
//
// A Marketplace or Open VSX VSIX does not ship `src/`, so none of this
// runs there. A `.vsix` copied into the extensions folder is also not a
// source checkout — it is a frozen image, which is why it never
// auto-updates. The linked `editors/vscode` tree is the one this module
// is for.
//
// A save while the window is open does not rebuild. The watcher only
// marks the checkout dirty; the launcher then offers **Rebuild the local
// extension**. Reload is offered only after that rebuild finishes. A
// window reload (`bootstrap.cjs`) still compiles a stale `src/` so
// Developer: Reload Window cannot load yesterday's bundle by accident.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SOURCE_ENTRY = path.join('src', 'extension.cjs');
const BUNDLE_OUT = path.join('dist', 'extension.cjs');

/** Flags `package.json`'s `bundle` script uses. Kept here so tests can
 *  check the two cannot drift. */
const ESBUILD_FLAGS = Object.freeze([
  '--bundle',
  '--minify',
  '--platform=node',
  '--format=cjs',
  '--external:vscode',
]);

function isSourceCheckout(root, exists = fs.existsSync) {
  return exists(path.join(root, SOURCE_ENTRY));
}

function findEsbuild(root, exists = fs.existsSync) {
  const dir = path.join(root, 'node_modules', 'esbuild', 'bin');
  // The published esbuild package puts a native binary here, not a JS
  // file — spawn it directly. `node bin/esbuild` is a SyntaxError on the
  // ELF header.
  for (const name of ['esbuild.exe', 'esbuild']) {
    const bin = path.join(dir, name);
    if (exists(bin)) return bin;
  }
  return null;
}

function bundlePath(root) {
  return path.join(root, BUNDLE_OUT);
}

/** Files `dist/extension.cjs` still reads by path after esbuild inlines
 *  nothing. A VSIX has no `src/`, so they have to sit next to the bundle. */
const RUNTIME_FILES = Object.freeze(['controllerProfile.cjs']);

function copyRuntimeFiles(root, outfile) {
  const destDir = path.dirname(outfile ?? bundlePath(root));
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of RUNTIME_FILES) {
    fs.copyFileSync(path.join(root, 'src', name), path.join(destDir, name));
  }
}

/** Newest mtime under `dir`, or 0 if it does not exist. */
function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else if (entry.isFile()) {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        // A file that vanished between readdir and stat is not newer.
      }
    }
  }
  return newest;
}

function bundleMtime(root) {
  try {
    return fs.statSync(bundlePath(root)).mtimeMs;
  } catch {
    return 0;
  }
}

function isBundleStale(root) {
  return newestMtime(path.join(root, 'src')) > bundleMtime(root);
}

function esbuildArgs(root, outfile) {
  return [
    path.join(root, SOURCE_ENTRY),
    ...ESBUILD_FLAGS,
    `--outfile=${outfile ?? bundlePath(root)}`,
  ];
}

function missingEsbuildError(root) {
  return new Error(
    `esbuild is not installed in ${root}. From the 8BitScript repo, run pnpm install.`,
  );
}

function rebuildSync(root, { outfile, spawnSyncFn = spawnSync } = {}) {
  const bin = findEsbuild(root);
  if (!bin) throw missingEsbuildError(root);
  const result = spawnSyncFn(bin, esbuildArgs(root, outfile), {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `esbuild exited ${result.status}`).trim();
    throw new Error(detail);
  }
  copyRuntimeFiles(root, outfile);
}

function rebuild(root, { outfile, spawnFn = spawn } = {}) {
  const bin = findEsbuild(root);
  if (!bin) return Promise.reject(missingEsbuildError(root));
  return new Promise((resolve, reject) => {
    const child = spawnFn(bin, esbuildArgs(root, outfile), {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || `esbuild exited ${code}`).trim()));
        return;
      }
      try {
        copyRuntimeFiles(root, outfile);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * What a changed path under a source checkout means.
 * `bundle` — `src/` changed, so dist is stale until esbuild runs.
 * `reload` — media / grammar / manifest, already on disk, just need a reload.
 * `null` — ignore (dist, tests, node_modules, anything else).
 */
function classifyChange(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith('..')) return null;
  const norm = relative.split(path.sep).join('/');
  if (
    norm.startsWith('dist/')
    || norm.startsWith('test/')
    || norm.startsWith('node_modules/')
    || norm.startsWith('scripts/')
  ) {
    return null;
  }
  if (norm.startsWith('src/')) return 'bundle';
  if (
    norm.startsWith('media/')
    || norm.startsWith('syntaxes/')
    || norm.startsWith('snippets/')
    || norm === 'package.json'
    || norm === 'language-configuration.json'
    || norm === 'language-configuration.asm.json'
    || norm === 'bootstrap.cjs'
  ) {
    return 'reload';
  }
  return null;
}

/**
 * Phases the launcher reads:
 *   idle     — nothing to do (hidden)
 *   dirty    — a watched file changed; offer Rebuild, never Reload
 *   building — Rebuild was clicked; show status, no buttons
 *   ready    — rebuild finished; offer Reload
 *   error    — rebuild failed; offer Rebuild again, never Reload
 *
 * File events never start a rebuild. A change during `building` goes
 * back to `dirty` when the in-flight rebuild finishes, so Reload is
 * never offered for a bundle that is already stale again.
 */
function createDevReloadState({ rebuild: rebuildFn, onChange } = {}) {
  let phase = 'idle';
  let error = null;
  let running = false;
  let dirtyDuringBuild = false;

  function snapshot() {
    return { phase, error };
  }

  function setPhase(next, nextError = null) {
    phase = next;
    error = nextError;
    onChange?.(snapshot());
  }

  function note(kind) {
    if (kind !== 'bundle' && kind !== 'reload') return;
    if (running || phase === 'building') {
      dirtyDuringBuild = true;
      return;
    }
    if (phase !== 'dirty') setPhase('dirty');
  }

  async function startRebuild() {
    if (running) return;
    if (phase !== 'dirty' && phase !== 'error') return;
    running = true;
    dirtyDuringBuild = false;
    setPhase('building');
    try {
      if (rebuildFn) await rebuildFn();
      if (dirtyDuringBuild) {
        dirtyDuringBuild = false;
        setPhase('dirty');
      } else {
        setPhase('ready');
      }
    } catch (err) {
      setPhase('error', err.message);
    } finally {
      running = false;
    }
  }

  return {
    note,
    startRebuild,
    snapshot,
    get phase() { return phase; },
    get error() { return error; },
  };
}

function syncDevReloadContext(vscode, snapshot) {
  vscode.commands.executeCommand(
    'setContext',
    '8bitscript.localReloadPending',
    snapshot.phase === 'ready',
  );
  vscode.commands.executeCommand(
    'setContext',
    '8bitscript.localRebuildNeeded',
    snapshot.phase === 'dirty' || snapshot.phase === 'error',
  );
}

/**
 * Watch a source checkout. Marketplace installs have no `src/` and
 * return a quiet stub. File events only mark the checkout dirty — the
 * launcher (or the palette command) starts the rebuild.
 *
 * `vscode` is required inside the function so `node --test` can load this
 * file without the editor host.
 */
function registerDevReload(context, output) {
  const vscode = require('vscode');
  const emitter = new vscode.EventEmitter();
  const root = context.extensionPath;
  const local = isSourceCheckout(root);

  const controller = createDevReloadState({
    rebuild: local
      ? async () => {
        output.appendLine('Rebuilding the local extension…');
        try {
          await rebuild(root);
          output.appendLine('Rebuild finished.');
        } catch (error) {
          output.appendLine(error.stack || error.message);
          throw error;
        }
      }
      : undefined,
    onChange: (snapshot) => {
      syncDevReloadContext(vscode, snapshot);
      emitter.fire();
    },
  });

  context.subscriptions.push(emitter);
  context.subscriptions.push(
    vscode.commands.registerCommand('8bitscript.reloadWindow', () => (
      vscode.commands.executeCommand('workbench.action.reloadWindow')
    )),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('8bitscript.rebuildExtension', () => (
      controller.startRebuild()
    )),
  );

  if (!local) {
    return {
      isLocal: false,
      get phase() { return 'idle'; },
      get error() { return null; },
      rebuild: async () => {},
      onDidChange: emitter.event,
    };
  }

  output.appendLine(`Local 8BitScript extension at ${root}`);

  const bump = (uri) => {
    const kind = classifyChange(root, uri.fsPath);
    if (kind) controller.note(kind);
  };
  const patterns = [
    new vscode.RelativePattern(context.extensionUri, 'src/**'),
    new vscode.RelativePattern(context.extensionUri, 'media/**'),
    new vscode.RelativePattern(context.extensionUri, 'syntaxes/**'),
    new vscode.RelativePattern(context.extensionUri, 'snippets/**'),
    new vscode.RelativePattern(
      context.extensionUri,
      '{package.json,language-configuration.json,bootstrap.cjs}',
    ),
  ];
  for (const pattern of patterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(bump);
    watcher.onDidCreate(bump);
    watcher.onDidDelete(bump);
    context.subscriptions.push(watcher);
  }

  return {
    isLocal: true,
    get phase() { return controller.phase; },
    get error() { return controller.error; },
    rebuild: () => controller.startRebuild(),
    onDidChange: emitter.event,
  };
}

module.exports = {
  BUNDLE_OUT,
  ESBUILD_FLAGS,
  SOURCE_ENTRY,
  bundlePath,
  classifyChange,
  copyRuntimeFiles,
  createDevReloadState,
  findEsbuild,
  syncDevReloadContext,
  isBundleStale,
  isSourceCheckout,
  newestMtime,
  rebuild,
  rebuildSync,
  registerDevReload,
};
