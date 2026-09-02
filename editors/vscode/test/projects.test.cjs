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
  commandArgs,
  findToolchain,
  loadProject,
  loadProjects,
  parseConfig,
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
