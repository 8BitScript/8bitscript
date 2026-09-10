// completionTriggers.cjs pins the character list lsp.cjs's
// registerCompletionItemProvider call passes to VS Code — hardcoded there
// (not read from the server's own initialize response), so nothing stops it
// drifting out of sync with completionProvider.triggerCharacters in
// packages/language-server/src/server.mjs. This file guards against that:
// a static check that `.` (member completion, `screen.bl|` -> `blank`) is
// still in the list, and a live check against the real running server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { COMPLETION_TRIGGER_CHARACTERS } = require('../src/completionTriggers.cjs');
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

test('the extension registers every trigger character the language server advertises', () => {
  assert.deepEqual([...COMPLETION_TRIGGER_CHARACTERS].sort(), [':', '.', '<'].sort());
});

test('the extension\'s trigger list matches the running server\'s own capabilities', async () => {
  const client = new LspClient({ command: process.execPath, args: [RUNNER, '--stdio'] });
  try {
    const result = await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    assert.deepEqual(
      [...COMPLETION_TRIGGER_CHARACTERS].sort(),
      [...result.capabilities.completionProvider.triggerCharacters].sort(),
    );
  } finally {
    await client.stop();
  }
});
