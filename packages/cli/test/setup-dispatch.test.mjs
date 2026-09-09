import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup } from '../src/setup.mjs';

function capture(fn) {
  const stderr = [];
  const err = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  return Promise.resolve(fn()).finally(() => {
    process.stderr.write = err;
  }).then((code) => ({ code, stderr: stderr.join('') }));
}

test('setup with no target prints usage and exits 2', async () => {
  const { code, stderr } = await capture(() => setup([]));
  assert.equal(code, 2);
  assert.match(stderr, /Usage: 8bs setup/);
});

test('setup for a target that has no installer names doctor instead', async () => {
  const { code, stderr } = await capture(() => setup(['pet']));
  assert.equal(code, 2);
  assert.match(stderr, /no setup available for 'pet'/);
  assert.match(stderr, /8bs doctor/);
});

test('setup parses --rom / --repair / --update without treating them as the target', async () => {
  const { code, stderr } = await capture(() => setup(['--repair', '--update', '--rom', '/tmp/x']));
  assert.equal(code, 2);
  assert.match(stderr, /Usage: 8bs setup/);
});

test('setup parses --c64-forever and --rom-patch the same way, still needing a target', async () => {
  const { code, stderr } = await capture(() => setup(['--c64-forever', '/tmp/c64.msi', '--rom-patch', '/tmp/p.zip']));
  assert.equal(code, 2);
  assert.match(stderr, /Usage: 8bs setup/);
});
