// Which examples carry the shared media, and which must not.
//
// Both kinds of media need a frame to drive them: `audio.play()` arms a
// voice and only `audio.update()`, counted down over the following frames,
// releases it, and `graphics.place()` leaves its drawing to the next update
// on every machine but the VIC-20. hello-world and hello-bx draw once and
// return, so a chime in either sticks on after the program ends and an
// object in either costs its whole pipeline to draw nothing — measured at
// 1587 bytes against 108 on the PET before they were taken out.
//
// This pins that, because the generator beside it would otherwise put them
// back: `node generate-shared-assets.mjs` is the documented way to refresh
// the assets, and it writing into the wrong example is a silent regression
// that only shows up as a stuck voice on real hardware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXAMPLES, MEDIA_EXAMPLES, NO_FRAME_LOOP, MARK_COMPONENT_EXAMPLES } from '../generate-shared-assets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MEDIA_FILES = ['mark.png', 'mark.8bg', 'chime.wav', 'chime.8ba'];

test('the two examples that draw once and return are the ones without a frame loop', () => {
  assert.deepEqual(NO_FRAME_LOOP, ['hello-world', 'hello-bx']);
  for (const name of NO_FRAME_LOOP) {
    assert.ok(EXAMPLES.includes(name), `${name} is one of the examples`);
    assert.equal(MEDIA_EXAMPLES.includes(name), false, `${name} is not given media`);
  }
  assert.deepEqual(MEDIA_EXAMPLES, ['joystick', 'fancy', 'swarm', 'media-walk']);
});

test('no example without a frame loop carries media on disk', () => {
  for (const name of NO_FRAME_LOOP) {
    for (const file of [...MEDIA_FILES, 'Mark.8bx']) {
      const path = join(ROOT, name, 'src', file);
      assert.equal(existsSync(path), false, `${name}/src/${file} must not exist: nothing there can drive it`);
    }
  }
});

test('every example with a frame loop carries the shared media', () => {
  for (const name of MEDIA_EXAMPLES) {
    for (const file of MEDIA_FILES) {
      const path = join(ROOT, name, 'src', file);
      assert.ok(existsSync(path), `${name}/src/${file} is missing — run node generate-shared-assets.mjs`);
    }
    const component = join(ROOT, name, 'src', 'Mark.8bx');
    assert.equal(
      existsSync(component),
      MARK_COMPONENT_EXAMPLES.includes(name),
      `${name}: Mark.8bx should exist only where the object comes from the shared component`,
    );
  }
});

test('importing the generator writes nothing — only running it does', async () => {
  // The lists above are read by this file; if importing the module wrote
  // its assets, asking which examples carry media would itself create them.
  const before = NO_FRAME_LOOP.map((name) => existsSync(join(ROOT, name, 'src', 'chime.8ba')));
  await import('../generate-shared-assets.mjs');
  const after = NO_FRAME_LOOP.map((name) => existsSync(join(ROOT, name, 'src', 'chime.8ba')));
  assert.deepEqual(after, before);
  assert.deepEqual(after, [false, false]);
});
