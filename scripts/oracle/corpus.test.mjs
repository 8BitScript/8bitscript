import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildsOf, builtPath, clearDumps, dumpArgs, findGit, findProjects, formatSha, parseArgs, requireBuilds, selectProjects, sha256Of,
} from './corpus.mjs';

function touch(file) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '');
}

test('enumeration finds a two-project fixture and skips node_modules and dist', () => {
  const base = mkdtempSync(join(tmpdir(), 'corpus-test-'));
  try {
    touch(join(base, 'zeta', '8bitscript.config.ts'));
    touch(join(base, 'examples', 'alpha', '8bitscript.config.8bs'));
    touch(join(base, 'examples', 'alpha', 'node_modules', 'dep', '8bitscript.config.8bs'));
    touch(join(base, 'examples', 'alpha', 'dist', '8bitscript.config.8bs'));
    touch(join(base, 'plain', 'package.json'));
    const found = findProjects(base);
    assert.deepEqual(found.map((p) => p.id), ['examples/alpha', 'zeta']);
    assert.equal(found[0].dir, join(base, 'examples', 'alpha'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('builds are the program by target pairs of the project description', () => {
  const info = {
    programs: [
      { name: 'main', targets: ['pet', 'c64'] },
      { name: 'extra', targets: ['web'] },
      { name: 'none' },
    ],
  };
  assert.deepEqual(buildsOf(info), [
    { program: 'main', target: 'pet' },
    { program: 'main', target: 'c64' },
    { program: 'extra', target: 'web' },
  ]);
});

test('the built file comes from the built line', () => {
  assert.equal(builtPath('built /tmp/p/dist/a.prg\nmemory: 1 bytes\n'), '/tmp/p/dist/a.prg');
  assert.equal(builtPath('memory: 1 bytes\n'), null);
});

test('sha256.txt is sorted by id with an ordinal compare', () => {
  const text = formatSha([
    { id: 'b/x/c64', sha: sha256Of('2') },
    { id: 'B/x/c64', sha: sha256Of('1') },
  ]);
  assert.equal(text, `${sha256Of('1')}  B/x/c64\n${sha256Of('2')}  b/x/c64\n`);
});

test('arguments need --out and reject unknown flags', () => {
  assert.throws(() => parseArgs([]), /--out/);
  assert.throws(() => parseArgs(['--out', 'x', '--bogus']), /unknown argument/);
  assert.equal(parseArgs(['--sha-only', '--out', 'x', '--jobs', '2']).jobs, 2);
});

test('a project with no builds, or an --only that matches nothing, is an error', () => {
  assert.throws(() => requireBuilds({ id: 'p' }, { programs: [{ name: 'main', targets: [] }] }), /p: .*no programs/);
  assert.equal(requireBuilds({ id: 'p' }, { programs: [{ name: 'm', targets: ['c64'] }] }).length, 1);
  const projects = [{ id: 'a/one' }, { id: 'b/two' }];
  assert.deepEqual(selectProjects(projects, 'two'), [{ id: 'b/two' }]);
  assert.equal(selectProjects(projects, null).length, 2);
  assert.throws(() => selectProjects(projects, 'nope'), /matches no project/);
});

test('git comes from a fixed list and a missing git is a clear error', () => {
  assert.equal(findGit(['/a/git', '/b/git'], (f) => f === '/b/git'), '/b/git');
  assert.throws(() => findGit(['/a/git'], () => false), /git not found in \/a\/git/);
});

test('--dump is a mode of its own: it is parsed, and it excludes --sha-only', () => {
  assert.equal(parseArgs(['--out', 'x']).dump, false);
  assert.equal(parseArgs(['--dump', '--out', 'x']).dump, true);
  assert.throws(() => parseArgs(['--dump', '--sha-only', '--out', 'x']), /exclude each other/);
});

test('build arguments carry --dump-stages only when a directory is given', () => {
  assert.deepEqual(dumpArgs('/o/p/main/pet'), ['--dump-stages', '/o/p/main/pet']);
  assert.deepEqual(dumpArgs(null), []);
});

test('clearing dumps removes the selected projects and, when asked, the front end, and nothing else', () => {
  const out = mkdtempSync(join(tmpdir(), 'corpus-test-'));
  try {
    for (const rel of ['a/one/old.txt', 'b/keep.txt', 'fe/x/tokens.json']) touch(join(out, rel));
    clearDumps(out, [{ id: 'a/one' }], false);
    assert.deepEqual([existsSync(join(out, 'a/one')), existsSync(join(out, 'fe'))], [false, true]);
    clearDumps(out, [], true);
    assert.deepEqual([existsSync(join(out, 'fe')), existsSync(join(out, 'b/keep.txt'))], [false, true]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
