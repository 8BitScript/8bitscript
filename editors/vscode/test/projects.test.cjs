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
  EXAMPLES_DIR,
  byKind,
  cliPackageDir,
  commandArgs,
  findExamplesDir,
  findToolchain,
  isInstalled,
  kindOf,
  loadApps,
  loadExamples,
  insertSystem,
  ofKind,
  systemLine,
  packageManagerFor,
  loadProject,
  loadProjects,
  parseConfig,
  resolveLlvmMosHome,
  runnableOn,
  toolchainVersion,
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
  assert.equal(project.toolchainVersion, null, 'no real @8bitscript/cli package behind this bin');
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
  // The hardware fitted rides along as a person would type it.
  assert.deepEqual(
    commandArgs('run', 'c64', 'ntsc', { profile: 'reu512', options: { port1: 'mouse1351', sid: '8580' } }),
    ['run', 'c64', '--profile', 'reu512', '--hardware', 'port1=mouse1351,sid=8580'],
  );
  assert.deepEqual(commandArgs('build', 'pet', 'pal', { profile: '8032', options: {} }), ['build', '--target', 'pet', '--profile', '8032']);
  assert.deepEqual(commandArgs('run', 'vic20', 'pal', { profile: null, options: {} }), ['run', 'vic20', '--pal']);
});

test('parseConfig reads the object form of targets — the machines composing profiles — at depth one only', () => {
  const config = parseConfig(`export default {
  entry: 'src/main.8bs',
  targets: {
    c64: { profiles: { loaded: { ram: 'reu512', port1: 'mouse1351' }, vic20: { ram: '8k' } } },
    web: {},
    "pet": { profiles: { wide: { model: '8032' } } },
  },
};`);
  assert.deepEqual(config.targets, ['c64', 'pet', 'web']);
});

/**
 * A checkout of the repository, as the tests see it: the CLI package, one
 * example, and one app — plus a note beside them that is neither.
 */
function checkout(root) {
  const repo = path.join(root, '8bitscript');
  write(path.join(repo, 'packages', 'cli', 'package.json'), JSON.stringify({ name: '@8bitscript/cli', version: '0.1.2' }));
  write(path.join(repo, 'packages', 'cli', 'bin', '8bs.mjs'), '');
  write(path.join(repo, 'packages', 'studio', 'package.json'), JSON.stringify({
    name: '@8bitscript/studio',
    version: '0.0.0',
    '8bitscript': { app: { title: 'Studio', entry: './src/main.8bs' } },
  }));
  write(path.join(repo, 'packages', 'studio', '8bs.config.ts'), "export default { targets: ['cx16', 'pet'] };");
  write(path.join(repo, 'packages', 'text', 'package.json'), JSON.stringify({ name: '@8bitscript/text' }));
  write(path.join(repo, EXAMPLES_DIR, 'border', '8bs.config.ts'), 'export default {};');
  write(path.join(repo, EXAMPLES_DIR, 'notes.md'), '');
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

test('toolchainVersion reads the CLI package.json through either kind of link', (t) => {
  const root = scratch(t);
  const repo = checkout(root);
  // A link or a monorepo checkout reports the linked package's own
  // version — the source, not whatever the registry last published.
  assert.equal(toolchainVersion(linkedConsumer(root, repo, 'game')), '0.1.2');
  assert.equal(toolchainVersion(shimmedConsumer(root, repo, 'shimmed')), '0.1.2');
  assert.equal(toolchainVersion(null), null);
  assert.equal(toolchainVersion(path.join(root, 'missing')), null);
});

test('findExamplesDir finds examples/ beside a repository checkout', (t) => {
  const root = scratch(t);
  const repo = checkout(root);
  const examples = path.join(repo, EXAMPLES_DIR);
  assert.equal(findExamplesDir(linkedConsumer(root, repo, 'game')), examples);
  assert.equal(findExamplesDir(shimmedConsumer(root, repo, 'shimmed')), examples);
  assert.equal(findExamplesDir(null), null);

  const loaded = loadExamples(examples);
  assert.deepEqual(loaded.map((p) => [p.name, p.kind, p.shipped]), [['border', 'example', true]]);
});

test('findExamplesDir returns null for a toolchain with no examples beside it', (t) => {
  const root = scratch(t);
  const repo = path.join(root, 'bare');
  write(path.join(repo, 'packages', 'cli', 'package.json'), JSON.stringify({ name: '@8bitscript/cli' }));
  write(path.join(repo, 'packages', 'cli', 'bin', '8bs.mjs'), '');
  assert.equal(findExamplesDir(linkedConsumer(root, repo, 'game')), null);
});

test('kindOf: an app declares itself, an example is placed, everything else is a project', () => {
  const app = { name: '@8bitscript/studio', '8bitscript': { app: { title: 'Studio' } } };
  assert.equal(kindOf('/repo/packages/studio', app), 'app');
  // Placed, not declared: anything directly under an `examples` directory
  // is an example, with or without a package.json of its own.
  assert.equal(kindOf('/repo/examples/borders', null), 'example');
  assert.equal(kindOf('/repo/examples/borders', { name: 'borders' }), 'example');
  // One level only. A directory nested deeper is a project the user
  // happens to keep near the examples, not one of them.
  assert.equal(kindOf('/repo/examples/group/borders', null), 'project', 'directly under examples/, not deeper');
  assert.equal(kindOf('/repo/borders', null), 'project', 'and under examples/, not anywhere');
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
  assert.equal(apps[0].toolchainVersion, '0.1.2', 'falls back the same way toolchain does');
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
  const border = loadProject(path.join(repo, EXAMPLES_DIR, 'border', '8bs.config.ts'));
  assert.equal(border.kind, 'example');
  assert.equal(border.title, 'border', 'a project with no app manifest is titled by its name');
});

test('withShipped skips shipped projects the workspace already lists', () => {
  const own = { name: 'border', dir: '/repo/examples/border', targets: ['vic20'] };
  const shipped = { ...own, shipped: true };
  const app = { name: '@8bitscript/studio', dir: '/repo/packages/studio', targets: ['cx16'], shipped: true };
  assert.deepEqual(withShipped([own], [shipped, app]), [own, app]);
});

test('byKind splits a mixed list into sections in a fixed order, and leaves a uniform one alone', () => {
  const game = { name: 'game', kind: 'project' };
  const border = { name: 'border', kind: 'example' };
  const studio = { name: '@8bitscript/studio', kind: 'app' };
  assert.deepEqual(
    byKind([studio, border, game]).map((s) => [s.kind, s.label, s.projects.map((p) => p.name)]),
    [
      ['project', 'Projects', ['game']],
      ['example', 'Examples', ['border']],
      ['app', 'Apps', ['@8bitscript/studio']],
    ],
  );
  assert.deepEqual(byKind([studio, border]).map((s) => s.kind), ['example', 'app'], 'only the kinds present');
  assert.equal(byKind([game]), null, 'one kind needs no sections');
  assert.equal(byKind([]), null);
  assert.deepEqual(ofKind([studio, border, game], 'app'), [studio]);
});

test('runnableOn keeps the projects that can run on one system', () => {
  const projects = [
    { name: 'a', targets: ['vic20', 'c64'] },
    { name: 'b', targets: ['web'] },
    { name: 'c', targets: ['vic20', 'web'] },
  ];
  assert.deepEqual(runnableOn(projects, 'vic20').map((p) => p.name), ['a', 'c']);
  assert.deepEqual(runnableOn(projects, 'c64').map((p) => p.name), ['a']);
  assert.deepEqual(runnableOn(projects, 'nes'), []);
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

// Writing a system into an 8bs.config.ts. The config is source, not a
// settings file, so this is a text edit on the one object it adds to:
// everything else in the file — the comments most of all — is untouched.
test('insertSystem opens a systems block, adds to one, and replaces a name', () => {
  const plain = "export default {\n  entry: 'src/main.8bs',\n  targets: ['c64', 'nes'],\n};\n";

  const first = insertSystem(plain, 'My C64', { target: 'c64', hardware: { sid: '8580' }, region: 'pal' });
  assert.equal(first, "export default {\n  entry: 'src/main.8bs',\n  targets: ['c64', 'nes'],\n"
    + "  systems: {\n    'My C64': { target: 'c64', hardware: { sid: '8580' }, region: 'pal' },\n  },\n};\n");

  const second = insertSystem(first, 'NES', { target: 'nes' });
  assert.match(second, /'My C64': \{ target: 'c64'/);
  assert.match(second, /\n    NES: \{ target: 'nes' \},\n/, 'a bare identifier is left unquoted');
  assert.equal(second.match(/systems: \{/g).length, 1, 'one block, not two');

  const again = insertSystem(second, 'My C64', { target: 'c64', profile: 'reu512' });
  assert.equal(again.match(/'My C64'/g).length, 1, 'saving over a name replaces it');
  assert.match(again, /'My C64': \{ target: 'c64', profile: 'reu512' \}/);
  assert.match(again, /NES: \{ target: 'nes' \}/, 'and leaves the others alone');
});

test('insertSystem keeps the rest of the file, and refuses a shape it cannot edit', () => {
  const commented = "// what this program is\nexport default {\n  // the entry\n  entry: 'a.8bs',\n"
    + "  targets: { c64: {} },  // just the one\n};\n";
  const out = insertSystem(commented, 'C64', { target: 'c64' });
  assert.match(out, /^\/\/ what this program is\n/);
  assert.match(out, /\/\/ the entry/);
  assert.match(out, /\/\/ just the one/);
  assert.match(out, /systems: \{\n    C64: \{ target: 'c64' \},\n  \},\n\};/);

  // A brace inside a comment or a string must not close the object early.
  const tricky = "export default {\n  entry: 'a}b.8bs', // }\n  targets: ['c64'],\n};\n";
  assert.match(insertSystem(tricky, 'C64', { target: 'c64' }), /systems: \{[\s\S]*\},\n\};\n$/);

  assert.equal(insertSystem('const c = build();\nexport default c;\n', 'x', { target: 'c64' }), null);

  // A `systems:` someone has commented out is not a block to add to.
  const disabled = "export default {\n  entry: 'a.8bs',\n  // systems: { old: { target: 'c64' } },\n  targets: ['c64'],\n};\n";
  const added = insertSystem(disabled, 'New', { target: 'c64' });
  assert.match(added, /\/\/ systems: \{ old: \{ target: 'c64' \} \},\n/, 'the comment is left as it was');
  assert.match(added, /\n  systems: \{\n    New: \{ target: 'c64' \},\n  \},\n\};/);
});

test('systemLine writes the entry a person would have typed', () => {
  assert.equal(systemLine('C64', { target: 'c64' }), "C64: { target: 'c64' },");
  assert.equal(
    systemLine("Bob's C64", { target: 'c64', profile: 'reu512', hardware: { sid: '8580' }, region: 'pal' }),
    "'Bob\\'s C64': { target: 'c64', profile: 'reu512', hardware: { sid: '8580' }, region: 'pal' },",
  );
});
