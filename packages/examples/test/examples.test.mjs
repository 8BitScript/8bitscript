// The examples ship with the toolchain, so they are held to the same rules
// Studio is: the manifest names real projects, the CLI depends on the
// package, and every example links clean for each machine it targets. No
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

// Which machines each example's 8bs.config.ts lists: the keys of its
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

test('the manifest lists hello-raw and hello, each a directory with a project in it', () => {
  assert.deepEqual(Object.keys(examples), ['hello-raw', 'hello']);
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

test('hello-raw targets the PET only; hello targets the PET and the web', () => {
  assert.deepEqual(targetsOf(resolve(ROOT, examples['hello-raw'].dir)), ['pet']);
  assert.deepEqual(targetsOf(resolve(ROOT, examples.hello.dir)), ['pet', 'web']);
});

for (const [name, entry] of Object.entries(examples)) {
  const dir = resolve(ROOT, entry.dir);
  const main = join(dir, 'src', 'main.8bs');
  for (const target of targetsOf(dir)) {
    test(`${name} links clean for ${target}`, () => {
      const { ir, diagnostics } = link(readFileSync(main, 'utf8'), main, { machine: target, facts: stockFacts(target) });
      assert.deepEqual(diagnostics, []);
      assert.equal(ir.entry, 'main');
    });
  }
}

test('hello-raw is eleven memoryWrite statements and nothing else', () => {
  const main = join(ROOT, 'hello-raw', 'src', 'main.8bs');
  const { ir, diagnostics } = link(readFileSync(main, 'utf8'), main, { machine: 'pet', facts: stockFacts('pet') });
  assert.deepEqual(diagnostics, []);
  const body = ir.functions.find((f) => f.name === 'main').body;
  assert.equal(body.length, 11);
  assert.ok(body.every((s) => s.kind === 'memoryWrite'), JSON.stringify(body.map((s) => s.kind)));
  // H E L L O _ W O R L D, as PET screen codes, at $8000 onward.
  const codes = [8, 5, 12, 12, 15, 32, 23, 15, 18, 12, 4];
  body.forEach((s, i) => {
    assert.equal(s.address.value, 0x8000 + i, `cell ${i}`);
    assert.equal(s.value.value, codes[i], `code ${i}`);
  });
});
