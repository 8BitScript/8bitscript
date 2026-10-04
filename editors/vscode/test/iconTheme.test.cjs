// The file icons are a file icon theme, and a theme replaces the whole set,
// so the extension no longer switches it on for everyone through
// `configurationDefaults`: it asks once, remembers the answer, and does
// nothing if the person already uses it.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const { offerIconTheme } = require('../src/iconTheme.cjs');
const MANIFEST = require('../package.json');

function context() {
  const store = new Map();
  return { store, globalState: { get: (key) => store.get(key), update: async (key, value) => { store.set(key, value); } } };
}

test('the manifest no longer sets the file icon theme for everyone', () => {
  assert.equal(MANIFEST.contributes.configurationDefaults, undefined);
  assert.ok(MANIFEST.contributes.iconThemes.some((theme) => theme.id === '8bitscript'), 'the theme itself is still offered');
});

test('it asks once, and "Use 8BitScript icons" sets the user\'s icon theme', async () => {
  vscode.__mock.reset();
  const ctx = context();
  vscode.__mock.queues.showInformationMessage.push('Use 8BitScript icons');
  await offerIconTheme(ctx);
  assert.equal(vscode.__mock.configStore.get('iconTheme'), '8bitscript');
  const [message, ...choices] = vscode.__mock.calls.showInformationMessage[0];
  assert.match(message, /file icons/);
  assert.deepEqual(choices, ['Use 8BitScript icons', 'Not now']);
  assert.equal(ctx.store.get('iconThemeOffered'), true);
  await offerIconTheme(ctx);
  assert.equal(vscode.__mock.calls.showInformationMessage.length, 1, 'never asked twice');
});

test('"Not now" changes nothing and is not asked again', async () => {
  vscode.__mock.reset();
  const ctx = context();
  vscode.__mock.queues.showInformationMessage.push('Not now');
  await offerIconTheme(ctx);
  assert.equal(vscode.__mock.configStore.has('iconTheme'), false);
  await offerIconTheme(ctx);
  assert.equal(vscode.__mock.calls.showInformationMessage.length, 1);
});

test('a dismissed prompt is also an answer', async () => {
  vscode.__mock.reset();
  const ctx = context();
  await offerIconTheme(ctx);
  assert.equal(vscode.__mock.configStore.has('iconTheme'), false);
  await offerIconTheme(ctx);
  assert.equal(vscode.__mock.calls.showInformationMessage.length, 1);
});

test('someone already using the theme is not asked at all', async () => {
  vscode.__mock.reset();
  vscode.__mock.configStore.set('iconTheme', '8bitscript');
  const ctx = context();
  await offerIconTheme(ctx);
  assert.equal(vscode.__mock.calls.showInformationMessage.length, 0);
  assert.equal(ctx.store.get('iconThemeOffered'), true, 'and it need not check again');
});

test('a host with nowhere to remember the answer still asks, and nothing throws', async () => {
  vscode.__mock.reset();
  vscode.__mock.queues.showInformationMessage.push('Not now');
  await offerIconTheme({});
  assert.equal(vscode.__mock.calls.showInformationMessage.length, 1);
});
