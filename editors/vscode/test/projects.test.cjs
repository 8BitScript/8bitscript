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
  byKind,
  cliPackageDir,
  commandArgs,
  examplesManifest,
  findConfig,
  findToolchain,
  groupedMachineOptions,
  hasSeveralPrograms,
  installersForTargets,
  doctorWantFromSelection,
  DOCTOR_EMULATORS,
  ALL_DOCTOR_EMULATOR_IDS,
  INSTALLABLE_EMULATORS,
  isInstalled,
  kindOf,
  loadApps,
  loadExamples,
  loadExamplesFrom,
  insertSystem,
  ofKind,
  systemLine,
  packageManagerFor,
  packageManagerPath,
  cliCommand,
  nodeCommand,
  resolvePackageManager,
  loadProject,
  loadProjects,
  parseConfig,
  programTargets,
  resolveProgram,
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
  targets: ['pet', 'web'],
};
`);
  assert.deepEqual(config, { entry: 'src/main.8bs', targets: ['pet', 'web'], programs: [{ name: 'main', entry: 'src/main.8bs' }] });
});

test('parseConfig reads a programs block: every program by name, and `entry` is main\'s', () => {
  const config = parseConfig(`import { defineConfig } from '@8bitscript/cli';
export default defineConfig({
  programs: {
    format: { entry: 'src/tools/format.8bs', targets: ['c64'] },
    main:   { entry: 'src/main.8bs' },
    "copy": { entry: "src/tools/copy.8bs", requires: { 'memory.ram': 32768 } },
  },
  targets: { c64: {}, pet: {} },
});
`);
  assert.deepEqual(config, {
    entry: 'src/main.8bs',
    targets: ['pet', 'c64'],
    programs: [
      { name: 'format', entry: 'src/tools/format.8bs', targets: ['c64'] },
      { name: 'main', entry: 'src/main.8bs', targets: null },
      { name: 'copy', entry: 'src/tools/copy.8bs', targets: null },
    ],
  });
  // No main: the first program is "the" program.
  const first = parseConfig(`export default { programs: { tool: { entry: 'tool.8bs' } } };`);
  assert.equal(first.entry, 'tool.8bs');
  assert.deepEqual(first.programs, [{ name: 'tool', entry: 'tool.8bs', targets: null }]);
});

test('parseConfig lists targets in the toolchain order, not the file order', () => {
  const { targets } = parseConfig(`export default { targets: ["web", "pet"] };`);
  assert.deepEqual(targets, ['pet', 'web']);
});

test('parseConfig falls back to the CLI defaults when keys are absent', () => {
  assert.deepEqual(parseConfig('export default {};'), {
    entry: DEFAULT_ENTRY,
    targets: ALL_TARGETS,
    programs: [{ name: 'main', entry: DEFAULT_ENTRY }],
  });
  assert.deepEqual(parseConfig(''), { entry: DEFAULT_ENTRY, targets: ALL_TARGETS, programs: [{ name: 'main', entry: DEFAULT_ENTRY }] });
});

test('parseConfig ignores commented-out keys', () => {
  const config = parseConfig(`// targets: ['web'],
/* entry: 'old/main.8bs', */
export default {
  entry: 'src/game.8bs',
  targets: ['pet'],
};`);
  assert.deepEqual(config, { entry: 'src/game.8bs', targets: ['pet'], programs: [{ name: 'main', entry: 'src/game.8bs' }] });
});

test('parseConfig drops target names the toolchain does not know', () => {
  const { targets } = parseConfig(`export default { targets: ['atari', 'pet'] };`);
  assert.deepEqual(targets, ['pet']);
  // There are no parked machines left to stand here — every target the
  // toolchain knows now builds — so this is a made-up name, which is the
  // case that will always exist.
  assert.deepEqual(parseConfig(`export default { targets: ['zx81', 'web'] };`).targets, ['web']);
  // Only unknown/parked names means every target, the same as no list at all.
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

test('findToolchain prefers a checkout CLI over node_modules', (t) => {
  const { checkoutCli } = require('../src/checkout.cjs');
  const repo = path.resolve(__dirname, '..', '..', '..');
  const root = scratch(t);
  const bin = path.join(root, 'node_modules', '.bin', BINARY);
  write(bin, '');
  assert.equal(findToolchain(root, repo), checkoutCli(repo));
});

test('loadProject combines the config, package.json, and toolchain', (t) => {
  const root = scratch(t);
  const dir = path.join(root, 'game');
  write(path.join(dir, '8bitscript.config.8bs'), `export default { entry: 'src/main.8bs', targets: ['pet', 'web'] };`);
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'game', description: 'Cycles colors.' }));
  write(path.join(dir, 'node_modules', '.bin', BINARY), '');

  const project = loadProject(path.join(dir, '8bitscript.config.8bs'));
  assert.equal(project.name, 'game');
  assert.equal(project.installed, true, 'no dependencies declared counts as installed');
  assert.equal(project.packageManager, 'pnpm');
  assert.equal(project.description, 'Cycles colors.');
  assert.equal(project.dir, dir);
  assert.equal(project.entry, path.join(dir, 'src', 'main.8bs'));
  assert.deepEqual(project.targets, ['pet', 'web']);
  assert.equal(project.toolchain, path.join(dir, 'node_modules', '.bin', BINARY));
});

test('loadProject names a project after its directory when package.json is missing', (t) => {
  const root = scratch(t);
  const dir = path.join(root, 'sketch');
  write(path.join(dir, '8bitscript.config.8bs'), 'export default {};');

  const project = loadProject(path.join(dir, '8bitscript.config.8bs'));
  assert.equal(project.name, 'sketch');
  assert.equal(project.description, '');
  assert.equal(project.toolchain, null);
  assert.deepEqual(project.targets, ALL_TARGETS);
});

test('loadProjects sorts by directory and drops duplicates', (t) => {
  const root = scratch(t);
  const b = path.join(root, 'b', '8bitscript.config.8bs');
  const a = path.join(root, 'a', '8bitscript.config.8bs');
  write(b, 'export default {};');
  write(a, 'export default {};');

  const projects = loadProjects([b, a, b]);
  assert.deepEqual(projects.map((p) => p.name), ['a', 'b']);
});

test('findConfig prefers 8bitscript.config.8bs, then 8bitscript.config.ts, then 8bs.config.ts, like the CLI', (t) => {
  const root = scratch(t);
  const dir = path.join(root, 'game');
  write(path.join(dir, '8bs.config.ts'), 'export default {};');
  assert.equal(findConfig(dir), path.join(dir, '8bs.config.ts'), 'a pre-0.4.0 project still marks one');
  write(path.join(dir, '8bitscript.config.ts'), 'export default {};');
  assert.equal(findConfig(dir), path.join(dir, '8bitscript.config.ts'), '0.4.0 through 0.22.x wins over the older name');
  write(path.join(dir, '8bitscript.config.8bs'), 'export default {};');
  assert.equal(findConfig(dir), path.join(dir, '8bitscript.config.8bs'), 'the current name wins when all three are there');
  assert.equal(findConfig(path.join(root, 'empty')), null);
});

test('loadProjects reads any of the three config names, and a directory with several is one project under the newest', (t) => {
  const root = scratch(t);
  const renamed = path.join(root, 'renamed');
  write(path.join(renamed, '8bitscript.config.8bs'), "export default { entry: 'src/new.8bs' };");
  const legacy = path.join(root, 'legacy');
  write(path.join(legacy, '8bs.config.ts'), 'export default {};');
  const both = path.join(root, 'both');
  write(path.join(both, '8bitscript.config.8bs'), "export default { entry: 'src/new.8bs' };");
  write(path.join(both, '8bitscript.config.ts'), "export default { entry: 'src/middle.8bs' };");
  write(path.join(both, '8bs.config.ts'), "export default { entry: 'src/old.8bs' };");

  // The glob search hands back every match, all three names included.
  const projects = loadProjects([
    path.join(renamed, '8bitscript.config.8bs'),
    path.join(legacy, '8bs.config.ts'),
    path.join(both, '8bs.config.ts'),
    path.join(both, '8bitscript.config.ts'),
    path.join(both, '8bitscript.config.8bs'),
  ]);
  assert.deepEqual(projects.map((p) => [p.name, path.basename(p.configPath)]), [
    ['both', '8bitscript.config.8bs'],
    ['legacy', '8bs.config.ts'],
    ['renamed', '8bitscript.config.8bs'],
  ]);
  assert.equal(projects[0].entry, path.join(both, 'src', 'new.8bs'), "the current name's config is the one read");
});

test('commandArgs spells the same commands a person would type', () => {
  assert.deepEqual(commandArgs('run', 'vic20', 'ntsc'), ['run', 'vic20', '--size']);
  assert.deepEqual(commandArgs('run', 'vic20', 'pal'), ['run', 'vic20', '--pal', '--size']);
  assert.deepEqual(commandArgs('build', 'c64', 'pal'), ['build', '--target', 'c64', '--pal', '--size']);
  assert.deepEqual(commandArgs('run', 'pet', 'ntsc'), ['run', 'pet', '--size']);
  assert.deepEqual(commandArgs('run', 'pet', 'pal'), ['run', 'pet', '--size'], 'the PET has no region: its refresh is the model\'s (--profile)');
  assert.deepEqual(commandArgs('build', 'web', 'pal'), ['build', '--target', 'web', '--size'], 'web has no region');
  assert.deepEqual(commandArgs('run', 'web', 'pal'), ['run', 'web', '--size']);
  assert.deepEqual(commandArgs('doctor'), ['doctor']);
  assert.deepEqual(commandArgs('doctor', undefined, 'ntsc', undefined, { want: 'all' }), ['doctor', '--all']);
  assert.deepEqual(commandArgs('doctor', undefined, 'ntsc', undefined, { want: 'all', install: true }), ['doctor', '--install', '--all']);
  assert.deepEqual(commandArgs('doctor', undefined, 'ntsc', undefined, { want: ['vice', 'atari800'] }), ['doctor', '--want', 'vice,atari800']);
  assert.deepEqual(commandArgs('doctor', undefined, 'ntsc', undefined, { want: [] }), ['doctor', '--want', ''], 'empty --want is host tools only');
  // The hardware fitted rides along as a person would type it.
  assert.deepEqual(
    commandArgs('run', 'c64', 'ntsc', { profile: 'reu512', options: { port1: 'mouse1351', sid: '8580' } }),
    ['run', 'c64', '--profile', 'reu512', '--hardware', 'port1=mouse1351,sid=8580', '--size'],
  );
  assert.deepEqual(commandArgs('build', 'pet', 'pal', { profile: '8032', options: {} }), ['build', '--target', 'pet', '--profile', '8032', '--size']);
  assert.deepEqual(commandArgs('run', 'vic20', 'pal', { profile: null, options: {} }), ['run', 'vic20', '--pal', '--size']);
  // boot shares run's own [action, target] shape — no entry file, ever —
  // and fits the same hardware on top. It has no program, so no --size.
  assert.deepEqual(commandArgs('boot', 'pet', 'ntsc'), ['boot', 'pet']);
  assert.deepEqual(commandArgs('boot', 'pet', 'pal'), ['boot', 'pet'], 'the PET has no region here either');
  assert.deepEqual(
    commandArgs('boot', 'pet', 'ntsc', { profile: '8032', options: {} }),
    ['boot', 'pet', '--profile', '8032'],
  );
  assert.deepEqual(
    commandArgs('run', 'pet', 'ntsc', undefined, { system: 'PET 2001 (4K)' }),
    ['run', '--system', 'PET 2001 (4K)', '--size'],
  );
  assert.deepEqual(
    commandArgs('build', 'pet', 'ntsc', { profile: '8032' }, { system: 'PET 8032', checkout: '/src/8bitscript' }),
    ['build', '--system', 'PET 8032', '--checkout', '/src/8bitscript', '--size'],
    'a named system already carries its fitting; --checkout rides along',
  );
});

test('groupedMachineOptions covers every ALL_TARGETS id under a family label', () => {
  const rows = groupedMachineOptions(ALL_TARGETS, (id) => ({ id }));
  const groups = rows.filter((row) => row.group).map((row) => row.group);
  assert.deepEqual(groups, ['Commodore', 'Modern']);
  const ids = rows.filter((row) => row.id).map((row) => row.id);
  assert.deepEqual([...ids].sort(), [...ALL_TARGETS].sort());
  assert.equal(ids.length, ALL_TARGETS.length);
  const leftover = groupedMachineOptions(['pet', 'madeup'], (id) => ({ id }));
  assert.ok(leftover.some((row) => row.group === 'Machines'));
  assert.ok(leftover.some((row) => row.id === 'madeup'));
});

test('installersForTargets maps a project onto doctor emulator keys', () => {
  assert.deepEqual(installersForTargets(['c64', 'vic20', 'nes', 'web']), ['vice', 'fceux']);
  assert.deepEqual(installersForTargets(['gb', 'spectrum']), ['sameboy', 'fuse']);
  assert.deepEqual(installersForTargets(['cx16', 'mega65', 'atari8', 'atari5200']), ['x16emu', 'xmega65', 'atari800']);
});

test('DOCTOR_EMULATORS names every machine except the browser', () => {
  const named = new Set(DOCTOR_EMULATORS.flatMap((emu) => emu.machines));
  assert.deepEqual(ALL_TARGETS.filter((id) => id !== 'web' && !named.has(id)), []);
  assert.ok(!named.has('web'));
  assert.deepEqual(INSTALLABLE_EMULATORS, ALL_DOCTOR_EMULATOR_IDS);
});

test('doctorWantFromSelection: all by default, --want for a subset of installable keys', () => {
  assert.equal(doctorWantFromSelection(null), 'all');
  assert.equal(doctorWantFromSelection(ALL_DOCTOR_EMULATOR_IDS), 'all');
  assert.deepEqual(doctorWantFromSelection(['vice', 'stella']), ['vice', 'stella']);
  assert.deepEqual(doctorWantFromSelection([]), []);
  assert.equal(doctorWantFromSelection(INSTALLABLE_EMULATORS), 'all', 'every installable key is still --all');
});

test('parseConfig reads the object form of targets — the machines composing profiles — at depth one only', () => {
  const config = parseConfig(`export default {
  entry: 'src/main.8bs',
  targets: {
    pet: { profiles: { wide: { model: '8032' }, nested: { model: '3032' } } },
    web: {},
  },
};`);
  assert.deepEqual(config.targets, ['pet', 'web']);
});

/**
 * A checkout of the repository, as the tests see it: the CLI package, the
 * examples package with one example that exists and one the manifest
 * names but that is missing, and one app — plus a library beside them
 * that is neither.
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
  // 'zx81' is here to be dropped: the fixture proves names the toolchain
  // does not know are filtered out. It used to name a parked machine, but
  // every machine ships now.
  write(path.join(repo, 'packages', 'studio', '8bitscript.config.8bs'), "export default { targets: ['zx81', 'pet'] };");
  write(path.join(repo, 'packages', 'text', 'package.json'), JSON.stringify({ name: '@8bitscript/text' }));
  write(path.join(repo, 'packages', 'examples', 'package.json'), JSON.stringify({
    name: '@8bitscript/examples',
    '8bitscript': {
      examples: {
        hello: { title: 'Hello, PET', dir: './hello', description: 'HELLO WORLD through the text package.' },
        missing: { title: 'Not there', dir: './missing' },
      },
    },
  }));
  write(path.join(repo, 'packages', 'examples', 'hello', '8bitscript.config.8bs'), "export default { targets: { pet: {}, web: {} } };");
  write(path.join(repo, 'packages', 'examples', 'notes.md'), '');
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

test('loadExamples finds the examples the shipped manifest names, through either kind of toolchain link', (t) => {
  const root = scratch(t);
  const repo = checkout(root);
  for (const bin of [linkedConsumer(root, repo, 'game'), shimmedConsumer(root, repo, 'shimmed')]) {
    const loaded = loadExamples(bin);
    // The manifest's name, title and description; the directory inside the
    // package; marked shipped; an entry whose directory is missing is skipped.
    assert.deepEqual(loaded.map((p) => [p.name, p.title, p.kind, p.shipped, p.description, p.targets]), [
      ['hello', 'Hello, PET', 'example', true, 'HELLO WORLD through the text package.', ['pet', 'web']],
    ]);
    assert.equal(loaded[0].dir, path.join(repo, 'packages', 'examples', 'hello'));
    // An example runs with the toolchain that found it and has no install of its own to be missing.
    assert.equal(loaded[0].toolchain, bin);
    assert.equal(loaded[0].installed, true);
  }
  assert.deepEqual(loadExamples(null), []);
});

test('loadExamples is empty for a toolchain that ships no examples package', (t) => {
  const root = scratch(t);
  const repo = path.join(root, 'bare');
  write(path.join(repo, 'packages', 'cli', 'package.json'), JSON.stringify({ name: '@8bitscript/cli' }));
  write(path.join(repo, 'packages', 'cli', 'bin', '8bs.mjs'), '');
  assert.deepEqual(loadExamples(linkedConsumer(root, repo, 'game')), []);
});

test('loadExamplesFrom lists the projects directly under a directory of your own examples, any of the three config names', (t) => {
  const root = scratch(t);
  write(path.join(root, 'mine', 'border', '8bs.config.ts'), 'export default {};');
  write(path.join(root, 'mine', 'raster', '8bitscript.config.ts'), 'export default {};');
  write(path.join(root, 'mine', 'charset', '8bitscript.config.8bs'), 'export default {};');
  write(path.join(root, 'mine', 'notes.md'), '');
  write(path.join(root, 'mine', 'deeper', 'nested', '8bs.config.ts'), 'export default {};');
  assert.deepEqual(loadExamplesFrom(path.join(root, 'mine')).map((p) => [p.name, p.kind, p.shipped]), [['border', 'example', true], ['charset', 'example', true], ['raster', 'example', true]]);
  assert.deepEqual(loadExamplesFrom(path.join(root, 'nowhere')), []);
});

test('examplesManifest reads the 8bitscript.examples field, an object keyed by name', () => {
  assert.deepEqual(examplesManifest({ '8bitscript': { examples: { hello: { dir: './hello' } } } }), { hello: { dir: './hello' } });
  assert.equal(examplesManifest({ '8bitscript': { examples: ['hello'] } }), null, 'an array is not the shape');
  assert.equal(examplesManifest({ '8bitscript': { entry: './src/index.8bs' } }), null, 'a library ships none');
  assert.equal(examplesManifest(null), null);
});

test('kindOf: an app declares itself; an example is named by a parent manifest', () => {
  const app = { name: '@8bitscript/studio', '8bitscript': { app: { title: 'Studio' } } };
  assert.equal(kindOf('/repo/packages/studio', app), 'app');
  assert.equal(kindOf('/repo/examples/borders', null), 'project', 'a path named examples is not enough');
  assert.equal(kindOf('/repo/game', { '8bitscript': { entry: './src/index.8bs' } }), 'project', 'a library is not an app');
  assert.equal(kindOf('/repo/game', { '8bitscript': { app: true } }), 'project', 'the app field is an object');
  const hello = path.resolve(__dirname, '..', '..', '..', 'packages', 'examples', 'hello-world');
  assert.equal(kindOf(hello, null), 'example');
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
    ['@8bitscript/studio', 'Studio', 'app', true, ['pet']],
  ]);
  // An app is launched with the toolchain that found it when it has none of its own.
  assert.equal(apps[0].toolchain, bin);
  assert.equal(apps[0].dir, path.join(repo, 'packages', 'studio'));

  assert.deepEqual(loadApps(null), []);
});

test('loadApps ignores a package that declares an app but has no project manifest', (t) => {
  const root = scratch(t);
  const repo = checkout(root);
  fs.rmSync(path.join(repo, 'packages', 'studio', '8bitscript.config.8bs'));
  assert.deepEqual(loadApps(linkedConsumer(root, repo, 'game')), []);
});

test('loadProject reads the kind and an app title from package.json', (t) => {
  const root = scratch(t);
  const repo = checkout(root);
  const studio = loadProject(path.join(repo, 'packages', 'studio', '8bitscript.config.8bs'));
  assert.equal(studio.kind, 'app');
  assert.equal(studio.title, 'Studio');
  assert.equal(studio.name, '@8bitscript/studio');
  const hello = loadProject(path.join(repo, 'packages', 'examples', 'hello', '8bitscript.config.8bs'));
  assert.equal(hello.kind, 'example', 'a parent 8bitscript.examples manifest names it');
  assert.equal(hello.title, 'hello', 'without the manifest override, the title is the directory name');
});

test('withShipped skips shipped projects the workspace already lists', () => {
  const own = { name: 'border', dir: '/repo/examples/border', targets: ['vic20'] };
  const shipped = { ...own, shipped: true };
  const app = { name: '@8bitscript/studio', dir: '/repo/packages/studio', targets: ['cx16'], shipped: true };
  assert.deepEqual(withShipped([own], [shipped, app]), [own, app]);
});

test('byKind splits a mixed list into Programs / Examples / Apps, and still labels a single kind', () => {
  const game = { name: 'game', kind: 'project' };
  const border = { name: 'border', kind: 'example' };
  const studio = { name: '@8bitscript/studio', kind: 'app' };
  assert.deepEqual(
    byKind([studio, border, game]).map((s) => [s.kind, s.label, s.projects.map((p) => p.name)]),
    [
      ['project', 'Programs', ['game']],
      ['example', 'Examples', ['border']],
      ['app', 'Apps', ['@8bitscript/studio']],
    ],
  );
  assert.deepEqual(byKind([studio, border]).map((s) => s.kind), ['example', 'app'], 'only the kinds present');
  assert.deepEqual(byKind([game]).map((s) => [s.kind, s.label]), [['project', 'Programs']]);
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
  const bunny = path.join(root, 'bunny');
  fs.mkdirSync(bunny, { recursive: true });
  write(path.join(bunny, 'bun.lock'), '');
  assert.equal(packageManagerFor(bunny), 'bun');
  fs.rmSync(path.join(bunny, 'bun.lock'));
  write(path.join(bunny, 'bun.lockb'), '');
  assert.equal(packageManagerFor(bunny), 'bun', 'the binary lockfile too');
});

function fakeBin(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return file;
}

test('resolvePackageManager finds pnpm where the installer puts it, not only on PATH', (t) => {
  const home = scratch(t);
  const pnpm = fakeBin(path.join(home, '.local', 'share', 'pnpm', 'bin'), 'pnpm');
  assert.equal(
    resolvePackageManager('pnpm', { env: { PATH: '/usr/bin' }, home }),
    pnpm,
  );
});

test('resolvePackageManager finds pnpm in ~/Library/pnpm/bin on macOS', (t) => {
  const home = scratch(t);
  const pnpm = fakeBin(path.join(home, 'Library', 'pnpm', 'bin'), 'pnpm');
  assert.equal(
    resolvePackageManager('pnpm', { env: { PATH: '/usr/bin' }, home, platform: 'darwin' }),
    pnpm,
  );
});

test('resolvePackageManager does not invent a macOS Library path on linux', (t) => {
  const home = scratch(t);
  fakeBin(path.join(home, 'Library', 'pnpm', 'bin'), 'pnpm');
  assert.equal(
    resolvePackageManager('pnpm', { env: { PATH: '/usr/bin' }, home, platform: 'linux' }),
    'pnpm',
  );
});

test('resolvePackageManager prefers a command already on PATH', (t) => {
  const root = scratch(t);
  const onPath = fakeBin(path.join(root, 'bin'), 'pnpm');
  fakeBin(path.join(root, 'home', '.local', 'share', 'pnpm', 'bin'), 'pnpm');
  assert.equal(
    resolvePackageManager('pnpm', { env: { PATH: path.dirname(onPath) }, home: path.join(root, 'home') }),
    onPath,
  );
});

test('resolvePackageManager honors PNPM_HOME when PATH is empty', (t) => {
  const home = scratch(t);
  const pnpmHome = path.join(home, 'pnpm-home');
  const pnpm = fakeBin(path.join(pnpmHome, 'bin'), 'pnpm');
  assert.equal(
    resolvePackageManager('pnpm', { env: { PATH: '', PNPM_HOME: pnpmHome }, home }),
    pnpm,
  );
});

test('resolvePackageManager keeps the bare name when nothing is found', () => {
  assert.equal(
    resolvePackageManager('pnpm', { env: { PATH: '' }, home: '/no-such-home' }),
    'pnpm',
  );
});

test('packageManagerPath includes an nvm node bin so lifecycle scripts can find node', (t) => {
  const home = scratch(t);
  const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v26.7.0', 'bin');
  fs.mkdirSync(nvmBin, { recursive: true });
  const search = packageManagerPath({ PATH: '/usr/bin' }, home);
  assert.ok(search.split(path.delimiter).includes(nvmBin));
});

test('packageManagerPath appends well-known bins after PATH', (t) => {
  const home = scratch(t);
  const extra = path.join(home, '.local', 'share', 'pnpm', 'bin');
  fs.mkdirSync(extra, { recursive: true });
  const search = packageManagerPath({ PATH: '/usr/bin' }, home);
  assert.ok(search.startsWith(`/usr/bin${path.delimiter}`));
  assert.ok(search.split(path.delimiter).includes(extra));
});

const ELECTRON = {
  execPath: '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)',
  versions: { electron: '42.10.0' },
};

function writeFakeNode(home) {
  const dir = path.join(home, '.local', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const node = path.join(dir, 'node');
  fs.writeFileSync(node, '');
  fs.chmodSync(node, 0o755);
  return node;
}

test('nodeCommand: plain Node uses execPath', () => {
  const runtime = { execPath: '/usr/bin/node', versions: {} };
  assert.equal(nodeCommand({ PATH: '' }, '/no-such-home', runtime), '/usr/bin/node');
});

test('nodeCommand: Electron finds node on the install PATH, not the helper', (t) => {
  const home = scratch(t);
  const node = writeFakeNode(home);
  assert.equal(nodeCommand({ PATH: '' }, home, ELECTRON), node);
});

test('cliCommand: a bin is the bin; a .mjs under Node is execPath', () => {
  assert.deepEqual(cliCommand('/proj/node_modules/.bin/8bs'), {
    command: '/proj/node_modules/.bin/8bs',
    args: [],
  });
  const runtime = { execPath: '/usr/bin/node', versions: {} };
  assert.deepEqual(
    cliCommand('/checkout/packages/cli/bin/8bs.mjs', { runtime }),
    { command: '/usr/bin/node', args: ['/checkout/packages/cli/bin/8bs.mjs'] },
  );
});

test('cliCommand: Electron does not spawn the helper when node is on PATH', (t) => {
  const home = scratch(t);
  const node = writeFakeNode(home);
  const result = cliCommand('/checkout/packages/cli/bin/8bs.mjs', {
    env: { PATH: '' },
    home,
    runtime: ELECTRON,
  });
  assert.deepEqual(result, { command: node, args: ['/checkout/packages/cli/bin/8bs.mjs'] });
  assert.equal(result.env, undefined);
});

test('cliCommand: Electron without node still sets ELECTRON_RUN_AS_NODE', () => {
  const result = cliCommand('/checkout/packages/cli/bin/8bs.mjs', {
    searchPath: '/no-such-bin',
    runtime: ELECTRON,
  });
  assert.equal(result.command, ELECTRON.execPath);
  assert.deepEqual(result.env, { ELECTRON_RUN_AS_NODE: '1' });
});

// Writing a system into an 8bitscript.config.8bs. The config is source, not a
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

// ---- several programs: which one Run and Build act on -----------------------

const LAB_CONFIG = `export default {
  baseline: 'c64',
  programs: {
    main: { entry: 'src/lobby/main.8bs' },
    'hello-reels': { entry: 'src/labs/hello-reels/main.8bs' },
    'tiny-slot': { entry: 'src/labs/tiny/main.8bs', targets: ['pet', 'vic20'] },
    'wide-slot': { entry: 'src/labs/wide/main.8bs', targets: { c64: {}, cx16: {} } },
  },
  targets: ['pet', 'vic20', 'c64', 'cx16', 'web'],
};`;

test('parseConfig reads a program\'s own targets, in either spelling, and leaves the project\'s alone', () => {
  const { targets, programs } = parseConfig(LAB_CONFIG);
  assert.deepEqual(targets, ['pet', 'c64', 'vic20', 'cx16', 'web'], 'the project\'s targets are not the programs\' ones');
  assert.deepEqual(programs.map((p) => [p.name, p.targets]), [
    ['main', null],
    ['hello-reels', null],
    ['tiny-slot', ['pet', 'vic20']],
    ['wide-slot', ['c64', 'cx16']],
  ]);
});

test('a program that names no machine this extension knows has no list of its own', () => {
  const { programs } = parseConfig(`export default { programs: { a: { entry: 'a.8bs', targets: ['atari9000'] } } };`);
  assert.equal(programs[0].targets, null);
});

function labProject() {
  const { targets, programs } = parseConfig(LAB_CONFIG);
  return { targets, programs: programs.map((p) => ({ ...p, entry: `/p/${p.entry}` })) };
}

test('hasSeveralPrograms: one program (or none) needs no --program', () => {
  assert.equal(hasSeveralPrograms(labProject()), true);
  assert.equal(hasSeveralPrograms({ programs: [{ name: 'main' }] }), false);
  assert.equal(hasSeveralPrograms({}), false);
  assert.equal(hasSeveralPrograms(null), false);
});

test('resolveProgram: the chosen one, else main, else nothing to guess — and null when there is only one', () => {
  const project = labProject();
  assert.equal(resolveProgram(project, 'hello-reels'), 'hello-reels');
  assert.equal(resolveProgram(project, undefined), 'main');
  assert.equal(resolveProgram(project, 'gone'), 'main', 'a choice the config no longer has falls back, never passes a name the CLI would refuse');
  const noMain = { targets: ['c64'], programs: [{ name: 'a' }, { name: 'b' }] };
  assert.equal(resolveProgram(noMain, undefined), null, 'several programs and no main: the caller must ask');
  assert.equal(resolveProgram(noMain, 'b'), 'b');
  assert.equal(resolveProgram({ programs: [{ name: 'only' }] }, 'only'), null);
});

test('programTargets narrows the project\'s machines to the program\'s own, in the project\'s order', () => {
  const project = labProject();
  assert.deepEqual(programTargets(project, 'tiny-slot'), ['pet', 'vic20']);
  assert.deepEqual(programTargets(project, 'wide-slot'), ['c64', 'cx16']);
  assert.deepEqual(programTargets(project, 'hello-reels'), project.targets, 'no list of its own: the project\'s');
  assert.deepEqual(programTargets(project, null), project.targets);
  assert.deepEqual(programTargets(project, 'nope'), project.targets);
  const narrow = { targets: ['c64'], programs: [{ name: 'x', targets: ['pet', 'c64'] }] };
  assert.deepEqual(programTargets(narrow, 'x'), ['c64'], 'a program cannot add a machine the project does not target');
});

test('commandArgs names the program for run and build — not for boot, which loads nothing', () => {
  assert.deepEqual(commandArgs('run', 'c64', 'ntsc', undefined, { program: 'hello-reels' }),
    ['run', 'c64', '--program', 'hello-reels', '--size']);
  assert.deepEqual(commandArgs('build', 'pet', 'ntsc', undefined, { program: 'tiny-slot' }),
    ['build', '--target', 'pet', '--program', 'tiny-slot', '--size']);
  assert.deepEqual(commandArgs('run', 'c64', 'ntsc', undefined, { system: 'Named', program: 'main' }),
    ['run', '--system', 'Named', '--program', 'main', '--size']);
  assert.deepEqual(commandArgs('boot', 'c64', 'ntsc', undefined, { program: 'main' }), ['boot', 'c64']);
  assert.deepEqual(commandArgs('run', 'c64', 'ntsc', undefined, {}), ['run', 'c64', '--size'], 'no program named: the CLI\'s own default');
});
