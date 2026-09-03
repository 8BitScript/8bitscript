import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertSudoAllowed, SUDO_ALLOWED_ROOTS } from '../src/setup/exec.mjs';

test('assertSudoAllowed: package installation is always allowed', () => {
  assert.doesNotThrow(() => assertSudoAllowed('pacman', ['-S', '--needed', 'sdl2-compat', 'gtk3']));
});

test('assertSudoAllowed: mkdir/install/ln writing under one of the allowed roots is allowed', () => {
  assert.doesNotThrow(() => assertSudoAllowed('mkdir', ['-p', '/opt/xemu']));
  assert.doesNotThrow(() => assertSudoAllowed('mkdir', ['-p', '/opt/mega65']));
  // install's source (first path) can legitimately be outside the roots
  // (the user's own build/cache tree) — only the destination is checked.
  assert.doesNotThrow(() => assertSudoAllowed(
    'install', ['-m755', '/home/user/.cache/8bitscript/setup/xemu/build/bin/xmega65.native', '/opt/xemu/xmega65'],
  ));
  assert.doesNotThrow(() => assertSudoAllowed('ln', ['-sf', '/opt/xemu/xmega65', '/usr/local/bin/xmega65']));
});

test('assertSudoAllowed: refuses to write outside the allowed roots', () => {
  assert.throws(() => assertSudoAllowed('mkdir', ['-p', '/etc/cron.d']), /outside the allowed/);
  assert.throws(() => assertSudoAllowed(
    'install', ['-m755', '/tmp/evil', '/usr/bin/sudo'],
  ), /outside the allowed/);
  assert.throws(() => assertSudoAllowed('ln', ['-sf', '/opt/xemu/xmega65', '/etc/passwd']), /outside the allowed/);
});

test('assertSudoAllowed: refuses any command outside the fixed set, even with an in-bounds-looking path', () => {
  assert.throws(() => assertSudoAllowed('rm', ['-rf', '/opt/mega65']), /not one of the sudo operations/);
  assert.throws(() => assertSudoAllowed('chmod', ['777', '/opt/xemu/xmega65']), /not one of the sudo operations/);
});

test('SUDO_ALLOWED_ROOTS matches the brief exactly: package installation, /opt/xemu, /opt/mega65, /usr/local/bin', () => {
  assert.deepEqual(SUDO_ALLOWED_ROOTS, ['/opt/xemu', '/opt/mega65', '/usr/local/bin']);
});
