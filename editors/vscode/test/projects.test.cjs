// Tests for the vscode-free half of the projects view: config reading,
// toolchain lookup, and the command each button runs. The view itself is
// exercised by loading the extension in the editor, not here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ALL_TARGETS,
  BINARY,
  DEFAULT_ENTRY,
  PROOFS_DIR,
  byKind,
  bySystem,
  cliPackageDir,
  commandArgs,
  findProofsDir,
  findToolchain,
  isInstalled,
  kindOf,
  loadApps,
  loadProofs,
  ofKind,
  packageManagerFor,
  loadProject,
  loadProjects,
  parseConfig,
  resolveLlvmMosHome,
  runnableOn,
  withShipped,
} = require('../src/projects.cjs');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-projects-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Canonical, because the code under test is: cliPackageDir() follows a
  // .bin symlink with realpathSync(), and on macOS os.tmpdir() is `/var/...`
  // while the real directory is `/private/var/...`. Without this a test
  // builds its expected path from the uncanonical spelling and compares it
  // against the canonical one the function correctly returns.
  return fs.realpathSync(dir);
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('parseConfig reads entry and targets from the documented shape', () => {
  const config = parseConfig(`export default {
  entry: 'src/main.8bs',
  targets: ['vic20', 'c64'],
};
`);
  assert.deepEqual(config, { entry: 'src/main.8bs', targets: ['vic20', 'c64'] });
});

test('parseConfig lists targets in the toolchain order, not the file order', () => {
  const { targets } = parseConfig(`export default { targets: ["web", "vic20"] };`);
  assert.deepEqual(targets, ['vic20', 'web']);
});

test('parseConfig falls back to the CLI defaults when keys are absent', () => {
  assert.deepEqual(parseConfig('export default {};'), {
    entry: DEFAULT_ENTRY,
    targets: ALL_TARGETS,
  });
  assert.deepEqual(parseConfig(''), { entry: DEFAULT_ENTRY, targets: ALL_TARGETS });
});

test('parseConfig ignores commented-out keys', () => {
  const config = parseConfig(`// targets: ['web'],
/* entry: 'old/main.8bs', */
export default {
  entry: 'src/game.8bs',
  targets: ['c64'],
};`);
  assert.deepEqual(config, { entry: 'src/game.8bs', targets: ['c64'] });
});

test('parseConfig drops target names the toolchain does not know', () => {
  const { targets } = parseConfig(`export default { targets: ['atari', 'c64'] };`);
  assert.deepEqual(targets, ['c64']);
  // Only unknown names means every target, the same as no list at all.
  assert.deepEqual(parseConfig(`export default { targets: ['atari'] };`).targets, ALL_TARGETS);
});

test('findToolchain walks upward to the nearest node_modules/.bin', (t) => {
  const root = scratch(t);
  const bin = path.join(root, 'node_modules', '.bin', BINARY);
  write(bin, '');
  const project = path.join(root, 'examples', 'thing');
  fs.mkdirSync(project, { recursive: true });

  assert.equal(findToolchain(project), bin);
  assert.equal(findToolchain(path.join(root, 'nowhere')), bin);

  const own = path.join(project, 'node_modules', '.bin', BINARY);
  write(own, '');
  assert.equal(findToolchain(project), own, 'the project\'s own install wins over the root');
});

test('findToolchain returns null when nothing is installed', (t) => {
  const root = scratch(t);
  assert.equal(findToolchain(root), null);
});

test('loadProject combines the config, package.json, and toolchain', (t) => {
  const root = scratch(t);
  const dir = path.join(root, 'examples', 'border');
  write(path.join(dir, '8bs.config.ts'), `export default { entry: 'src/main.8bs', targets: ['vic20', 'c64'] };`);
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'border', description: 'Cycles colours.' }));
  write(path.join(dir, 'node_modules', '.bin', BINARY), '');

  const project = loadProject(path.join(dir, '8bs.config.ts'));
  assert.equal(project.name, 'border');
  assert.equal(project.installed, true, 'no dependencies declared counts as installed');
  assert.equal(project.packageManager, 'pnpm');
  assert.equal(project.description, 'Cycles colours.');
  assert.equal(project.dir, dir);
  assert.equal(project.entry, path.join(dir, 'src', 'main.8bs'));
  assert.deepEqual(project.targets, ['vic20', 'c64']);
  assert.equal(project.toolchain, path.join(dir, 'node_modules', '.bin', BINARY));
});

test('loadProject names a project after its directory when package.json is missing', (t) => {
  const root = scratch(t);
  const dir = path.join(root, 'sketch');
  write(path.join(dir, '8bs.config.ts'), 'export default {};');

  const project = loadProject(path.join(dir, '8bs.config.ts'));
  assert.equal(project.name, 'sketch');
  assert.equal(project.description, '');
  assert.equal(project.toolchain, null);
  assert.deepEqual(project.targets, ALL_TARGETS);
});

test('loadProjects sorts by directory and drops duplicates', (t) => {
  const root = scratch(t);
  const b = path.join(root, 'b', '8bs.config.ts');
  const a = path.join(root, 'a', '8bs.config.ts');
  write(b, 'export default {};');
  write(a, 'export default {};');

  const projects = loadProjects([b, a, b]);
  assert.deepEqual(projects.map((p) => p.name), ['a', 'b']);
});

test('commandArgs spells the same commands a person would type', () => {
  assert.deepEqual(commandArgs('run', 'vic20', 'ntsc'), ['run', 'vic20']);
  assert.deepEqual(commandArgs('run', 'vic20', 'pal'), ['run', 'vic20', '--pal']);
  assert.deepEqual(commandArgs('build', 'c64', 'pal'), ['build', '--target', 'c64', '--pal']);
  assert.deepEqual(commandArgs('run', 'pet', 'ntsc'), ['run', 'pet']);
  assert.deepEqual(commandArgs('run', 'pet', 'pal'), ['run', 'pet'], 'the PET has no region: its refresh is the model\'s (--profile)');
  assert.deepEqual(commandArgs('build', 'web', 'pal'), ['build', '--target', 'web'], 'web has no region');
  assert.deepEqual(commandArgs('run', 'web', 'pal'), ['run', 'web']);
  assert.deepEqual(commandArgs('doctor'), ['doctor']);
});

/**
 * A checkout of the repository, as the tests see it: the CLI package, one
 * proof of concept, and one app — plus a note beside them that is neither.
 */
function checkout(root) {
  const repo = path.join(root, '8bitscript');
  write(path.join(repo, 'packages', 'cli', 'package.json'), JSON.stringify({ name: '@8bitscript/cli' }));
  write(path.join(repo, 'packages', 'cli', 'bin', '8bs.mjs'), '');
  write(path.join(repo, 'packages', 'studio', 'package.json'), JSON.stringify({
    name: '@8bitscript/studio',
    version: '0.0.0',
    '8bitscript': { app: { title: 'Studio', entry: './src/main.8bs' } },
  }));
  write(path.join(repo, 'packages', 'studio', '8bs.config.ts'), "export default { targets: ['cx16', 'pet'] };");
  write(path.join(repo, 'packages', 'text', 'package.json'), JSON.stringify({ name: '@8bitscript/text' }));
  write(path.join(repo, 'examples', PROOFS_DIR, 'border', '8bs.config.ts'), 'export default {};');
  write(path.join(repo, 'examples', PROOFS_DIR, 'notes.md'), '');
  return repo;
}

/** A consumer whose .bin/8bs is a symlink into the checkout, as npm makes. */
function linkedConsumer(root, repo, name) {
  const bin = path.join(root, name, 'node_modules', '.bin', BINARY);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.symlinkSync(path.join(repo, 'packages', 'cli', 'bin', '8bs.mjs'), bin);
  return bin;
}

/**
 * A consumer the way pnpm lays it out: .bin/8bs is a shell shim, not a
 * symlink, and node_modules/@8bitscript/cli links the package directory.
 */
function shimmedConsumer(root, repo, name) {
  const dir = path.join(root, name);
  const shim = path.join(dir, 'node_modules', '.bin', BINARY);
  write(shim, '#!/bin/sh\nexec node ../@8bitscript/cli/bin/8bs.mjs "$@"\n');
  fs.mkdirSync(path.join(dir, 'node_modules', '@8bitscript'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'packages', 'cli'), path.join(dir, 'node_modules', '@8bitscript', 'cli'));
  return shim;
}

test('cliPackageDir follows either kind of toolchain link back to the CLI package', (t) => {
  const root = scratch(t);
  const repo = checkout(root);
  assert.equal(cliPackageDir(linkedConsumer(root, repo, 'game')), path.join(repo, 'packages', 'cli'));
  assert.equal(cliPackageDir(shimmedConsumer(root, repo, 'shimmed')), path.join(repo, 'packages', 'cli'));
  assert.equal(cliPackageDir(null), null);
  assert.equal(cliPackageDir(path.join(root, 'missing')), null);
  // A bin with no @8bitscript/cli package behind it is not a toolchain the view can follow.
  const stray = path.join(root, 'stray', 'node_modules', '.bin', BINARY);
  write(stray, '');
  assert.equal(cliPackageDir(stray), null);
});

test('findProofsDir finds examples/proof-of-concept beside a repository checkout', (t) => {
  const root = scratch(t);
  const repo = checkout(root);
  const proofs = path.join(repo, 'examples', PROOFS_DIR);
  assert.equal(findProofsDir(linkedConsumer(root, repo, 'game')), proofs);
  assert.equal(findProofsDir(shimmedConsumer(root, repo, 'shimmed')), proofs);
  assert.equal(findProofsDir(null), null);

  const loaded = loadProofs(proofs);
  assert.deepEqual(loaded.map((p) => [p.name, p.kind, p.shipped]), [['border', 'proof', true]]);
});

test('findProofsDir returns null for a toolchain with no proofs beside it', (t) => {
  const root = scratch(t);
  const repo = path.join(root, 'bare');
  write(path.join(repo, 'packages', 'cli', 'package.json'), JSON.stringify({ name: '@8bitscript/cli' }));
  write(path.join(repo, 'packages', 'cli', 'bin', '8bs.mjs'), '');
  assert.equal(findProofsDir(linkedConsumer(root, repo, 'game')), null);
});

test('kindOf: an app declares itself, a proof of concept is placed, everything else is a project', () => {
  const app = { name: '@8bitscript/studio', '8bitscript': { app: { title: 'Studio' } } };
  assert.equal(kindOf('/repo/packages/studio', app), 'app');
  assert.equal(kindOf('/repo/examples/proof-of-concept/borders', null), 'proof');
  assert.equal(kindOf('/repo/examples/proof-of-concept/borders', { name: 'borders' }), 'proof');
  assert.equal(kindOf('/repo/examples/borders', { name: 'borders' }), 'project', 'only under proof-of-concept');
  assert.equal(kindOf('/repo/proof-of-concept/borders', null), 'project', 'and only under examples');
  assert.equal(kindOf('/repo/game', { '8bitscript': { entry: './src/index.8bs' } }), 'project', 'a library is not an app');
  assert.equal(kindOf('/repo/game', { '8bitscript': { app: true } }), 'project', 'the app field is an object');
});

test('loadApps finds the apps that ship with the toolchain, in a checkout and installed, once each', (t) => {
  const root = scratch(t);
  const repo = checkout(root);
  // In a checkout the CLI's own node_modules links its sibling, as pnpm does.
  fs.mkdirSync(path.join(repo, 'packages', 'cli', 'node_modules', '@8bitscript'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'packages', 'studio'), path.join(repo, 'packages', 'cli', 'node_modules', '@8bitscript', 'studio'));
  fs.symlinkSync(path.join(repo, 'packages', 'text'), path.join(repo, 'packages', 'cli', 'node_modules', '@8bitscript', 'text'));

  const bin = linkedConsumer(root, repo, 'game');
  const apps = loadApps(bin);
  assert.deepEqual(apps.map((a) => [a.name, a.title, a.kind, a.shipped, a.targets]), [
    ['@8bitscript/studio', 'Studio', 'app', true, ['pet', 'cx16']],
  ]);
  // An app is launched with the toolchain that found it when it has none of its own.
  assert.equal(apps[0].toolchain, bin);
  assert.equal(apps[0].dir, path.join(repo, 'packages', 'studio'));

  assert.deepEqual(loadApps(null), []);
});

test('loadApps ignores a package that declares an app but has no project manifest', (t) => {
  const root = scratch(t);
  const repo = checkout(root);
  fs.rmSync(path.join(repo, 'packages', 'studio', '8bs.config.ts'));
  assert.deepEqual(loadApps(linkedConsumer(root, repo, 'game')), []);
});

test('loadProject reads the kind and an app title from package.json', (t) => {
  const root = scratch(t);
  const repo = checkout(root);
  const studio = loadProject(path.join(repo, 'packages', 'studio', '8bs.config.ts'));
  assert.equal(studio.kind, 'app');
  assert.equal(studio.title, 'Studio');
  assert.equal(studio.name, '@8bitscript/studio');
  const border = loadProject(path.join(repo, 'examples', PROOFS_DIR, 'border', '8bs.config.ts'));
  assert.equal(border.kind, 'proof');
  assert.equal(border.title, 'border', 'a project with no app manifest is titled by its name');
});

test('withShipped skips shipped projects the workspace already lists', () => {
  const own = { name: 'border', dir: '/repo/examples/proof-of-concept/border', targets: ['vic20'] };
  const proof = { ...own, shipped: true };
  const app = { name: '@8bitscript/studio', dir: '/repo/packages/studio', targets: ['cx16'], shipped: true };
  assert.deepEqual(withShipped([own], [proof, app]), [own, app]);
});

test('byKind splits a mixed list into sections in a fixed order, and leaves a uniform one alone', () => {
  const game = { name: 'game', kind: 'project' };
  const border = { name: 'border', kind: 'proof' };
  const studio = { name: '@8bitscript/studio', kind: 'app' };
  assert.deepEqual(
    byKind([studio, border, game]).map((s) => [s.kind, s.label, s.projects.map((p) => p.name)]),
    [
      ['project', 'Projects', ['game']],
      ['proof', 'Proofs of concept', ['border']],
      ['app', 'Apps', ['@8bitscript/studio']],
    ],
  );
  assert.deepEqual(byKind([studio, border]).map((s) => s.kind), ['proof', 'app'], 'only the kinds present');
  assert.equal(byKind([game]), null, 'one kind needs no sections');
  assert.equal(byKind([]), null);
  assert.deepEqual(ofKind([studio, border, game], 'app'), [studio]);
});

test('runnableOn and bySystem group projects by target', () => {
  const projects = [
    { name: 'a', targets: ['vic20', 'c64'] },
    { name: 'b', targets: ['web'] },
    { name: 'c', targets: ['vic20', 'web'] },
  ];
  assert.deepEqual(runnableOn(projects, 'vic20').map((p) => p.name), ['a', 'c']);
  assert.deepEqual(runnableOn(projects, 'c64').map((p) => p.name), ['a']);
  assert.deepEqual(
    bySystem(projects).map((g) => [g.target, g.projects.map((p) => p.name)]),
    [['vic20', ['a', 'c']], ['c64', ['a']], ['web', ['b', 'c']]],
  );
  assert.deepEqual(bySystem([{ name: 'x', targets: ['web'] }]).map((g) => g.target), ['web']);
});

test('resolveLlvmMosHome prefers the setting, then the environment, then the default', (t) => {
  const root = scratch(t);
  const sdk = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    return dir;
  };
  const fromSetting = sdk('from-setting');
  const fromEnv = sdk('from-env');
  const fallback = sdk('fallback');
  const missing = path.join(root, 'missing');

  assert.equal(resolveLlvmMosHome({ setting: fromSetting, env: { LLVM_MOS_HOME: fromEnv }, defaultHome: fallback }), fromSetting);
  assert.equal(resolveLlvmMosHome({ setting: '  ', env: { LLVM_MOS_HOME: fromEnv }, defaultHome: fallback }), fromEnv);
  assert.equal(resolveLlvmMosHome({ env: {}, defaultHome: fallback }), fallback);
  assert.equal(resolveLlvmMosHome({ env: {}, defaultHome: missing }), null, 'an absent SDK resolves to nothing');
  // A wrong explicit setting survives, so doctor can complain about it by name.
  assert.equal(resolveLlvmMosHome({ setting: missing, env: {}, defaultHome: fallback }), missing);
  // A wrong environment value gives way to a default that actually has the SDK,
  // and is kept only when nothing better exists.
  assert.equal(resolveLlvmMosHome({ env: { LLVM_MOS_HOME: missing }, defaultHome: fallback }), fallback);
  assert.equal(resolveLlvmMosHome({ env: { LLVM_MOS_HOME: missing }, defaultHome: path.join(root, 'nope') }), missing);
});

test('isInstalled wants a node_modules only when dependencies are declared', (t) => {
  const root = scratch(t);
  const dir = path.join(root, 'game');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(isInstalled(dir, null), true);
  assert.equal(isInstalled(dir, { name: 'game' }), true);
  const pkg = { dependencies: { '@8bitscript/screen': 'workspace:*' } };
  assert.equal(isInstalled(dir, pkg), false);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  assert.equal(isInstalled(dir, pkg), true);
  assert.equal(isInstalled(dir, { devDependencies: { '@8bitscript/cli': '*' } }), true);
});

test('packageManagerFor follows the nearest lockfile upward, defaulting to pnpm', (t) => {
  const root = scratch(t);
  const nested = path.join(root, 'examples', 'thing');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(packageManagerFor(nested), 'pnpm');
  write(path.join(root, 'package-lock.json'), '{}');
  assert.equal(packageManagerFor(nested), 'npm');
  write(path.join(nested, 'yarn.lock'), '');
  assert.equal(packageManagerFor(nested), 'yarn', 'the closer lockfile wins');
});
