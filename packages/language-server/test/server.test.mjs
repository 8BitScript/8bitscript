// End-to-end LSP tests: a real server process, spoken to over real stdio
// framing, the same way an editor would. No internals are reached into —
// everything here goes through the wire protocol, because that is the
// contract this package actually promises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', 'scripts', 'run-server.mjs');

/** A minimal LSP client: Content-Length framing over a child process's stdio. */
class LspClient {
  constructor() {
    // `--stdio` is what tells vscode-languageserver's createConnection() to
    // speak the protocol over stdin/stdout — the same flag `8bs lsp --stdio`
    // passes through from the CLI.
    this.child = spawn(process.execPath, [RUNNER, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) { this.buffer = this.buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      this._handle(JSON.parse(body));
    }
  }

  _handle(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      this.pending.get(message.id)(message);
      this.pending.delete(message.id);
      return;
    }
    this.notifications.push(message);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  _write(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(method, params) {
    const id = this.nextId++;
    const done = new Promise((resolve) => this.pending.set(id, resolve));
    this._write({ jsonrpc: '2.0', id, method, params });
    return done;
  }

  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  async waitForNotification(method, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.notifications.find((n) => n.method === method);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`);
      await new Promise((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  close() {
    this.child.kill();
  }
}

const URI = 'file:///t.8bs';

/** Character offset -> LSP {line, character}, for text with no multi-byte lines. */
function positionAt(text, offset) {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

async function withServer(fn) {
  const client = new LspClient();
  try {
    await fn(client);
  } finally {
    client.close();
  }
}

test('initialize advertises hover and completion support', async () => {
  await withServer(async (client) => {
    const response = await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    assert.equal(response.result.capabilities.hoverProvider, true);
    assert.ok(response.result.capabilities.completionProvider);
  });
});

test('diagnostics still work: a friendly-name range error is reported', async () => {
  await withServer(async (client) => {
    await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    client.notify('initialized', {});

    const text = 'let x: utinyint = 300;\nlet y: u8 = 5;\n';
    client.notify('textDocument/didOpen', {
      textDocument: { uri: URI, languageId: '8bitscript', version: 1, text },
    });

    const published = await client.waitForNotification('textDocument/publishDiagnostics');
    assert.equal(published.params.diagnostics.length, 1);
    assert.equal(published.params.diagnostics[0].code, '8BS1021');
    assert.match(published.params.diagnostics[0].message, /utinyint/);
  });
});

test('textDocument/hover returns the compiler-owned documentation', async () => {
  await withServer(async (client) => {
    await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    client.notify('initialized', {});

    const text = 'let x: utinyint = 3;\n';
    client.notify('textDocument/didOpen', {
      textDocument: { uri: URI, languageId: '8bitscript', version: 1, text },
    });
    await client.waitForNotification('textDocument/publishDiagnostics');

    const response = await client.request('textDocument/hover', {
      textDocument: { uri: URI },
      position: positionAt(text, text.indexOf('utinyint') + 2),
    });

    assert.ok(response.result);
    assert.equal(response.result.contents.kind, 'markdown');
    assert.match(response.result.contents.value, /Unsigned 1-byte integer/);
    assert.match(response.result.contents.value, /Low-level alias: u8/);
  });
});

test('textDocument/hover on an ordinary identifier returns null', async () => {
  await withServer(async (client) => {
    await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    client.notify('initialized', {});

    const text = 'let myCounter: utinyint = 3;\n';
    client.notify('textDocument/didOpen', {
      textDocument: { uri: URI, languageId: '8bitscript', version: 1, text },
    });
    await client.waitForNotification('textDocument/publishDiagnostics');

    const response = await client.request('textDocument/hover', {
      textDocument: { uri: URI },
      position: positionAt(text, text.indexOf('myCounter') + 3),
    });
    assert.equal(response.result, null);
  });
});

test('textDocument/hover explains memory.write', async () => {
  await withServer(async (client) => {
    await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    client.notify('initialized', {});

    const text = 'export function f(): void { memory.write(36879, 27); }';
    client.notify('textDocument/didOpen', {
      textDocument: { uri: URI, languageId: '8bitscript', version: 1, text },
    });
    await client.waitForNotification('textDocument/publishDiagnostics');

    const response = await client.request('textDocument/hover', {
      textDocument: { uri: URI },
      position: positionAt(text, text.indexOf('write') + 2),
    });

    assert.ok(response.result);
    assert.match(response.result.contents.value, /POKE/);
  });
});

test('textDocument/completion offers canonical built-in types in a type position', async () => {
  await withServer(async (client) => {
    await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    client.notify('initialized', {});

    const text = 'let x: ';
    client.notify('textDocument/didOpen', {
      textDocument: { uri: URI, languageId: '8bitscript', version: 1, text },
    });
    await client.waitForNotification('textDocument/publishDiagnostics');

    const response = await client.request('textDocument/completion', {
      textDocument: { uri: URI },
      position: positionAt(text, text.length),
    });

    const labels = response.result.map((item) => item.label);
    for (const name of [
      'tinyint', 'utinyint', 'smallint', 'usmallint',
      'mediumint', 'umediumint', 'int', 'uint',
      'array', 'ptr', 'volatile',
    ]) {
      assert.ok(labels.includes(name), `missing ${name}`);
    }
    assert.ok(response.result.every((item) => item.documentation?.kind === 'markdown'));
  });
});
