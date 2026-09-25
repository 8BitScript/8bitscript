import { test } from 'node:test';
import assert from 'node:assert/strict';

import { browserLauncherCommand, openBrowser } from '../src/web-runtime.mjs';

test('browserLauncherCommand uses fixed absolute paths on every platform', () => {
  const url = 'https://8bitscript.org/';
  assert.deepEqual(browserLauncherCommand(url, 'darwin'), {
    command: '/usr/bin/open',
    args: [url],
  });
  assert.deepEqual(browserLauncherCommand(url, 'win32'), {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/c', 'start', '""', url],
  });
  assert.deepEqual(browserLauncherCommand(url, 'linux'), {
    command: '/usr/bin/xdg-open',
    args: [url],
  });
});

test('openBrowser returns a child from the fixed launcher path', () => {
  const child = openBrowser('https://8bitscript.org/');
  const { command } = browserLauncherCommand('https://8bitscript.org/');
  assert.equal(child.spawnfile, command);
  child.kill('SIGKILL');
});
