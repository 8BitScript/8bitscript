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

import { CONTROLLER_KINDS, controllerKind } from '@8bitscript/compiler';

import { describeFacts, describeTargets } from '../src/targets.mjs';

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
    ['facts', 'programs', 'programsError', 'requires', 'requiresError', 'systems', 'systemsError', 'targets']);
  // One `entry` is the one program every project has, named main.
  assert.deepEqual(parsed.programs, [{ name: 'main', entry: 'src/main.8bs', targets: null }]);
  assert.equal(parsed.programsError, null);
  assert.deepEqual(parsed.systems.map((s) => [s.name, s.target, s.profile, s.region, s.origin]), [
    ['C64 with an REU', 'c64', 'loaded', 'pal', 'advertised'],
    ['Expanded VIC-20', 'vic20', '8k', null, 'advertised'],
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
  assert.deepEqual(parsed.targets.filter((t) => t.inRelease).map((t) => t.id), ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web']);
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

test('the JSON says what each machine\'s controller carries, and names the shapes that have a name', () => {
  // This is what the editor's Controller Setup panel used to keep two
  // tables of its own for — one saying what each kind of port device
  // carries, one saying which pad each machine takes. Both are gone; the
  // machine's answer rides on its fact sheet and the vocabulary rides on
  // the fact's own description, the same way `primaryPort` came across.
  const described = describeTargets(null);
  const controls = Object.fromEntries(described.map((t) => [t.id, t.facts['input.controls']]));
  assert.deepEqual(controls.nes, ['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start']);
  assert.deepEqual(controls.c64, ['up', 'down', 'left', 'right', 'a'], 'the stock C64 has a stick in port 2');
  assert.deepEqual(controls.pet, [], 'no ports, and it says so rather than staying quiet');
  // A machine's kind is never published as a second field: it is derived
  // from the list, by whoever is reading, against this one table.
  assert.deepEqual(Object.fromEntries(described.map((t) => [t.id, controllerKind(t.facts['input.controls'])])), {
    vic20: 'atari-stick', c64: 'atari-stick', pet: null, c128: 'atari-stick', atari8: 'atari-stick',
    nes: 'nes-pad', cx16: 'snes-pad', mega65: 'atari-stick', web: null,
  });
  for (const target of described) {
    assert.ok(!Object.hasOwn(target, 'controllerKind'), `${target.id}: a kind is derived, never published twice`);
  }

  // And the shapes, on the `input.controls` fact's own description, where
  // the editor finds them: `facts.find((f) => f.key === 'input.controls')`.
  const fact = describeFacts().find((entry) => entry.key === 'input.controls');
  assert.equal(fact.type, 'list');
  assert.equal(fact.program, false, 'not on a program\'s sheet: there is no literal to fold it into');
  assert.deepEqual(fact.kinds, CONTROLLER_KINDS);
  assert.deepEqual(fact.kinds.map((entry) => entry.kind), ['atari-stick', 'nes-pad', 'snes-pad', 'xbox-style']);
  // It survives the JSON, which is the only way the editor ever sees it.
  assert.deepEqual(JSON.parse(JSON.stringify(fact)).kinds, CONTROLLER_KINDS);
});

test('a control port that is empty says so through the sheet the editor resolves', async (t) => {
  // The panel resolves facts per target with the hardware each machine is
  // fitted with, so unplugging the stick really does change what it draws
  // — which is why the list lives on the port value and not on the
  // machine. Asserted end to end through the JSON the editor parses.
  const dir = project(t, `export default {
  entry: 'src/main.8bs',
  targets: { c64: {} },
  systems: { 'Bare C64': { target: 'c64', hardware: { port1: 'none', port2: 'none' } } },
};
`);
  const { stdout } = await run(process.execPath, [BIN, 'targets', '--json'], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  const c64 = parsed.targets.find((t2) => t2.id === 'c64');
  assert.deepEqual(c64.facts['input.controls'], ['up', 'down', 'left', 'right', 'a'], 'stock');
  assert.deepEqual(c64.options.port2.values.joystick.facts['input.controls'], ['up', 'down', 'left', 'right', 'a']);
  assert.equal(c64.options.port2.values.none.facts['input.controls'], undefined,
    'an empty port stays silent rather than erasing what the other port holds');
  assert.equal(parsed.systemsError, null, 'and a C64 with nothing in either port is still a machine');
});

test('--json merges a project-personal systems file over the advertised block', async (t) => {
  const dir = project(t, `export default {
  entry: 'src/main.8bs',
  targets: { pet: {}, web: {} },
  systems: { Shared: { target: 'web' } },
};
`);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  mkdirSync(join(dir, '.8bitscript'), { recursive: true });
  writeFileSync(join(dir, '.8bitscript', 'systems.json'), JSON.stringify({
    systems: {
      Shared: { target: 'pet', profile: '2001' },
      'Desk PET': { target: 'pet' },
    },
  }));
  const { stdout } = await run(process.execPath, [BIN, 'targets', '--json'], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.systems.map((s) => [s.name, s.target, s.origin]), [
    ['Shared', 'pet', 'project'],
    ['Desk PET', 'pet', 'project'],
  ]);
});

test('--json lists the project\'s programs, and a wrong programs block costs the reader only its programs', async (t) => {
  const dir = project(t, `export default {
  programs: {
    main:   { entry: 'src/main.8bs' },
    format: { entry: 'src/tools/format.8bs', targets: ['c64'] },
  },
  targets: ['c64', 'pet'],
};
`);
  const { stdout } = await run(process.execPath, [BIN, 'targets', '--json'], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.programs, [
    { name: 'main', entry: 'src/main.8bs', targets: null },
    { name: 'format', entry: 'src/tools/format.8bs', targets: ['c64'] },
  ]);
  // The text form names them too, with the flag that reaches each one.
  const text = await run(process.execPath, [BIN, 'targets'], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
  assert.match(text.stdout, /programs:\n\s+main\s+src\/main\.8bs\s+8bs run <target> --program main\n\s+format\s+src\/tools\/format\.8bs \(c64\)\s+8bs run <target> --program format/);

  const wrong = project(t, `export default {
  programs: { main: { entry: 'src/App.8bx' } },
  targets: ['c64'],
};
`);
  const bad = await run(process.execPath, [BIN, 'targets', '--json'], { cwd: wrong, maxBuffer: 8 * 1024 * 1024 });
  const badParsed = JSON.parse(bad.stdout);
  assert.equal(badParsed.targets.length, 9);
  assert.deepEqual(badParsed.programs, []);
  assert.match(badParsed.programsError, /programs\.main\.entry is src\/App\.8bx, a \.8bx file; a program starts from a \.8bs file/);
});
