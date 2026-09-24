// A local checkout is a tree, not a rewrite of package.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyCheckoutFromArgs, checkoutArgs, isCheckout, packageDirInCheckout,
  readToolchainFile, resolveCheckout, setActiveCheckout, writeToolchainFile,
} from '../src/checkout.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function tmp() {
  return mkdtempSync(join(tmpdir(), '8bs-checkout-'));
}

test('this repository is a checkout; an empty directory is not', () => {
  assert.equal(isCheckout(REPO), true);
  assert.equal(isCheckout(tmp()), false);
  assert.equal(isCheckout(''), false);
});

test('packageDirInCheckout maps @8bitscript/cli onto packages/cli', () => {
  assert.equal(packageDirInCheckout(REPO, '@8bitscript/cli'), join(REPO, 'packages', 'cli'));
  assert.equal(packageDirInCheckout(REPO, '@8bitscript/pet'), join(REPO, 'packages', 'pet'));
  assert.equal(packageDirInCheckout(REPO, 'left-pad'), null);
});

test('resolveCheckout prefers --checkout, then the env, then toolchain.json', () => {
  const project = tmp();
  writeToolchainFile(project, REPO);
  assert.deepEqual(readToolchainFile(project), { checkout: REPO });

  const fromFile = resolveCheckout(project, { env: {} });
  assert.ok(fromFile.ok);
  assert.equal(fromFile.checkout, REPO);

  const fromEnv = resolveCheckout(project, { env: { EIGHTBITSCRIPT_CHECKOUT: REPO } });
  assert.equal(fromEnv.checkout, REPO);

  const other = tmp();
  const fromFlag = resolveCheckout(other, { flag: REPO, env: {} });
  assert.equal(fromFlag.checkout, REPO);

  const bad = resolveCheckout(project, { flag: other, env: {} });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not an 8BitScript checkout/);
});

test('a relative checkout in toolchain.json is resolved from the project', () => {
  const parent = tmp();
  const project = join(parent, 'game');
  mkdirSync(project);
  writeToolchainFile(project, '..');
  // `..` is not a checkout unless we point at the real repo.
  writeToolchainFile(project, REPO);
  const resolved = resolveCheckout(project, { env: {} });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.checkout, REPO);
});

test('--checkout is consumed so it does not become a positional', () => {
  const parsed = checkoutArgs(['run', 'pet', '--checkout', '/tmp/x', 'src/main.8bs']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.flag, '/tmp/x');
  assert.deepEqual([...parsed.consumed].sort((a, b) => a - b), [2, 3]);
  assert.equal(checkoutArgs(['--checkout']).ok, false);
});

test('resolveCheckout walks up to a monorepo root when nothing else is set', () => {
  const nested = join(REPO, 'packages', 'studio');
  const resolved = resolveCheckout(nested, { env: {} });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.checkout, REPO);
});

test('applyCheckoutFromArgs sets the active checkout and clears it when absent', () => {
  setActiveCheckout(null);
  const applied = applyCheckoutFromArgs(['--checkout', REPO], tmp());
  assert.ok(applied.ok, applied.error);
  assert.equal(applied.checkout, REPO);
  const cleared = applyCheckoutFromArgs([], tmp());
  assert.ok(cleared.ok);
  assert.equal(cleared.checkout, null);
});
