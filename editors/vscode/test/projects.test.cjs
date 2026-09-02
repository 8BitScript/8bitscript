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
  bySystem,
  commandArgs,
  findExamplesDir,
  findToolchain,
  isInstalled,
  loadExamples,
  packageManagerFor,
  loadProject,
  loadProjects,
  parseConfig,
  resolveLlvmMosHome,
  runnableOn,
  withExamples,
} = require('../src/projects.cjs');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-projects-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
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
  assert.deepEqual(commandArgs('build', 'web', 'pal'), ['build', '--target', 'web'], 'web has no region');
  assert.deepEqual(commandArgs('run', 'web', 'pal'), ['run', 'web']);
  assert.deepEqual(commandArgs('doctor'), ['doctor']);
});

test('findExamplesDir follows the toolchain link back to a repository checkout', (t) => {
  const root = scratch(t);
  const repo = path.join(root, '8bitscript');
  write(path.join(repo, 'packages', 'cli', 'bin', '8bs.mjs'), '');
  write(path.join(repo, 'examples', 'border', '8bs.config.ts'), 'export default {};');
  write(path.join(repo, 'examples', 'notes.md'), '');

  // A consumer whose .bin/8bs is a symlink into the checkout, as pnpm makes.
  const consumer = path.join(root, 'game');
  const bin = path.join(consumer, 'node_modules', '.bin', BINARY);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.symlinkSync(path.join(repo, 'packages', 'cli', 'bin', '8bs.mjs'), bin);

  assert.equal(findExamplesDir(bin), path.join(repo, 'examples'));

  // pnpm writes .bin/8bs as a shell shim, not a symlink, and links the
  // package directory instead: the examples must still be found through it.
  const shimmed = path.join(root, 'shimmed');
  const shim = path.join(shimmed, 'node_modules', '.bin', BINARY);
  write(shim, '#!/bin/sh\nexec node ../@8bitscript/cli/bin/8bs.mjs "$@"\n');
  fs.mkdirSync(path.join(shimmed, 'node_modules', '@8bitscript'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'packages', 'cli'), path.join(shimmed, 'node_modules', '@8bitscript', 'cli'));
  assert.equal(findExamplesDir(shim), path.join(repo, 'examples'));

  assert.equal(findExamplesDir(null), null);
  assert.equal(findExamplesDir(path.join(root, 'missing')), null);

  const examples = loadExamples(path.join(repo, 'examples'));
  assert.deepEqual(examples.map((e) => [e.name, e.example]), [['border', true]]);
});

test('findExamplesDir returns null for a toolchain with no examples beside it', (t) => {
  const root = scratch(t);
  const bin = path.join(root, 'node_modules', '.bin', BINARY);
  write(bin, '');
  assert.equal(findExamplesDir(bin), null);
});

test('withExamples skips examples the workspace already lists', () => {
  const own = { name: 'border', dir: '/repo/examples/border', targets: ['vic20'] };
  const example = { ...own, example: true };
  const other = { name: 'counter', dir: '/repo/examples/counter', targets: ['web'], example: true };
  assert.deepEqual(withExamples([own], [example, other]), [own, other]);
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
  const pkg = { dependencies: { '@8bitscript/machine': 'workspace:*' } };
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
