// Content-Length JSON-RPC over a child process's stdio. Speaks only what
// `8bs lsp` speaks: initialize, full document sync, hover, completion,
// and publishDiagnostics. Microsoft's vscode-languageclient is the rest
// of the LSP spec (notebooks, semantic tokens, file operations, …) and
// is why this extension was a megabyte; it is not imported here.
const { spawn } = require('child_process');

class LspClient {
  /**
   * @param {{
   *   command: string,
   *   args?: string[],
   *   onNotification?: (method: string, params: unknown) => void,
   *   onStderr?: (text: string) => void,
   *   onExit?: (code: number | null, signal: string | null) => void,
   * }} options
   */
  constructor({ command, args = [], onNotification, onStderr, onExit }) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.stopped = false;
    this.onNotification = onNotification;
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    if (onStderr) this.child.stderr.on('data', (chunk) => onStderr(chunk.toString()));
    this.child.on('exit', (code, signal) => {
      if (!this.stopped) onExit?.(code, signal);
    });
    this.child.on('error', (error) => {
      for (const [, finish] of this.pending) {
        finish({ error: { message: error.message } });
      }
      this.pending.clear();
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
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
      const finish = this.pending.get(message.id);
      this.pending.delete(message.id);
      finish(message);
      return;
    }
    if (message.method && message.id !== undefined) {
      this._write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
      return;
    }
    if (message.method) this.onNotification?.(message.method, message.params);
  }

  _write(payload) {
    if (!this.child.stdin.writable) return;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(method, params, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    try {
      if (this.child.exitCode === null) {
        await this.request('shutdown', null, 2000).catch(() => {});
        this.notify('exit');
      }
    } finally {
      if (this.child.stdin.writable) this.child.stdin.end();
      await new Promise((resolve) => {
        if (this.child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          this.child.kill();
          resolve();
        }, 1000);
        this.child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

module.exports = { LspClient };
