import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEnv, parseArgs, ROOT } from '../corpus.mjs';
import { TAPPED, resolve } from './hooks.mjs';
import { encodeGraph, noteBound, record, rootsFrom, tapped, tappedBindImports, tokenize } from './tap.mjs';

const TAPPED_FNS = [
  'bind', 'bindImportedComponents', 'checkBx', 'elaborateBx', 'applyCatalogCharset', 'resolveCatalogSpecifier',
  'foldCompileTime', 'check', 'lower', 'findImports', 'pathFormSpecifiers', 'resolveSpecifier',
  'nativeSourcesBeside', 'scanDeclaredTypes', 'layoutTemplate', 'parseMediaModule', 'elaborateMedia',
];

function scratch() {
  return mkdtempSync(join(tmpdir(), 'front-tap-test-'));
}

function lines(dir) {
  return readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
}

const ident = (name, start) => ({ type: 'Identifier', start, length: name.length, name });

test('plain data: Map, Set, bytes, instances and strings under the roots', () => {
  class Box { constructor() { this.next = 3; this.gone = undefined; } }
  const roots = rootsFrom({ EIGHTBS_FRONT_TAP_ROOTS: JSON.stringify({ toolchain: '/t', project: '/t/p' }) });
  assert.equal(tokenize('/t/p/a.8bs and /t/b.8bs, /t/pq', roots), '<project>/a.8bs and <toolchain>/b.8bs, <toolchain>/pq');
  assert.deepEqual(rootsFrom({ EIGHTBS_FRONT_TAP_ROOTS: 'not json' }), []);
  assert.deepEqual(rootsFrom({}), []);
  const value = {
    map: new Map([['a', 1], ['b', new Set([2, 3])]]),
    bytes: new Uint8Array([1, 255]),
    box: new Box(),
    path: '/t/x',
    fn: function lookup() {},
    big: 7n,
  };
  assert.deepEqual(encodeGraph(value, { paths: roots }), {
    map: [['a', 1], ['b', [2, 3]]],
    bytes: [1, 255],
    box: { next: 3 },
    path: '<toolchain>/x',
    fn: { $fn: 'lookup' },
    big: { $bigint: '7' },
  });
});

test('a two-symbol cycle encodes as defined: ids by first encounter, nodes by pre-order index', () => {
  const a = ident('a', 0);
  const b = ident('b', 2);
  const decl = { type: 'VariableDeclaration', start: 0, length: 3, name: a, initializer: b };
  const ast = { type: 'Program', start: 0, length: 3, body: [decl] };
  const scope = { parent: null, symbols: new Map() };
  const sa = { name: 'a', kind: 'Variable', node: a, scope, declaration: decl };
  const sb = { name: 'b', kind: 'Import', node: b, scope, target: sa, component: null };
  sa.target = sb;
  scope.symbols.set('a', sa);
  scope.symbols.set('b', sb);
  const bound = { scopes: [scope], symbols: new Map([['a', sa], ['b', sb]]), imports: [sb], diagnostics: [], scopeOf: new Map([[decl, scope]]), file: 'x.8bs' };
  noteBound(bound, ast);
  const node = (n) => ({ $node: n });
  const symB = { $sym: 1, name: 'b', kind: 'Import', node: node(3), scope: { $scope: 0 }, target: { $sym: 0 }, component: null };
  // The scope is first met through `scopes`: its id is taken before its symbols are written,
  // so symbol a, written inside it, sees the scope as a bare reference, and so does symbol b.
  const symA = { $sym: 0, name: 'a', kind: 'Variable', node: node(2), scope: { $scope: 0 }, declaration: node(1), target: symB };
  const expected = {
    scopes: [{ $scope: 0, parent: null, symbols: [['a', symA], ['b', { $sym: 1 }]] }],
    symbols: [['a', { $sym: 0 }], ['b', { $sym: 1 }]],
    imports: [{ $sym: 1 }],
    diagnostics: [],
    scopeOf: [[node(1), { $scope: 0 }]],
    file: 'x.8bs',
  };
  assert.deepEqual(encodeGraph(bound), expected);
  // With the tree among the roots it is written out once, and the bound's nodes still point into it.
  const both = encodeGraph([ast, bound], { asts: [ast] });
  assert.equal(both[0].body[0].name.name, 'a');
  assert.deepEqual(both[1], expected);
  assert.deepEqual(encodeGraph([ast, ast], { asts: [ast] })[1], node(0));
});

test('a node no registered tree holds is written out in place, a cycle in plain objects is cut', () => {
  const loose = { type: 'Identifier', start: 1, length: 1, name: 'x' };
  assert.deepEqual(encodeGraph({ n: loose }), { n: loose });
  const loop = { name: 'loop' };
  loop.self = loop;
  assert.deepEqual(encodeGraph(loop), { name: 'loop', self: { $cycle: true } });
});

test('a tapped call records its arguments as they were before the call, the result and after', () => {
  const dir = scratch();
  try {
    const env = { EIGHTBS_FRONT_TAP: dir };
    const ast = { type: 'Program', start: 0, length: 0, body: [] };
    const real = (tree, file) => { tree.body.push(ident('z', 0)); return [file]; };
    const wrapped = tapped('f', real, { after: ([tree]) => tree }, env);
    assert.deepEqual(wrapped(ast, 'a.8bs'), ['a.8bs']);
    const [row] = lines(dir);
    assert.deepEqual(Object.keys(row), ['seq', 'fn', 'args', 'result', 'after']);
    assert.deepEqual(row.args[0].body, []);
    assert.deepEqual(row.result, ['a.8bs']);
    assert.equal(row.after.body.length, 1);
    assert.equal(row.fn, 'f');
    assert.equal(typeof row.seq, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a thrown error is recorded and rethrown', () => {
  const dir = scratch();
  try {
    const env = { EIGHTBS_FRONT_TAP: dir };
    const boom = tapped('boom', () => { throw new Error('nope'); }, {}, env);
    assert.throws(() => boom(1), /nope/);
    const [row] = lines(dir);
    assert.equal(row.throw, 'nope');
    assert.deepEqual(row.args, [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bindImportedComponents records what its lookup answered', () => {
  const dir = scratch();
  try {
    const env = { EIGHTBS_FRONT_TAP: dir };
    const real = (bound, lookup) => { bound.hit = lookup('./m.8bs'); };
    const other = { name: 'other' };
    const wrapped = tappedBindImports('bindImportedComponents', real, env);
    const bound = {};
    wrapped(bound, () => other);
    const [row] = lines(dir);
    assert.deepEqual(row.args, [{}, { lookups: [['./m.8bs', { name: 'other' }]] }]);
    assert.deepEqual(row.after, { hit: { name: 'other' } });
    assert.equal(bound.hit, other);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with the tap off a wrapped function is the real one and nothing is written', () => {
  const real = (x) => x + 1;
  assert.equal(tapped('f', real, {}, {})(1), 2);
  const calls = [];
  tappedBindImports('b', (...a) => calls.push(a), {})('x', 'y');
  assert.deepEqual(calls, [['x', 'y']]);
  assert.doesNotThrow(() => record('f', {}, {}));
});

test('the resolve hook swaps a tapped module for its shim, except for the shim itself', async () => {
  const real = new URL('../../../packages/compiler/src/media/index.mjs', import.meta.url).href;
  const next = async () => ({ url: real });
  const swapped = await resolve('./media/index.mjs', { parentURL: 'file:///other.mjs' }, next);
  assert.match(swapped.url, /front-tap\/shims\/media\.mjs$/);
  const kept = await resolve('x', { parentURL: swapped.url }, next);
  assert.equal(kept.url, real);
  const other = await resolve('y', { parentURL: 'file:///other.mjs' }, async () => ({ url: 'file:///elsewhere.mjs' }));
  assert.equal(other.url, 'file:///elsewhere.mjs');
  assert.equal(Object.keys(TAPPED).length, 10);
});

test('buildEnv and parseArgs carry the front tap, alone or with the mos tap', () => {
  const base = { A: '1', NODE_OPTIONS: '--no-warnings' };
  assert.equal(buildEnv(base, null, 'p/m/c64', { dir: '/p' }, null), base);
  const env = buildEnv(base, null, 'p/m/c64', { dir: '/p' }, '/ftap');
  assert.equal(env.EIGHTBS_FRONT_TAP, join('/ftap', 'p', 'm', 'c64'));
  assert.equal(env.EIGHTBS_MOS_TAP, undefined);
  assert.match(env.NODE_OPTIONS, /^--no-warnings --import=file:.*front-tap\/register\.mjs$/);
  assert.deepEqual(JSON.parse(env.EIGHTBS_FRONT_TAP_ROOTS), { toolchain: ROOT, project: '/p' });
  const both = buildEnv(base, '/mtap', 'p/m/c64', { dir: '/p' }, '/ftap');
  assert.match(both.NODE_OPTIONS, /mos-tap\/register\.mjs --import=file:.*front-tap\/register\.mjs$/);
  assert.equal(both.EIGHTBS_MOS_TAP, join('/mtap', 'p', 'm', 'c64'));
  assert.equal(parseArgs(['--out', 'o', '--front-tap', 'f']).frontTap, join(process.cwd(), 'f'));
  assert.equal(parseArgs(['--out', 'o']).frontTap, null);
});

const cli = join(ROOT, 'packages', 'cli', 'bin', '8bs.mjs');

function tappedBuild(example, dir) {
  const project = { dir: join(ROOT, 'packages', 'examples', example) };
  const build = (env) => execFileSync(process.execPath, [cli, 'build', '--target', 'c64'], { cwd: project.dir, env, encoding: 'utf8' });
  const plain = readFileSync(/^built (.+)$/m.exec(build(process.env))[1]);
  const out = build(buildEnv(process.env, null, `${example}/main/c64`, project, dir));
  assert.deepEqual(readFileSync(/^built (.+)$/m.exec(out)[1]), plain, 'the tap changed the build');
  return lines(join(dir, example, 'main', 'c64'));
}

function expectRecorded(rows, fns) {
  for (const fn of fns) {
    const row = rows.find((r) => r.fn === fn);
    assert.ok(row, `${fn} was not recorded`);
    assert.ok('args' in row && 'result' in row, `${fn} lacks args or result`);
  }
}

test('a project with a catalog and a template records applyCatalogCharset and layoutTemplate', () => {
  const dir = scratch();
  const tapDir = scratch();
  try {
    mkdirSync(join(dir, 'src', 'i18n'), { recursive: true });
    writeFileSync(join(dir, 'src', 'i18n', 'en.8bs'), 'export namespace Game { const NAME: string = "HELLO WORLD"; }\n');
    writeFileSync(join(dir, 'src', 'main.8bs'), [
      'import { screen } from "@8bitscript/screen";',
      'import { text } from "@8bitscript/text";',
      'import { Game } from "@8bitscript/i18n/catalog";',
      'export function main(): void {',
      '    let ticks: usmallint = 3;',
      '    screen.blank();',
      '    text.print(0, Game.NAME);',
      '    text.print(40, `TICK ${ticks:1}`);',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(dir, '8bitscript.config.8bs'), `export default ${JSON.stringify({
      entry: 'src/main.8bs',
      targets: { c64: {} },
      i18n: { defaultLocale: 'en', fallbackLocale: 'en', locales: ['en'] },
    })};\n`);
    const env = buildEnv(process.env, null, 'catalog/main/c64', { dir }, tapDir);
    execFileSync(process.execPath, [cli, 'build', '--target', 'c64', '--checkout', ROOT], { cwd: dir, env, encoding: 'utf8' });
    const rows = lines(join(tapDir, 'catalog', 'main', 'c64'));
    expectRecorded(rows, ['applyCatalogCharset', 'layoutTemplate']);
    assert.equal(rows.find((r) => r.fn === 'layoutTemplate').result !== undefined, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tapDir, { recursive: true, force: true });
  }
});

test('hello-world on c64 records the front end functions, and the build is unchanged', () => {
  const dir = scratch();
  try {
    const rows = tappedBuild('hello-world', dir);
    expectRecorded(rows, ['bind', 'bindImportedComponents', 'check', 'foldCompileTime', 'lower', 'findImports', 'pathFormSpecifiers', 'resolveSpecifier', 'nativeSourcesBeside', 'scanDeclaredTypes', 'resolveCatalogSpecifier']);
    const first = (fn) => rows.find((r) => r.fn === fn);
    assert.ok('after' in first('bindImportedComponents') && 'after' in first('foldCompileTime'));
    assert.equal(first('bind').result.file.endsWith('.8bs'), true);
    assert.ok(first('bind').result.scopes[0].$scope === 0);
    assert.equal(first('bind').args[0].type, 'Program');
    for (const row of rows) assert.ok(TAPPED_FNS.includes(row.fn), `${row.fn} is not a tapped function`);
    assert.ok(rows.every((r, i) => i === 0 || r.seq !== rows[i - 1].seq));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('media-walk on c64 records the .8bx and media functions, and two runs give the same records', () => {
  const [one, two] = [scratch(), scratch()];
  try {
    const rows = tappedBuild('media-walk', one);
    expectRecorded(rows, ['checkBx', 'elaborateBx', 'parseMediaModule', 'elaborateMedia']);
    assert.ok('after' in rows.find((r) => r.fn === 'elaborateBx'));
    assert.deepEqual(Object.keys(rows.find((r) => r.fn === 'elaborateMedia').after), ['module', 'diagnostics', 'mediaSlots']);
    const kinds = new Set(rows.filter((r) => r.fn === 'parseMediaModule').map((r) => r.args[3]));
    assert.deepEqual([...kinds].sort(), ['.8ba', '.8bg']);
    const again = tappedBuild('media-walk', two);
    assert.deepEqual(again, rows);
  } finally {
    rmSync(one, { recursive: true, force: true });
    rmSync(two, { recursive: true, force: true });
  }
});
