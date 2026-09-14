const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  checkoutCli, findCheckout, isCheckout, managedCheckoutDir, managedUpdateCommand,
  readToolchainFile, resolveCheckoutRoot, resolveProjectCheckout, runCheckout,
  writeToolchainFile, REPO_CLONE_URL,
} = require('../src/checkout.cjs');

const REPO = path.resolve(__dirname, '..', '..', '..');

test('this repository is a checkout; an empty directory is not', () => {
  assert.equal(isCheckout(REPO), true);
  assert.ok(checkoutCli(REPO).endsWith(path.join('packages', 'cli', 'bin', '8bs.mjs')));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-not-checkout-'));
  try {
    assert.equal(isCheckout(empty), false);
    assert.equal(findCheckout([empty, REPO]), REPO);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('a managed checkout lives under the extension storage directory', () => {
  const storage = path.join(os.tmpdir(), '8bs-storage');
  assert.equal(managedCheckoutDir(storage), path.join(storage, 'checkout'));
  assert.equal(managedCheckoutDir(null), null);
  assert.match(REPO_CLONE_URL, /github\.com\/8BitScript\/8bitscript/);
});

test('resolveCheckoutRoot prefers a workspace folder, then the setting, then a managed clone', () => {
  const managed = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-managed-'));
  try {
    assert.deepEqual(resolveCheckoutRoot({ folders: [REPO] }), { dir: REPO, origin: 'workspace' });
    assert.deepEqual(
      resolveCheckoutRoot({ folders: [REPO], setting: REPO }),
      { dir: REPO, origin: 'workspace' },
    );
    assert.equal(resolveCheckoutRoot({ folders: [os.tmpdir()], managed }), null);
    fs.writeFileSync(path.join(managed, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    fs.mkdirSync(path.join(managed, 'packages', 'cli', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(managed, 'packages', 'cli', 'bin', '8bs.mjs'), '');
    assert.deepEqual(
      resolveCheckoutRoot({ folders: [os.tmpdir()], managed }),
      { dir: managed, origin: 'managed' },
    );
  } finally {
    fs.rmSync(managed, { recursive: true, force: true });
  }
});

test('resolveCheckoutRoot prefers the workspace folder over a leftover clone setting', () => {
  const managed = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-managed-'));
  try {
    fs.writeFileSync(path.join(managed, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    fs.mkdirSync(path.join(managed, 'packages', 'cli', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(managed, 'packages', 'cli', 'bin', '8bs.mjs'), '');
    assert.deepEqual(
      resolveCheckoutRoot({ folders: [REPO], setting: managed, managed }),
      { dir: REPO, origin: 'workspace' },
    );
    assert.equal(runCheckout({ folders: [REPO], setting: managed }), REPO);
    assert.equal(runCheckout({ folders: [os.tmpdir()], setting: managed }), managed);
    assert.equal(runCheckout({ folders: [os.tmpdir()] }), null);
    assert.deepEqual(
      resolveCheckoutRoot({ folders: [os.tmpdir()], setting: managed, managed }),
      { dir: managed, origin: 'setting' },
    );
  } finally {
    fs.rmSync(managed, { recursive: true, force: true });
  }
});

test('managedUpdateCommand installs in the clone, not in globalStorage', () => {
  const dest = path.join(os.tmpdir(), '8bs-storage', 'checkout');
  const clone = managedUpdateCommand({ git: '/usr/bin/git', pnpm: '/home/me/.local/share/pnpm/pnpm', dest, have: false });
  assert.equal(clone.cwd, path.dirname(dest));
  assert.equal(clone.pull, false);
  assert.match(clone.line, /clone --depth 1 --branch trunk/);
  assert.match(clone.line, /install --dir /);
  assert.ok(clone.line.includes(dest));
  const pull = managedUpdateCommand({ git: '/usr/bin/git', pnpm: '/usr/bin/pnpm', dest, have: true });
  assert.equal(pull.cwd, dest);
  assert.equal(pull.pull, true);
  assert.match(pull.line, /pull --ff-only/);
  assert.doesNotMatch(pull.line, /clone /);
});

test('toolchain.json round-trips a checkout path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-toolchain-'));
  try {
    assert.equal(readToolchainFile(dir), null);
    writeToolchainFile(dir, REPO);
    assert.deepEqual(readToolchainFile(dir), { checkout: REPO });
    assert.equal(resolveProjectCheckout(dir, ''), REPO);
    writeToolchainFile(dir, null);
    assert.deepEqual(readToolchainFile(dir), {});
    assert.equal(resolveProjectCheckout(dir, REPO), REPO);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
