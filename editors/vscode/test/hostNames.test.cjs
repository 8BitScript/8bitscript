'use strict';

// The names under the launcher's run buttons (src/hostNames.cjs): each
// platform's answer parsed, and the detector reading the right place.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { defaultBrowser, editorName, linuxBrowser, macBrowser, windowsBrowser } = require('../src/hostNames.cjs');

test('editorName shortens VS Code and leaves every other editor as it calls itself', () => {
  assert.equal(editorName('Visual Studio Code'), 'VS Code');
  assert.equal(editorName('Visual Studio Code - Insiders'), 'VS Code Insiders');
  assert.equal(editorName('Cursor'), 'Cursor');
  assert.equal(editorName('Windsurf'), 'Windsurf');
  assert.equal(editorName(''), null);
  assert.equal(editorName(undefined), null);
});

test('macBrowser reads the https handler, falls back to http, and defaults to Safari', () => {
  const handlers = (list) => ({ LSHandlers: list });
  assert.equal(macBrowser(handlers([{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.google.chrome' }])), 'Chrome');
  assert.equal(macBrowser(handlers([{ LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'company.thebrowser.browser' }])), 'Arc');
  assert.equal(macBrowser(handlers([{ LSHandlerContentType: 'public.html', LSHandlerRoleAll: 'org.mozilla.firefox' }])), 'Safari', 'no URL handler set: the system default');
  assert.equal(macBrowser(handlers([{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.example.SuperBrowser' }])), 'Superbrowser', 'an unknown id still names itself');
  assert.equal(macBrowser({}), 'Safari');
});

test('windowsBrowser reads the UserChoice ProgId', () => {
  const out = (id) => `\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    ${id}\r\n`;
  assert.equal(windowsBrowser(out('ChromeHTML')), 'Chrome');
  assert.equal(windowsBrowser(out('MSEdgeHTM')), 'Edge');
  assert.equal(windowsBrowser(out('FirefoxURL-308046B0AF4A39CB')), 'Firefox');
  assert.equal(windowsBrowser(out('ZenHTML')), 'Zen');
  assert.equal(windowsBrowser(''), null);
  assert.equal(windowsBrowser(null), null);
});

test('linuxBrowser names the .desktop file', () => {
  assert.equal(linuxBrowser('firefox.desktop\n'), 'Firefox');
  assert.equal(linuxBrowser('google-chrome.desktop'), 'Chrome');
  assert.equal(linuxBrowser('org.qutebrowser.qutebrowser.desktop'), 'Qutebrowser');
  assert.equal(linuxBrowser(''), null);
});

test('defaultBrowser asks each platform its own way, and never throws', async () => {
  const calls = [];
  const exec = (answer) => async (file, args) => { calls.push([file, ...args]); return answer; };
  const mac = JSON.stringify({ LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.brave.browser' }] });
  assert.equal(await defaultBrowser({ platform: 'darwin', home: '/Users/me', exec: exec(mac) }), 'Brave');
  assert.deepEqual(calls.at(-1), ['plutil', '-convert', 'json', '-o', '-', '/Users/me/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist']);
  assert.equal(await defaultBrowser({ platform: 'darwin', home: '/Users/me', exec: exec(null) }), 'Safari', 'no file: never changed');
  assert.equal(await defaultBrowser({ platform: 'darwin', home: '/Users/me', exec: exec('not json') }), null);
  assert.equal(await defaultBrowser({ platform: 'win32', exec: exec('    ProgId    REG_SZ    BraveHTML') }), 'Brave');
  assert.equal(calls.at(-1)[0], 'reg');
  assert.equal(await defaultBrowser({ platform: 'linux', exec: exec('vivaldi-stable.desktop') }), 'Vivaldi');
  assert.deepEqual(calls.at(-1), ['xdg-settings', 'get', 'default-web-browser']);
  assert.equal(await defaultBrowser({ platform: 'linux', exec: exec(null) }), null);
});
