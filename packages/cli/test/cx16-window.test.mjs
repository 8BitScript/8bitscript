import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyCx16WindowFlags, cx16WindowArgs } from '../src/cx16-window.mjs';

test('cx16WindowArgs: absent flags mean no change', () => {
  const parsed = cx16WindowArgs(['cx16', '--size']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.captureMouse, null);
  assert.equal(parsed.fullscreen, null);
  assert.deepEqual([...parsed.consumed], []);
});

test('cx16WindowArgs: rejects contradictory pairs', () => {
  assert.equal(cx16WindowArgs(['--capture-mouse', '--no-capture-mouse']).ok, false);
  assert.equal(cx16WindowArgs(['--fullscreen', '--no-fullscreen']).ok, false);
});

test('applyCx16WindowFlags: capture and fullscreen append x16emu flags', () => {
  const base = ['-ram', '512', '-prg', '/p/x.prg', '-run'];
  assert.deepEqual(
    applyCx16WindowFlags(base, { captureMouse: true, fullscreen: true }),
    ['-ram', '512', '-prg', '/p/x.prg', '-run', '-capture', '-fullscreen'],
  );
  assert.deepEqual(
    applyCx16WindowFlags(['-capture', ...base], { captureMouse: false, fullscreen: false }),
    base,
  );
});
