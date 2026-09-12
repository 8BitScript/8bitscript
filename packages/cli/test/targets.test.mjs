// `8bs targets --json` is what the editor builds its controls from, so what
// it carries — and what it still carries when the config is wrong — is part
// of the contract rather than an implementation detail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describeTargets } from '../src/targets.mjs';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/8bs.mjs', import.meta.url));

/** A throwaway project directory with the given 8bs.config.ts. */
function project(t, config) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-targets-'));
  writeFileSync(join(dir, '8bs.config.ts'), config);
  return dir;
}

test('describeTargets says which machines have a region, from the one set', () => {
  const region = Object.fromEntries(describeTargets(null).map((t) => [t.id, t.region]));
  assert.deepEqual(region, {
    vic20: true, c64: true, pet: false, c128: true, atari8: true,
    nes: false, cx16: false, mega65: true, web: false,
  });
});

test('--json carries the project\'s systems beside the targets and the fact schema', async (t) => {
  const dir = project(t, `export default {
  entry: 'src/main.8bs',
  targets: { c64: { profiles: { loaded: { ram: 'reu512' } } }, vic20: {}, web: {} },
  systems: {
    'C64 with an REU': { target: 'c64', profile: 'loaded', region: 'pal' },
    'Expanded VIC-20': { target: 'vic20', profile: '8k' },
  },
};
`);
  const { stdout } = await run(process.execPath, [BIN, 'targets', '--json'], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed).sort(),
    ['facts', 'requires', 'requiresError', 'systems', 'systemsError', 'targets']);
  assert.deepEqual(parsed.systems.map((s) => [s.name, s.target, s.profile, s.region]), [
    ['C64 with an REU', 'c64', 'loaded', 'pal'],
    ['Expanded VIC-20', 'vic20', '8k', null],
  ]);
  assert.equal(parsed.systemsError, null);
});

test('a systems block the config gets wrong costs the reader its systems and nothing else', async (t) => {
  const dir = project(t, `export default {
  entry: 'src/main.8bs',
  targets: ['c64'],
  systems: { 'My NES': { target: 'nes' } },
};
`);
  // The editor reads the JSON, and a whole hardware panel disappearing
  // because of a typo three lines away would say nothing about what is
  // wrong: the machines still come back, with the message beside them.
  const { stdout } = await run(process.execPath, [BIN, 'targets', '--json'], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.targets.length, 9);
  // Every machine is still listed, with its catalog; the release flag is
  // what tells the editor which ones `8bs build` will take.
  assert.deepEqual(parsed.targets.filter((t) => t.inRelease).map((t) => t.id), ['vic20', 'c64', 'pet', 'web']);
  assert.deepEqual(parsed.systems, []);
  assert.match(parsed.systemsError, /system 'My NES': this project does not target nes/);

  // The table form is for a person, and for them it is an error.
  await assert.rejects(
    run(process.execPath, [BIN, 'targets'], { cwd: dir, maxBuffer: 8 * 1024 * 1024 }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /8bs targets: 8bitscript\.config\.ts: system 'My NES'/);
      return true;
    },
  );
});
