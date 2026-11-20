import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEnv, ROOT } from '../corpus.mjs';
import { TAPPED, resolve } from './hooks.mjs';
import { encode, record, rootsFrom, tapped, tappedReset, tokenize } from './tap.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'mos-tap-test-'));
}

function lines(dir) {
  return readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
}

test('encode follows the record format: Map, Set, bytes, instances, no prov', () => {
  class Box { constructor() { this.next = 3; this.gone = undefined; } }
  const value = {
    map: new Map([['a', 1], ['b', new Set([2, 3])]]),
    bytes: new Uint8Array([1, 255]),
    box: new Box(),
    op: { kind: 'op', prov: { fn: 'x' }, list: [{ prov: 1, n: null }] },
  };
  assert.deepEqual(encode(value), {
    map: [['a', 1], ['b', [2, 3]]],
    bytes: [1, 255],
    box: { next: 3 },
    op: { kind: 'op', list: [{ n: null }] },
  });
});

test('paths under the roots become tokens, the project first', () => {
  const roots = rootsFrom({ EIGHTBS_MOS_TAP_ROOTS: JSON.stringify({ toolchain: '/t', project: '/t/p' }) });
  assert.equal(tokenize('/t/p/a.s and /t/b.s, /t/pq', roots), '<project>/a.s and <toolchain>/b.s, <toolchain>/pq');
  assert.deepEqual(rootsFrom({ EIGHTBS_MOS_TAP_ROOTS: 'not json' }), []);
  assert.deepEqual(rootsFrom({}), []);
  assert.equal(encode('/t/x', roots), '<toolchain>/x');
});

test('a tapped call records a copy of its arguments, the result and the after state', () => {
  const dir = scratch();
  try {
    const env = { EIGHTBS_MOS_TAP: dir };
    const real = (list) => { list.push(9); return list.length; };
    const wrapped = tapped('f', real, ([list]) => ({ size: list.length }), env);
    const list = [1];
    assert.equal(wrapped(list), 2);
    const [row] = lines(dir);
    assert.deepEqual(row.args, [[1]]);
    assert.equal(row.result, 2);
    assert.deepEqual(row.after, { size: 2 });
    assert.equal(row.fn, 'f');
    assert.equal(typeof row.seq, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a thrown error is recorded and rethrown, and resets are recorded', () => {
  const dir = scratch();
  try {
    const env = { EIGHTBS_MOS_TAP: dir };
    const boom = tapped('boom', () => { throw new Error('nope'); }, undefined, env);
    assert.throws(() => boom(1), /nope/);
    let resets = 0;
    tappedReset('lower', () => { resets++; }, env)();
    const rows = lines(dir);
    assert.equal(rows[0].throw, 'nope');
    assert.deepEqual(rows[0].args, [1]);
    assert.equal(rows[1].fn, 'reset:lower');
    assert.equal(rows[1].seq, rows[0].seq + 1);
    assert.equal(resets, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with the tap off a wrapped function is the real one and nothing is written', () => {
  const real = (x) => x + 1;
  assert.equal(tapped('f', real, undefined, {})(1), 2);
  let resets = 0;
  tappedReset('relax', () => { resets++; }, {})();
  assert.equal(resets, 1);
  assert.doesNotThrow(() => record('f', {}, {}));
});

test('the resolve hook swaps a tapped module for its shim, except for the shim itself', async () => {
  const real = new URL('../../../packages/compiler/src/mos/link/index.ts', import.meta.url).href;
  const next = async () => ({ url: real });
  const swapped = await resolve('./link/index.ts', { parentURL: 'file:///other.ts' }, next);
  assert.match(swapped.url, /mos-tap\/shims\/link\.mjs$/);
  const kept = await resolve('x', { parentURL: swapped.url }, next);
  assert.equal(kept.url, real);
  const other = await resolve('y', { parentURL: 'file:///other.ts' }, async () => ({ url: 'file:///elsewhere.ts' }));
  assert.equal(other.url, 'file:///elsewhere.ts');
  assert.equal(Object.keys(TAPPED).length, 7);
});

test('buildEnv leaves the environment alone without a tap directory', () => {
  const base = { A: '1' };
  assert.equal(buildEnv(base, null, 'p/m/c64', { dir: '/p' }), base);
  const env = buildEnv(base, '/tap', 'p/m/c64', { dir: '/p' });
  assert.equal(env.EIGHTBS_MOS_TAP, join('/tap', 'p', 'm', 'c64'));
  assert.match(env.NODE_OPTIONS, /--import=file:.*mos-tap\/register\.mjs/);
  assert.deepEqual(JSON.parse(env.EIGHTBS_MOS_TAP_ROOTS), { toolchain: ROOT, project: '/p' });
});

test('hello-world on c64 records every tapped function, and the build is unchanged', () => {
  const dir = scratch();
  const project = { dir: join(ROOT, 'packages', 'examples', 'hello-world') };
  const cli = join(ROOT, 'packages', 'cli', 'bin', '8bs.mjs');
  const build = (env) => execFileSync(process.execPath, [cli, 'build', '--target', 'c64'], { cwd: project.dir, env, encoding: 'utf8' });
  try {
    const plain = readFileSync(/^built (.+)$/m.exec(build(process.env))[1]);
    const tappedOut = build(buildEnv(process.env, dir, 'hello-world/main/c64', project));
    assert.deepEqual(readFileSync(/^built (.+)$/m.exec(tappedOut)[1]), plain);
    const rows = lines(join(dir, 'hello-world', 'main', 'c64'));
    const first = (fn) => rows.find((r) => r.fn === fn);
    for (const fn of ['link', 'buildDataSection', 'allocate', 'assembleNative', 'layoutFrames', 'lower']) {
      assert.ok(first(fn), `${fn} was not recorded`);
      assert.ok('args' in first(fn) && 'result' in first(fn), `${fn} lacks args or result`);
    }
    assert.deepEqual(Object.keys(first('lower').after).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), ['ceiling', 'high', 'holes', 'next', 'origin']);
    assert.ok(first('reset:lower') && first('reset:relax'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
