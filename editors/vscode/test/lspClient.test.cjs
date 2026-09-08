// The thin stdio client against a real `8bs lsp` process — the same
// Content-Length wire the editor host uses. Microsoft's vscode-languageclient
// is not involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { readFileSync } = require('fs');

const { LspClient } = require('../src/lspClient.cjs');

const RUNNER = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'language-server',
  'scripts',
  'run-server.mjs',
);

const URI = 'file:///t.8bs';

function connect() {
  return new LspClient({
    command: process.execPath,
    args: [RUNNER, '--stdio'],
  });
}

async function withClient(fn) {
  const client = connect();
  try {
    await fn(client);
  } finally {
    await client.stop();
  }
}

test('initialize advertises hover and completion', async () => {
  await withClient(async (client) => {
    const result = await client.request('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    assert.equal(result.capabilities.hoverProvider, true);
    assert.ok(result.capabilities.completionProvider);
  });
});

test('didOpen of a range error publishes an 8BS1021 diagnostic', async () => {
  await withClient(async (client) => {
    await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    client.notify('initialized', {});
    const published = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no publishDiagnostics')), 5000);
      client.onNotification = (method, params) => {
        if (method !== 'textDocument/publishDiagnostics') return;
        clearTimeout(timer);
        resolve(params);
      };
    });
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: URI,
        languageId: '8bitscript',
        version: 1,
        text: 'let x: utinyint = 300;\nlet y: u8 = 5;\n',
      },
    });
    const params = await published;
    assert.equal(params.diagnostics.length, 1);
    assert.equal(params.diagnostics[0].code, '8BS1021');
  });
});

test('the extension does not depend on vscode-languageclient', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  assert.ok(!('vscode-languageclient' in deps));
  const entry = readFileSync(path.join(__dirname, '..', 'src', 'extension.cjs'), 'utf8');
  assert.doesNotMatch(entry, /require\(['"]vscode-languageclient/);
});
