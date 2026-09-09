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

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const cli = JSON.parse(readFileSync(join(ROOT, '..', 'cli', 'package.json'), 'utf8'));
const examples = pkg['8bitscript'].examples;

// Which machines the example's 8bs.config.ts lists: the keys of its
// `targets` object. Read the same way the editor reads it, as text.
const targetsOf = (dir) => {
  const config = readFileSync(join(dir, '8bs.config.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
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
  return [...body.matchAll(/(\w+):\s*\{/g)].map((m) => m[1]);
};

test('the manifest lists hello-world, a directory with a real project in it', () => {
  assert.deepEqual(Object.keys(examples), ['hello-world']);
  for (const [name, entry] of Object.entries(examples)) {
    assert.equal(typeof entry.title, 'string', `${name}: title`);
    assert.equal(typeof entry.description, 'string', `${name}: description`);
    const dir = resolve(ROOT, entry.dir);
    assert.ok(existsSync(join(dir, '8bs.config.ts')), `${name}: 8bs.config.ts`);
    assert.ok(existsSync(join(dir, 'src', 'main.8bs')), `${name}: src/main.8bs`);
  }
});

test('the CLI depends on the examples, so they ship with the toolchain', () => {
  assert.equal(cli.dependencies['@8bitscript/examples'], 'workspace:*');
  assert.equal(pkg.version, cli.version, 'one version across the workspace');
});

test('hello-world targets the PET and the web', () => {
  assert.deepEqual(targetsOf(resolve(ROOT, examples['hello-world'].dir)), ['pet', 'web']);
});

for (const target of ['pet', 'web']) {
  test(`hello-world links clean for ${target}`, () => {
    const main = join(ROOT, 'hello-world', 'src', 'main.8bs');
    const { ir, diagnostics } = link(readFileSync(main, 'utf8'), main, { machine: target, facts: stockFacts(target) });
    assert.deepEqual(diagnostics, []);
    assert.equal(ir.entry, 'main');
  });
}
