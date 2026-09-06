// Studio ships with the toolchain, so its tests hold it to the rules that
// implies: its version is the library's, every target links it clean, and
// each machine starts from the tier main.8bs picks for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { loadCatalog, resolveHardware, stockFacts } from '../../cli/src/hardware.mjs';

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
    const { ir, diagnostics } = link(readFileSync(ENTRY, 'utf8'), ENTRY, { machine: target, facts: stockFacts(target) });
    assert.deepEqual(diagnostics, []);
    assert.equal(ir.entry, 'main');
  });
}

// Which tier main() hands studio.start() on a machine, read off the linked
// IR: the facts and the Tier names fold to constants, so every test in the
// if-chain is a comparison, a negation or a combination of folded
// constants, which this walks the way the machine would. One entry file,
// and the machine's facts pick the tier.
const TIERS = ['VIEWER', 'BASIC', 'FULL'];
const value = (expr) => {
  assert.equal(expr.kind, 'const', `not folded to a constant: ${JSON.stringify(expr)}`);
  return expr.value;
};
const truthy = (expr) => {
  if (expr.kind === 'const') return expr.value !== 0;
  if (expr.kind === 'unop' && expr.operator === '!') return !truthy(expr.argument);
  if (expr.kind === 'binop') {
    switch (expr.operator) {
      case '&&': return truthy(expr.left) && truthy(expr.right);
      case '||': return truthy(expr.left) || truthy(expr.right);
      case '==': return value(expr.left) === value(expr.right);
      case '!=': return value(expr.left) !== value(expr.right);
      case '<': return value(expr.left) < value(expr.right);
      case '<=': return value(expr.left) <= value(expr.right);
      case '>': return value(expr.left) > value(expr.right);
      case '>=': return value(expr.left) >= value(expr.right);
      default: break;
    }
  }
  assert.fail(`a test main.8bs is not expected to have: ${JSON.stringify(expr)}`);
};
const tierOf = (target, facts = stockFacts(target)) => {
  const { ir, diagnostics } = link(readFileSync(ENTRY, 'utf8'), ENTRY, { machine: target, facts });
  assert.deepEqual(diagnostics, [], target);
  const main = ir.functions.find((f) => f.name === 'main');
  let tier;
  const run = (statements) => {
    for (const s of statements) {
      if (s.kind === 'local' && s.name === 'tier') tier = s.init.value;
      if (s.kind === 'assign' && s.target === 'tier') tier = s.value.value;
      if (s.kind === 'if') run(truthy(s.test) ? s.then : s.else ?? []);
    }
  };
  run(main.body);
  return TIERS[tier];
};

// The sheet a build gets when hardware is chosen for it — `8bs build vic20
// --profile 8k` — so a tier can be asserted for a fitted machine and not
// only for the stock one.
const factsWith = (machine, profile) => {
  const resolved = resolveHardware(loadCatalog(machine), { profile });
  assert.ok(resolved.ok, `${machine} --profile ${profile}: ${resolved.error}`);
  return resolved.hardware.facts;
};

test('each machine starts from the tier its facts pick', () => {
  // No keyboard to edit with: the NES, and the web until its runtime reads keys.
  assert.equal(tierOf('nes'), 'VIEWER');
  assert.equal(tierOf('web'), 'VIEWER');
  // A keyboard, but 3583 bytes to live in: read-only until the machine is expanded.
  assert.equal(tierOf('vic20'), 'VIEWER');
  // A keyboard and 31743 bytes, and nothing an editor could change: the PET's
  // font is in ROM, it has no sprites, and its one voice plays but does not
  // compose. RAM is not the PET's gate, so no expansion lifts it.
  assert.equal(tierOf('pet'), 'VIEWER');
  for (const target of ['c64', 'c128', 'atari8', 'cx16', 'mega65']) assert.equal(tierOf(target), 'FULL', target);
});

test('a RAM expansion lifts the VIC-20 to the basic tier; nothing lifts the PET', () => {
  // The catalog's own presets, resolved the way `8bs build --profile` does.
  assert.equal(tierOf('vic20', factsWith('vic20', 'unexpanded')), 'VIEWER'); // 3583 bytes
  assert.equal(tierOf('vic20', factsWith('vic20', '3k')), 'VIEWER');         // 6655, still under the budget
  assert.equal(tierOf('vic20', factsWith('vic20', '8k')), 'BASIC');          // 11775: characters and music edit
  assert.equal(tierOf('vic20', factsWith('vic20', '16k')), 'BASIC');
  assert.equal(tierOf('vic20', factsWith('vic20', '24k')), 'BASIC');
  // Every PET model, from the 8K 3008 to the 32K 8032, is a viewer.
  for (const model of ['3008', '3016', '3032', '4016', '4032', '8032']) {
    assert.equal(tierOf('pet', factsWith('pet', model)), 'VIEWER', model);
  }
});

test('the tier follows the facts, not the name: a machine with no facts is the placeholder sheet', () => {
  const { diagnostics } = link(readFileSync(ENTRY, 'utf8'), ENTRY, { machine: 'c64' });
  assert.ok(diagnostics.some((d) => d.code === '8BS1038'), 'a real build without its sheet is refused, not guessed');
});

test('Studio has one entry file: no main.<target>.8bs variants', () => {
  for (const target of TARGETS) assert.ok(!existsSync(join(SRC, `main.${target}.8bs`)), target);
});
