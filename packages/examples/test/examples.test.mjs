// The examples ship with the toolchain, so they are held to the same rules
// Studio is: the manifest names a real project, the CLI depends on the
// package, and the program links clean for every machine it targets. No
// build is attempted — the native backend is what 0.2.0 is building — so
// linking clean is the whole promise the front end can make today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link, RELEASE_MACHINES } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';
import { releaseTargets } from '../shared-release-targets.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHECKOUT = join(HERE, '..', '..', '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const cli = JSON.parse(readFileSync(join(ROOT, '..', 'cli', 'package.json'), 'utf8'));
const examples = pkg['8bitscript'].examples;

// 8bitscript.config.ts is the current name and 8bs.config.ts the older
// one, in the same precedence the CLI's own loader uses
// (packages/cli/src/config.mjs) — an example may be written either way.
const CONFIG_FILENAMES = ['8bitscript.config.ts', '8bs.config.ts'];
const configPathOf = (dir) => {
  const found = CONFIG_FILENAMES.map((name) => join(dir, name)).find((path) => existsSync(path));
  assert.ok(found, `${dir}: no ${CONFIG_FILENAMES.join(' or ')}`);
  return found;
};

// The example's own entry file, from its config's `entry:` field — not
// assumed to be `main.8bs`, since hello-world's is `hello-world.8bs`.
const entryOf = (dir) => {
  const config = readFileSync(configPathOf(dir), 'utf8').replace(/\/\/[^\n]*/g, '');
  const match = /entry:\s*['"]([^'"]+)['"]/.exec(config);
  assert.ok(match, `${dir}: no entry field`);
  return join(dir, match[1]);
};

// Which machines the example's config lists: the keys of its `targets`
// object. Read the same way the editor reads it, as text.
const targetsOf = (dir) => {
  const config = readFileSync(configPathOf(dir), 'utf8').replace(/\/\/[^\n]*/g, '');
  if (/targets:\s*releaseTargets\b/.test(config)) {
    return Object.keys(releaseTargets);
  }
  if (/releaseTargets\.(pet|c64|vic20|cx16|web)/.test(config)) {
    return Object.keys(releaseTargets);
  }
  const start = config.indexOf('targets:');
  assert.ok(start >= 0, `${dir}: no targets block`);
  // Balance braces from the opening one, since a target's own value (`{}`)
  // nests inside the block a naive non-greedy match would stop short at.
  const open = config.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < config.length; end++) {
    if (config[end] === '{') depth++;
    else if (config[end] === '}' && --depth === 0) break;
  }
  const body = config.slice(open + 1, end);
  // Only the targets object's own keys. A value like
  // `{ hardware: { model: '3032' } }` also contains `{`, so a naive
  // `/(\w+):\s*\{/` would report `hardware` as a target.
  return [...body.matchAll(/(\w+):\s*\{/g)].flatMap((m) => {
    let depth = 0;
    for (let i = 0; i < m.index; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') depth--;
    }
    return depth === 0 ? [m[1]] : [];
  });
};

test('the manifest lists every example, each a directory with a real project in it', () => {
  assert.deepEqual(Object.keys(examples), ['hello-world', 'joystick', 'fancy', 'hello-bx', 'swarm', 'media-walk']);
  for (const [name, entry] of Object.entries(examples)) {
    assert.equal(typeof entry.title, 'string', `${name}: title`);
    assert.equal(typeof entry.description, 'string', `${name}: description`);
    const dir = resolve(ROOT, entry.dir);
    configPathOf(dir); // asserts the project has a config under either name

    assert.ok(existsSync(entryOf(dir)), `${name}: entry file`);
  }
});

test('the CLI depends on the examples, so they ship with the toolchain', () => {
  assert.equal(cli.dependencies['@8bitscript/examples'], 'workspace:*');
  assert.equal(pkg.version, cli.version, 'one version across the workspace');
});

// Every example shares the five release targets from shared-release-targets.ts
// (PET 4032 32K, stock C64, VIC-20 8K, CX16, web).
const RELEASE_FIVE = [...RELEASE_MACHINES];

for (const name of Object.keys(examples)) {
  test(`${name} targets every machine this release builds for`, () => {
    assert.deepEqual(targetsOf(resolve(ROOT, examples[name].dir)), RELEASE_FIVE);
  });

  for (const target of RELEASE_FIVE) {
    test(`${name} links clean for ${target}`, () => {
      const main = entryOf(resolve(ROOT, examples[name].dir));
      const { ir, diagnostics } = link(readFileSync(main, 'utf8'), main, { machine: target, facts: stockFacts(target), checkout: CHECKOUT });
      const errors = diagnostics.filter((d) => d.severity !== 'warning');
      assert.deepEqual(errors, []);
      assert.equal(ir.entry, 'main');
    });
  }
}

// joystick is the controller test app. The release PET is the 32K 4032 from
// shared-release-targets.ts; the unexpanded VIC-20 is 8K in that file too.
// `link` does not lay out an image, so this is not a size check — it is the
// guard that those budgets stay written down where someone changing the
// example will see them, next to the measured sizes in its README.
test('the release machines joystick claims still declare the budgets it was measured against', () => {
  assert.equal(stockFacts('pet')['memory.ram'], 3071, 'the stock PET 2001 is 4K, minus what BASIC keeps');
  assert.equal(stockFacts('vic20')['memory.ram'], 3583, 'the unexpanded VIC-20');
  assert.equal(releaseTargets.pet.hardware.model, '4032');
  assert.equal(releaseTargets.pet.hardware.ram, '32');
  assert.equal(releaseTargets.vic20.hardware.ram, '8k');
});

// The lamps are reverse video, never colour, because three of the nine
// targets have no per-cell colour at all (PET, Atari 8-bit, NES — see
// packages/ui/AGENTS.md). A future edit that moves the highlight into
// text.setColor would still build and still link, and would simply show
// nothing on those three; this is what notices.
test('joystick highlights with reverse video, not colour alone', () => {
  const main = readFileSync(join(ROOT, 'joystick', 'src', 'main.8bs'), 'utf8');
  assert.match(main, /text\.setReverse\(true\)/, 'a lit lamp is a reverse-video bar');
  const colourless = ['pet', 'atari8', 'nes'];
  for (const target of colourless) {
    assert.equal(stockFacts(target)['video.colorPerCell'], false, `${target} has no per-cell colour`);
  }
});

// fancy is the raster showpiece, and its whole effect sits behind
// #fact(video.raster) so the seven machines whose rasterline layers are
// zero-answer stubs fold it away to nothing. A future edit that drops the
// guard would still build and still link everywhere — the stubs are
// honest — and would simply stop being free on those seven; this is what
// notices. The fact's answers are pinned too, so a machine gaining or
// losing the capability shows up here, next to the example that assumes
// the split.
test('fancy keeps its raster effect behind #fact(video.raster)', () => {
  const main = readFileSync(join(ROOT, 'fancy', 'src', 'main.8bs'), 'utf8');
  assert.match(main, /#fact\(video\.raster\)/, 'the wobble is guarded by the capability fact');
  for (const target of ['c64', 'web']) {
    assert.equal(stockFacts(target)['video.raster'], true, `${target} answers the raster capability`);
  }
  for (const target of ['pet', 'vic20', 'cx16']) {
    assert.equal(stockFacts(target)['video.raster'], false, `${target} has no per-scanline hook`);
  }
});

test('the release targets fancy builds against include the 4032 PET and 8K VIC-20', () => {
  assert.equal(releaseTargets.pet.hardware.model, '4032');
  assert.equal(releaseTargets.vic20.hardware.ram, '8k');
});
