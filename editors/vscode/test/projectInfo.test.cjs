const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { eightBitScriptVersions, installRoots, lockfileFor, toolchainLabel, toolchainStatus } = require('../src/projectInfo.cjs');

const REPO = path.resolve(__dirname, '..', '..', '..');

test('eightBitScriptVersions reads declared @8bitscript/* specs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-pkg-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@8bitscript/cli': '0.7.1', lodash: '4.0.0' },
    }));
    assert.deepEqual(eightBitScriptVersions(dir), { '@8bitscript/cli': '0.7.1' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('toolchainStatus is the checkout, never each example', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-app-'));
  try {
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
      name: 'game',
      dependencies: { '@8bitscript/cli': '0.7.1' },
    }));
    const status = toolchainStatus({
      folders: [REPO, app],
      setting: REPO,
      projects: [
        { dir: path.join(REPO, 'packages', 'examples', 'hello-world'), name: 'hello-world', kind: 'example', shipped: true, packageManager: 'pnpm', installed: true },
        { dir: app, name: 'game', title: '2048', kind: 'project', packageManager: 'pnpm', installed: false },
      ],
    });
    assert.equal(status.origin, 'workspace');
    assert.equal(status.dir, REPO);
    assert.equal(status.action, 'update');
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('installRoots is the toolchain plus each workspace program, not examples', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-prog-'));
  try {
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
      name: '2048',
      dependencies: { '@8bitscript/cli': '0.7.1' },
    }));
    const rows = installRoots({
      folders: [REPO, app],
      projects: [
        { dir: path.join(REPO, 'packages', 'examples', 'hello-world'), name: 'hello-world', kind: 'example', packageManager: 'pnpm', installed: true },
        { dir: path.join(REPO, 'packages', 'studio'), name: '@8bitscript/studio', kind: 'app', packageManager: 'pnpm', installed: true },
        { dir: app, name: '2048', title: '2048', kind: 'project', packageManager: 'pnpm', installed: true },
      ],
    });
    assert.deepEqual(rows.map((row) => [row.kind, row.label]), [
      ['toolchain', '8BitScript'],
      ['program', '2048'],
    ]);
    assert.equal(rows[1].action, 'update');
    assert.match(rows[1].detail, /0\.7\.1/);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('toolchainStatus without a checkout offers Install, even with a consumer project', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-pub-'));
  try {
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
      name: 'game',
      dependencies: { '@8bitscript/cli': '0.7.1' },
    }));
    const managed = path.join(os.tmpdir(), '8bs-no-checkout');
    const status = toolchainStatus({
      folders: [app],
      managed,
      projects: [{ dir: app, name: 'game', title: '2048', packageManager: 'pnpm', installed: true }],
    });
    assert.equal(status.origin, 'missing');
    assert.equal(status.action, 'install');
    assert.equal(status.clone, true);
    assert.equal(status.dir, managed);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('toolchainStatus with nothing cloned offers Install', () => {
  const status = toolchainStatus({ folders: [os.tmpdir()], managed: path.join(os.tmpdir(), 'no-checkout') });
  assert.equal(status.origin, 'missing');
  assert.equal(status.action, 'install');
  assert.equal(status.clone, true);
});

test('toolchainLabel names a local checkout or a published version', () => {
  assert.equal(toolchainLabel({ checkout: REPO }), `local ${path.basename(REPO)}`);
  assert.equal(toolchainLabel({ publishedVersion: '0.7.1' }), 'published 0.7.1');
  assert.equal(toolchainLabel({}), 'published packages');
});

test('lockfileFor finds the nearest lockfile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-lock-'));
  try {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const nested = path.join(dir, 'app');
    fs.mkdirSync(nested);
    assert.equal(lockfileFor(nested).manager, 'pnpm');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
