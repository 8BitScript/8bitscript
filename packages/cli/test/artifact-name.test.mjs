// The filename rules an artifact has to satisfy to be loadable from the
// medium it is meant for. The CBM DOS numbers here were measured with
// c1541 on this host — see artifact-name.mjs's own header for the commands
// and what came back.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CBM_DOS_NAME_BYTES, NAME_RULES, checkArtifactName, checkArtifactCollisions } from '../src/artifact-name.mjs';

test('CBM DOS gives a filename sixteen bytes, and the extension is not one of them', () => {
  assert.equal(CBM_DOS_NAME_BYTES, 16);
  // 'main-pet-8032-32' is exactly sixteen: the longest name a stock PET
  // build can produce today, and it fits with nothing to spare. The '.prg'
  // is a directory *type*, not part of the name, so it is not counted.
  assert.deepEqual(checkArtifactName('main-pet-8032-32', 'pet'), { ok: true });
  assert.deepEqual(checkArtifactName('main-pet', 'pet'), { ok: true });
});

test('a name longer than the directory entry is refused, naming what the disk would have silently done instead', () => {
  const result = checkArtifactName('hello-world-pet-8032-32', 'pet');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /23 characters/);
  assert.match(result.error, /CBM DOS gives a filename 16/);
  assert.match(result.error, /'hello-world-pet-/, 'it shows the truncation that would have happened');
});

test('a target with no filesystem to satisfy has no rule, and every name passes', () => {
  assert.equal(NAME_RULES.web, null, 'a .wasm is named by its host; nothing on the machine reads the name');
  assert.deepEqual(checkArtifactName('a'.repeat(200), 'web'), { ok: true });
  // A machine with no entry is not silently policed by another machine's
  // rule — adding one means measuring that filesystem first.
  assert.deepEqual(checkArtifactName('a'.repeat(200), 'nes'), { ok: true });
});

test('two builds that are one file once the directory truncates them are refused, both named', () => {
  const result = checkArtifactCollisions([
    { stem: 'the-same-prefix-a', target: 'pet' },
    { stem: 'the-same-prefix-b', target: 'pet' },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /the-same-prefix-a/);
  assert.match(result.error, /the-same-prefix-b/);
  assert.match(result.error, /overwrite/);
});

test('collisions are per target, and a repeated build of the same artifact is not one', () => {
  assert.deepEqual(
    checkArtifactCollisions([{ stem: 'main-pet', target: 'pet' }, { stem: 'main-pet', target: 'pet' }]),
    { ok: true },
    'the same name twice is one artifact built twice, not two colliding',
  );
  assert.deepEqual(
    checkArtifactCollisions([
      { stem: 'a'.repeat(20), target: 'web' },
      { stem: `${'a'.repeat(19)}b`, target: 'web' },
    ]),
    { ok: true },
    'a target with no filesystem rule truncates nothing, so it collides with nothing',
  );
});
