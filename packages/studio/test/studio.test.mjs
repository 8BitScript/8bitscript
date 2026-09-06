// Studio ships with the toolchain, so its tests hold it to the rules that
// implies: its version is the library's, every target links it clean, and
// each machine starts from the tier main.8bs picks for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const cli = JSON.parse(readFileSync(join(ROOT, '..', 'cli', 'package.json'), 'utf8'));

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

const ENTRY = join(SRC, 'main.8bs');

test('Studio declares itself an app, with a title and the shared entry', () => {
  assert.equal(pkg['8bitscript'].app.title, 'Studio');
  assert.equal(pkg['8bitscript'].app.entry, './src/main.8bs');
  assert.ok(existsSync(join(ROOT, '8bs.config.ts')), 'an app is a project: it has the manifest the CLI reads');
});

test("Studio's version is the toolchain's version, in package.json and on screen", () => {
  assert.equal(pkg.version, cli.version, '@8bitscript/studio and @8bitscript/cli share one version');
  const source = readFileSync(join(SRC, 'studio.8bs'), 'utf8');
  assert.match(source, new RegExp(`const VERSION: string = "${pkg.version.replace(/\\./g, '\\\\.')}";`),
    'the VERSION literal Studio prints must be package.json\'s version');
});

test('the CLI depends on Studio, so it ships with the toolchain', () => {
  assert.equal(cli.dependencies['@8bitscript/studio'], 'workspace:*');
});

for (const target of TARGETS) {
  test(`Studio links clean for ${target}`, () => {
    const { ir, diagnostics } = link(readFileSync(ENTRY, 'utf8'), ENTRY, { machine: target });
    assert.deepEqual(diagnostics, []);
    assert.equal(ir.entry, 'main');
  });
}

// Which tier main() hands studio.start() on a machine, read off the linked
// IR: System.CURRENT and the Tier names are consts, so every test in the
// if-chain is a comparison of two folded numbers, which this walks the way
// the machine would. One entry file, and the machine picks the tier.
const TIERS = ['VIEWER', 'BASIC', 'FULL'];
const tierOf = (target) => {
  const { ir } = link(readFileSync(ENTRY, 'utf8'), ENTRY, { machine: target });
  const main = ir.functions.find((f) => f.name === 'main');
  let tier;
  const run = (statements) => {
    for (const s of statements) {
      if (s.kind === 'local' && s.name === 'tier') tier = s.init.value;
      if (s.kind === 'assign' && s.target === 'tier') tier = s.value.value;
      if (s.kind === 'if') {
        const { left, right, operator } = s.test;
        assert.equal(operator, '==');
        assert.equal(left.kind, 'const');
        assert.equal(right.kind, 'const');
        run(left.value === right.value ? s.then : s.else ?? []);
      }
    }
  };
  run(main.body);
  return TIERS[tier];
};

test('each machine starts from the tier main.8bs picks for it', () => {
  assert.equal(tierOf('nes'), 'VIEWER');
  assert.equal(tierOf('vic20'), 'BASIC');
  assert.equal(tierOf('pet'), 'BASIC');
  for (const target of ['c64', 'c128', 'atari8', 'cx16', 'mega65', 'web']) assert.equal(tierOf(target), 'FULL', target);
});

test('Studio has one entry file: no main.<target>.8bs variants', () => {
  for (const target of TARGETS) assert.ok(!existsSync(join(SRC, `main.${target}.8bs`)), target);
});
