import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dumpDirOf, dumpFrontend, findSources, frontendOf, rootsFor } from './frontend.mjs';

// Real in-repo source, so the tests do not carry syntax of their own.
const SOURCE = readFileSync(new URL('../../packages/examples/fancy/src/main.8bs', import.meta.url), 'utf8');
const BROKEN = '}}}}\n)))\n';
const GRAPHICS = readFileSync(new URL('../../packages/studio/src/mark.8bg', import.meta.url), 'utf8');

function put(file, text) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

function treeOf(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const next = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, next);
      else out[next] = readFileSync(path, 'utf8');
    }
  };
  walk(root, '');
  return out;
}

test('findSources lists the four source kinds, sorted, outside node_modules, dist and .git', () => {
  const base = mkdtempSync(join(tmpdir(), 'frontend-test-'));
  try {
    for (const rel of ['b.8bs', 'a/x.8bx', 'a/y.8bg', 'a/z.8ba', 'a/node_modules/n.8bs', 'dist/d.8bs', '.git/g.8bs', 'a/readme.md']) {
      put(join(base, rel), '');
    }
    assert.deepEqual(findSources(base).map((f) => f.slice(base.length + 1)), ['a/x.8bx', 'a/y.8bg', 'a/z.8ba', 'b.8bs']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a text file dumps tokens, a tree taken before bind, and its diagnostics', () => {
  const stages = frontendOf('/r/p/src/main.8bs', SOURCE, { project: '/r/p' });
  assert.ok(stages.tokens.startsWith('[\n'));
  assert.match(stages.tokens, /"kind": "keyword"/);
  assert.match(stages.ast, /"type"/);
  assert.equal(stages.diagnostics, '[]\n');
  assert.deepEqual(frontendOf('/r/p/src/main.8bs', SOURCE, { project: '/r/p' }), stages);
});

test('a syntax error is a diagnostic, not a failure', () => {
  const stages = frontendOf('/r/p/src/bad.8bs', BROKEN, { project: '/r/p' });
  assert.match(stages.diagnostics, /"severity": "error"/);
});

test('a media file dumps tokens and diagnostics but no tree', () => {
  const stages = frontendOf('/r/p/src/mark.8bg', GRAPHICS, { project: '/r/p' });
  assert.equal(stages.ast, null);
  assert.ok(stages.tokens.startsWith('['));
  assert.ok(stages.diagnostics.startsWith('['));
});

test('the dump directory follows the tokenized path, and a modules directory is refused', () => {
  const roots = { toolchain: '/r/tc', project: '/r/pj' };
  assert.equal(dumpDirOf('/r/tc/packages/c64/src/index.8bs', roots), join('fe', 'toolchain', 'packages', 'c64', 'src', 'index.8bs'));
  assert.equal(dumpDirOf('/r/pj/src/main.8bs', roots), join('fe', 'project', 'src', 'main.8bs'));
  assert.throws(() => dumpDirOf('/r/pj/modules/m.8bs', roots), /"modules"/);
});

test('the same sources at two paths give identical front-end trees, and two runs are identical', () => {
  const base = mkdtempSync(join(tmpdir(), 'frontend-test-'));
  try {
    const trees = [];
    for (const name of ['one', join('deeper', 'two')]) {
      const project = join(base, name);
      put(join(project, 'src', 'main.8bs'), SOURCE);
      put(join(project, 'src', 'bad.8bs'), BROKEN);
      put(join(project, 'src', 'mark.8bg'), GRAPHICS);
      const out = join(base, `out-${trees.length}`);
      mkdirSync(join(base, 'tc'), { recursive: true });
      const roots = rootsFor(join(base, 'tc'), project);
      const written = dumpFrontend([{ files: findSources(join(project, 'src')), roots }], out);
      assert.equal(written, 8);
      trees.push(treeOf(out));
    }
    assert.deepEqual(trees[0], trees[1]);
    assert.deepEqual(Object.keys(trees[0]).filter((k) => k.includes('main.8bs')), [
      'fe/project/src/main.8bs/ast.json',
      'fe/project/src/main.8bs/diagnostics.json',
      'fe/project/src/main.8bs/tokens.json',
    ]);
    assert.ok(!JSON.stringify(trees[0]).includes(base));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
