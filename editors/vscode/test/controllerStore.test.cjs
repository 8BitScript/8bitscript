// Where a project's controller profiles live, and what happens to a file
// somebody has broken.
//
// Against a real temporary directory rather than a mocked `fs`: the whole
// module is four calls into `fs`, and a test that mocked them would be a
// test of the mock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONTROLLERS_FILE, controllersPath, readProfile, writeProfile,
} = require('../src/controllerStore.cjs');
const { emptyProfile, withDevice } = require('../src/controllerProfile.cjs');

/** A throwaway project directory, cleaned up when the test ends. */
function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-controllers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the file sits beside the config, named so it sorts with it', () => {
  assert.equal(CONTROLLERS_FILE, '8bitscript.controllers.json');
  assert.equal(controllersPath('/somewhere'), path.join('/somewhere', CONTROLLERS_FILE));
  // Not hidden and not under dist/: it is checked in, the way a `systems`
  // block in 8bitscript.config.ts is, because a mapping is the team's.
  assert.ok(!CONTROLLERS_FILE.startsWith('.'));
});

test('a project with no file has no controllers, and that is not an error', (t) => {
  const dir = project(t);
  const read = readProfile(dir);
  assert.deepEqual(read.profile, emptyProfile());
  assert.equal(read.exists, false);
  assert.equal(read.error, null, 'not having one yet is the ordinary case');
});

test('a profile survives a round trip, and comes back normalized', (t) => {
  const dir = project(t);
  const written = writeProfile(dir, withDevice(emptyProfile(), {
    id: 'sn30',
    name: '8BitDo SN30 Pro',
    player: 1,
    mode: 'standard',
    mapping: { a: 'button:0', up: 'button:12', leftStickX: 'axis:0' },
  }));
  assert.equal(written.path, path.join(dir, CONTROLLERS_FILE));
  assert.ok(written.text.endsWith('\n'), 'a text file ends with a newline');
  assert.match(written.text, /^\{\n {2}"version"/, 'two spaces, like every other JSON here');

  const read = readProfile(dir);
  assert.equal(read.exists, true);
  assert.equal(read.error, null);
  assert.deepEqual(read.profile.controllers.devices, [{
    id: 'sn30',
    name: '8BitDo SN30 Pro',
    player: 1,
    mode: 'standard',
    mapping: { up: 'button:12', a: 'button:0', leftStickX: 'axis:0' },
  }]);
  // The shape the panel promised: `{ controllers: { devices: [...] } }`.
  const parsed = JSON.parse(written.text);
  assert.ok(Array.isArray(parsed.controllers.devices));
  assert.equal(parsed.version, 1);
});

test('a file somebody broke costs them the profile, never the panel', (t) => {
  const dir = project(t);
  fs.writeFileSync(controllersPath(dir), '{ "controllers": { devices: oops', 'utf8');
  const read = readProfile(dir);
  assert.deepEqual(read.profile, emptyProfile(), 'unreadable is the same as unset');
  assert.equal(read.exists, true, 'but the file is still there, so Open finds it');
  assert.match(read.error, /8bitscript\.controllers\.json/, 'and the reason names the file');
});

test('a binding the reader cannot understand never survives a write', (t) => {
  const dir = project(t);
  writeProfile(dir, {
    controllers: { devices: [{ id: 'x', mapping: { a: 'button:0', b: 'mouse:left' } }] },
  });
  assert.deepEqual(readProfile(dir).profile.controllers.devices[0].mapping, { a: 'button:0' });
  // Which is what makes the round trip the only thing that has to be true
  // of the file: what is read back is exactly what was written.
  const once = readProfile(dir).profile;
  const twice = readProfile(writeProfile(dir, once) && dir).profile;
  assert.deepEqual(once, twice);
});
