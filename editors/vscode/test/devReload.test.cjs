// Local source-checkout rebuild: a Marketplace VSIX has no src/, a
// linked editors/vscode tree does, and only the latter should ever
// rebuild dist/ or offer a window reload.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ESBUILD_FLAGS,
  classifyChange,
  createDevReloadState,
  findEsbuild,
  isBundleStale,
  isSourceCheckout,
  rebuild,
  syncDevReloadContext,
} = require('../src/devReload.cjs');

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '8bs-devreload-'));
}

test('a VSIX-shaped tree is not a source checkout', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'extension.cjs'), 'exports.activate = () => {};');
    assert.equal(isSourceCheckout(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a linked editors/vscode tree is a source checkout', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'extension.cjs'), '');
    assert.equal(isSourceCheckout(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the bundle is stale when src/ is newer than dist/, or dist is missing', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'extension.cjs'), 'ok');
    assert.equal(isBundleStale(dir), true, 'no dist yet');

    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'extension.cjs'), 'old');
    const src = path.join(dir, 'src', 'extension.cjs');
    const dist = path.join(dir, 'dist', 'extension.cjs');
    fs.utimesSync(src, 200, 200);
    fs.utimesSync(dist, 100, 100);
    assert.equal(isBundleStale(dir), true);

    fs.utimesSync(src, 100, 100);
    fs.utimesSync(dist, 200, 200);
    assert.equal(isBundleStale(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('src/ changes need a rebuild; media and the grammar only need a reload', () => {
  const root = '/ext';
  assert.equal(classifyChange(root, path.join(root, 'src', 'launcherView.cjs')), 'bundle');
  assert.equal(classifyChange(root, path.join(root, 'media', 'launcher.js')), 'reload');
  assert.equal(classifyChange(root, path.join(root, 'syntaxes', '8bs.tmLanguage.json')), 'reload');
  assert.equal(classifyChange(root, path.join(root, 'snippets', '8bs.json')), 'reload');
  assert.equal(classifyChange(root, path.join(root, 'package.json')), 'reload');
  assert.equal(classifyChange(root, path.join(root, 'language-configuration.asm.json')), 'reload');
  assert.equal(classifyChange(root, path.join(root, 'bootstrap.cjs')), 'reload');
  assert.equal(classifyChange(root, path.join(root, 'dist', 'extension.cjs')), null);
  assert.equal(classifyChange(root, path.join(root, 'test', 'devReload.test.cjs')), null);
  assert.equal(classifyChange(root, path.join(root, 'README.md')), null);
});

test('Rebuild from idle is a no-op — only dirty or error starts esbuild', async () => {
  let rebuilt = 0;
  const ctl = createDevReloadState({
    rebuild: async () => { rebuilt += 1; },
  });
  await ctl.startRebuild();
  assert.equal(ctl.phase, 'idle');
  assert.equal(rebuilt, 0);
});

test('a watched change does not rebuild until the user asks', async () => {
  let rebuilt = 0;
  const phases = [];
  const ctl = createDevReloadState({
    rebuild: async () => { rebuilt += 1; },
    onChange: (snap) => phases.push(snap.phase),
  });
  ctl.note('bundle');
  assert.equal(ctl.phase, 'dirty');
  assert.equal(rebuilt, 0, 'saving a file must not start esbuild');
  assert.deepEqual(phases, ['dirty']);
  await ctl.startRebuild();
  assert.equal(rebuilt, 1);
  assert.equal(ctl.phase, 'ready');
  assert.deepEqual(phases, ['dirty', 'building', 'ready']);
});

test('Reload is not offered until the rebuild finishes, never before', async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const ctl = createDevReloadState({
    rebuild: async () => { await gate; },
  });
  ctl.note('bundle');
  const pending = ctl.startRebuild();
  assert.equal(ctl.phase, 'building', 'the reload button must not appear mid-rebuild');
  finish();
  await pending;
  assert.equal(ctl.phase, 'ready');
});

test('media-only changes still wait for an explicit rebuild', async () => {
  let rebuilt = false;
  const ctl = createDevReloadState({
    rebuild: async () => { rebuilt = true; },
  });
  ctl.note('reload');
  assert.equal(ctl.phase, 'dirty');
  assert.equal(rebuilt, false);
  await ctl.startRebuild();
  assert.equal(rebuilt, true);
  assert.equal(ctl.phase, 'ready');
});

test('a failed rebuild does not offer reload', async () => {
  const ctl = createDevReloadState({
    rebuild: async () => { throw new Error('esbuild died'); },
  });
  ctl.note('bundle');
  await ctl.startRebuild();
  assert.equal(ctl.phase, 'error');
  assert.equal(ctl.error, 'esbuild died');
});

test('a change while rebuilding asks for another rebuild, not a reload', async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const ctl = createDevReloadState({
    rebuild: async () => { await gate; },
  });
  ctl.note('bundle');
  const pending = ctl.startRebuild();
  ctl.note('bundle');
  finish();
  await pending;
  assert.equal(ctl.phase, 'dirty');
});

test('a change after a successful rebuild hides reload until the next rebuild', async () => {
  const ctl = createDevReloadState({
    rebuild: async () => {},
  });
  ctl.note('bundle');
  await ctl.startRebuild();
  assert.equal(ctl.phase, 'ready');
  ctl.note('reload');
  assert.equal(ctl.phase, 'dirty');
});

test('context keys follow the phase: rebuild when dirty/error, reload only when ready', () => {
  const calls = [];
  const vscode = {
    commands: { executeCommand: (cmd, key, value) => calls.push([cmd, key, value]) },
  };
  syncDevReloadContext(vscode, { phase: 'dirty' });
  syncDevReloadContext(vscode, { phase: 'building' });
  syncDevReloadContext(vscode, { phase: 'ready' });
  syncDevReloadContext(vscode, { phase: 'error' });
  assert.deepEqual(calls, [
    ['setContext', '8bitscript.localReloadPending', false],
    ['setContext', '8bitscript.localRebuildNeeded', true],
    ['setContext', '8bitscript.localReloadPending', false],
    ['setContext', '8bitscript.localRebuildNeeded', false],
    ['setContext', '8bitscript.localReloadPending', true],
    ['setContext', '8bitscript.localRebuildNeeded', false],
    ['setContext', '8bitscript.localReloadPending', false],
    ['setContext', '8bitscript.localRebuildNeeded', true],
  ]);
});

test('rebuild flags match the package.json bundle script', () => {
  const script = MANIFEST.scripts.bundle;
  for (const flag of ESBUILD_FLAGS) {
    assert.ok(script.includes(flag), `${flag} missing from scripts.bundle`);
  }
  assert.match(script, /copyRuntimeFiles/, 'the VSIX has no src/; the profile has to be copied next to the bundle');
  assert.equal(MANIFEST.main, './bootstrap.cjs');
  assert.ok(MANIFEST.files.includes('bootstrap.cjs'));
  assert.ok(!MANIFEST.files.includes('src'), 'a VSIX must not ship src/, or every install would try to rebuild');
});

test('rebuild writes a bundle that exports activate, and copies the profile the page injects', async () => {
  assert.ok(findEsbuild(ROOT), 'pnpm install puts esbuild next to the extension');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-bundle-'));
  const outfile = path.join(dir, 'extension.cjs');
  try {
    await rebuild(ROOT, { outfile });
    const text = fs.readFileSync(outfile, 'utf8');
    assert.match(text, /activate/);
    assert.match(text, /8BitScript/);
    const profile = path.join(dir, 'controllerProfile.cjs');
    assert.equal(fs.existsSync(profile), true, 'without this, activate ENOENTs dist/controllerProfile.cjs');
    assert.match(fs.readFileSync(profile, 'utf8'), /DEADZONE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap only requires src/ when that file exists', () => {
  const bootstrap = fs.readFileSync(path.join(ROOT, 'bootstrap.cjs'), 'utf8');
  assert.match(bootstrap, /existsSync\(path\.join\(root, 'src', 'extension\.cjs'\)\)/);
  assert.match(bootstrap, /require\('\.\/dist\/extension\.cjs'\)/);
});
