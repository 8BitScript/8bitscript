const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  layerNames, projectSystemsPath, readSystemsMap, saveLayer, systemEntry,
  upsertSystem, userSystemsPath, writeSystemsFile,
} = require('../src/systemsStore.cjs');

test('systemEntry drops empty profile, hardware, and region', () => {
  assert.deepEqual(systemEntry({ target: 'pet' }), { target: 'pet' });
  assert.deepEqual(
    systemEntry({ target: 'pet', profile: '8032', hardware: { ram: '8' }, region: 'pal' }),
    { target: 'pet', profile: '8032', hardware: { ram: '8' }, region: 'pal' },
  );
});

test('a systems file round-trips and upserts one name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-systems-'));
  try {
    const file = projectSystemsPath(dir);
    writeSystemsFile(file, { Web: { target: 'web' } });
    assert.deepEqual(readSystemsMap(file), { Web: { target: 'web' } });
    upsertSystem(file, 'PET', { target: 'pet', profile: '2001' });
    assert.equal(readSystemsMap(file).PET.target, 'pet');
    assert.equal(readSystemsMap(file).Web.target, 'web');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveLayer updates a more-specific name and flags a shadowed advertise', () => {
  const project = new Set(['Shared']);
  const user = new Set(['Desk']);
  assert.deepEqual(
    saveLayer('Shared', 'user', { projectNames: project, userNames: user }),
    { layer: 'project', reason: 'more-specific' },
  );
  assert.deepEqual(
    saveLayer('Desk', 'advertised', { projectNames: project, userNames: user }),
    { layer: 'advertised', reason: 'shadowed' },
  );
  assert.deepEqual(
    saveLayer('New', 'user', { projectNames: project, userNames: user }),
    { layer: 'user' },
  );
});

test('layerNames reads both JSON files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-layers-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-home-'));
  try {
    upsertSystem(projectSystemsPath(dir), 'Clone', { target: 'pet' });
    upsertSystem(userSystemsPath(home), 'User', { target: 'web' });
    const names = layerNames(dir, home);
    assert.ok(names.projectNames.has('Clone'));
    assert.ok(names.userNames.has('User'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
