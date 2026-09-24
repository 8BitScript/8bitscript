// Three layers of named systems, one shape, first name wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MACHINES } from '@8bitscript/compiler';

import {
  advertisedSystems, findSystem, loadMergedSystems, loadSystemsFile, resolveNamedLaunch,
  writeSystemsFile,
} from '../src/systems.mjs';
import { hardwareArgs } from '../src/hardware.mjs';

const SCHEMA = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../schemas/systems.json'),
  'utf8',
));

function tmp() {
  return mkdtempSync(join(tmpdir(), '8bs-systems-'));
}

const config = {
  targets: { pet: {}, c64: {}, web: {} },
  systems: {
    'PET 8032': { target: 'pet', profile: '8032' },
    Shared: { target: 'web' },
  },
};

test('the systems JSON schema is the same shape parseSystemsMap accepts', () => {
  assert.equal(SCHEMA.type, 'object');
  assert.deepEqual(SCHEMA.required, ['systems']);
  assert.ok(SCHEMA.properties.systems.additionalProperties.properties.target);
  assert.deepEqual(
    SCHEMA.properties.systems.additionalProperties.properties.target.enum,
    [...MACHINES],
  );
});

test('a project file shadows an advertised name; a user file fills a gap', () => {
  const dir = tmp();
  const projectFile = join(dir, '.8bitscript', 'systems.json');
  const userFile = join(dir, 'user-systems.json');
  writeSystemsFile(projectFile, {
    Shared: { target: 'pet', profile: '2001' },
    'Desk PET': { target: 'pet' },
  });
  writeSystemsFile(userFile, {
    'My C64': { target: 'c64' },
    'Someone\'s NES': { target: 'nes' },
  });
  const { ok, systems } = loadMergedSystems({ config, projectDir: dir, projectFile, userFile });
  assert.ok(ok, systems?.error);
  const byName = Object.fromEntries(systems.map((s) => [s.name, s]));
  assert.equal(byName.Shared.origin, 'project');
  assert.equal(byName.Shared.target, 'pet');
  assert.equal(byName['Desk PET'].origin, 'project');
  assert.equal(byName['My C64'].origin, 'user');
  assert.equal(byName['PET 8032'].origin, 'advertised');
  assert.equal(byName['Someone\'s NES'], undefined, 'user systems for machines this project does not target stay out');
});

test('a project file that names a machine the project does not target is an error', () => {
  const dir = tmp();
  const projectFile = join(dir, 'systems.json');
  writeSystemsFile(projectFile, { NES: { target: 'nes' } });
  const result = loadMergedSystems({ config, projectFile, userFile: join(dir, 'missing.json') });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not target nes/);
});

test('a missing JSON file is empty, a broken one is an error', () => {
  const missing = loadSystemsFile(join(tmp(), 'nope.json'), {
    where: 'x', config, origin: 'project',
  });
  assert.deepEqual(missing, { ok: true, systems: [] });
  const broken = join(tmp(), 'bad.json');
  writeFileSync(broken, '{');
  const result = loadSystemsFile(broken, { where: 'x', config, origin: 'user', enforceTargets: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot parse/);
});

test('--system resolves through the merge and CLI flags sit on top', () => {
  const dir = tmp();
  const projectFile = join(dir, 'systems.json');
  writeSystemsFile(projectFile, {
    'PET 2001': { target: 'pet', hardware: { model: '3008' } },
  });
  const hw = hardwareArgs(['--system', 'PET 2001', '--hardware', 'ram=8']);
  assert.equal(hw.ok, true);
  const launch = resolveNamedLaunch(hw, {
    config: { targets: { pet: {} } },
    projectFile,
    userFile: join(dir, 'none.json'),
  });
  assert.ok(launch.ok, launch.error);
  assert.equal(launch.target, 'pet');
  assert.equal(launch.overrides.model, '3008');
  assert.equal(launch.overrides.ram, '8');
  assert.equal(launch.system.origin, 'project');
});

test('an unknown --system names the ones that exist', () => {
  const advertised = advertisedSystems(config);
  assert.ok(advertised.ok);
  const missing = findSystem('No such', advertised.systems);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /PET 8032/);
});

test('writeSystemsFile creates the directory and round-trips', () => {
  const path = join(tmp(), 'nested', 'systems.json');
  writeSystemsFile(path, { Web: { target: 'web' } });
  const loaded = loadSystemsFile(path, {
    where: path,
    config: { targets: { web: {} } },
    origin: 'project',
  });
  assert.ok(loaded.ok, loaded.error);
  assert.equal(loaded.systems[0].name, 'Web');
  assert.equal(loaded.systems[0].origin, 'project');
});
