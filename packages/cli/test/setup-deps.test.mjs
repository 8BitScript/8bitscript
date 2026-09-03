import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMissingPackages, missingPacmanPackages, installPacmanPackages, XEMU_BUILD_PACKAGES,
} from '../src/setup/deps.mjs';

test('parseMissingPackages: one package per line, blank output means nothing missing', () => {
  assert.deepEqual(parseMissingPackages('sdl2-compat\ngtk3\n'), ['sdl2-compat', 'gtk3']);
  assert.deepEqual(parseMissingPackages(''), []);
  assert.deepEqual(parseMissingPackages('\n\n'), []);
});

test('missingPacmanPackages: everything already installed (pacman -T prints nothing)', async () => {
  const missing = await missingPacmanPackages(XEMU_BUILD_PACKAGES, async (cmd, args) => {
    assert.equal(cmd, 'pacman');
    assert.deepEqual(args, ['-T', ...XEMU_BUILD_PACKAGES]);
    return { code: 0, stdout: '', stderr: '', missing: false };
  });
  assert.deepEqual(missing, []);
});

test('missingPacmanPackages: reports the subset pacman -T names as unsatisfied', async () => {
  const missing = await missingPacmanPackages(['git', 'gtk3', 'readline'], async () => (
    { code: 127, stdout: 'gtk3\nreadline\n', stderr: '', missing: false }
  ));
  assert.deepEqual(missing, ['gtk3', 'readline']);
});

test('missingPacmanPackages: pacman itself not found -> treat everything as missing rather than crash', async () => {
  const missing = await missingPacmanPackages(['git'], async () => ({ missing: true }));
  assert.deepEqual(missing, ['git']);
});

test('installPacmanPackages: runs `pacman -S --needed <packages>` under sudo, no --noconfirm (pacman prompts itself)', async () => {
  let calledWith = null;
  await installPacmanPackages(['gtk3', 'readline'], async (cmd, args) => {
    calledWith = [cmd, args];
    return { code: 0 };
  });
  assert.deepEqual(calledWith, ['pacman', ['-S', '--needed', 'gtk3', 'readline']]);
});
