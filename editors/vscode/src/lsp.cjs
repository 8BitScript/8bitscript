// Wire `8bs lsp` to the editor host. Protocol lives in lspClient.cjs;
// this file only translates LSP shapes to vscode.* ones.
const vscode = require('vscode');

const { LspClient } = require('./lspClient.cjs');

// LSP DiagnosticSeverity is 1-based; vscode.DiagnosticSeverity is 0-based.
const DIAGNOSTIC_SEVERITY = {
  1: vscode.DiagnosticSeverity.Error,
  2: vscode.DiagnosticSeverity.Warning,
  3: vscode.DiagnosticSeverity.Information,
  4: vscode.DiagnosticSeverity.Hint,
};

// Same off-by-one for CompletionItemKind. Only the kinds `8bs lsp` sends.
const COMPLETION_KIND = {
  3: vscode.CompletionItemKind.Function,
  21: vscode.CompletionItemKind.Constant,
  25: vscode.CompletionItemKind.TypeParameter,
};

function isEightBitScript(document) {
  return document.languageId === '8bitscript';
}

function toRange(range) {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function toDiagnostic(item) {
  const diagnostic = new vscode.Diagnostic(
    toRange(item.range),
    item.message,
    DIAGNOSTIC_SEVERITY[item.severity] ?? vscode.DiagnosticSeverity.Error,
  );
  diagnostic.source = item.source ?? '8bs';
  diagnostic.code = item.code;
  return diagnostic;
}

function toCompletion(item) {
  const completion = new vscode.CompletionItem(
    item.label,
    COMPLETION_KIND[item.kind] ?? vscode.CompletionItemKind.TypeParameter,
  );
  completion.detail = item.detail;
  completion.sortText = item.sortText;
  if (item.insertText) completion.insertText = item.insertText;
  if (item.documentation?.value) {
    completion.documentation = new vscode.MarkdownString(item.documentation.value);
  }
  return completion;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').OutputChannel} output
 */
function registerLanguageServer(context, output) {
  const collection = vscode.languages.createDiagnosticCollection('8bs');
  context.subscriptions.push(collection);

  /** @type {LspClient | undefined} */
  let client;
  let starting = false;

  function openDocument(document) {
    if (!client || !isEightBitScript(document)) return;
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: document.uri.toString(),
        languageId: document.languageId,
        version: document.version,
        text: document.getText(),
      },
    });
  }

  function syncOpenDocuments() {
    for (const document of vscode.workspace.textDocuments) openDocument(document);
  }

  async function start(toolchain) {
    if (client || starting) return;
    starting = true;
    output.appendLine(`Starting language server: ${toolchain} lsp --stdio`);
    const next = new LspClient({
      command: toolchain,
      args: ['lsp', '--stdio'],
      onNotification(method, params) {
        if (method === 'textDocument/publishDiagnostics') {
          collection.set(vscode.Uri.parse(params.uri), params.diagnostics.map(toDiagnostic));
        }
      },
      onStderr(text) {
        output.append(text);
      },
      onExit(code, signal) {
        output.appendLine(`Language server exited (${signal ?? code}).`);
        collection.clear();
        if (client === next) client = undefined;
      },
    });
    try {
      const folder = vscode.workspace.workspaceFolders?.[0];
      await next.request('initialize', {
        processId: process.pid,
        rootUri: folder ? folder.uri.toString() : null,
        capabilities: {
          textDocument: {
            publishDiagnostics: {},
            hover: { contentFormat: ['markdown'] },
            completion: { completionItem: { documentationFormat: ['markdown'] } },
          },
        },
      });
      next.notify('initialized', {});
      client = next;
      syncOpenDocuments();
      output.appendLine('Language server started.');
    } catch (error) {
      output.appendLine(`Language server failed to start: ${error?.stack ?? error}`);
      vscode.window.showErrorMessage(
        `8BitScript language server failed to start: ${error?.message ?? error}`,
      );
      await next.stop();
      if (client === next) client = undefined;
    } finally {
      starting = false;
    }
  }

  async function stop() {
    const current = client;
    client = undefined;
    collection.clear();
    if (current) await current.stop();
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(openDocument),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!client || !isEightBitScript(event.document)) return;
      client.notify('textDocument/didChange', {
        textDocument: {
          uri: event.document.uri.toString(),
          version: event.document.version,
        },
        contentChanges: [{ text: event.document.getText() }],
      });
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (!client || !isEightBitScript(document)) return;
      collection.delete(document.uri);
      client.notify('textDocument/didClose', {
        textDocument: { uri: document.uri.toString() },
      });
    }),
    vscode.languages.registerHoverProvider('8bitscript', {
      async provideHover(document, position) {
        if (!client) return undefined;
        const result = await client.request('textDocument/hover', {
          textDocument: { uri: document.uri.toString() },
          position: { line: position.line, character: position.character },
        });
        if (!result) return undefined;
        const value = typeof result.contents === 'string'
          ? result.contents
          : result.contents.value;
        const hover = new vscode.Hover(new vscode.MarkdownString(value));
        if (result.range) hover.range = toRange(result.range);
        return hover;
      },
    }),
    vscode.languages.registerCompletionItemProvider(
      '8bitscript',
      {
        async provideCompletionItems(document, position) {
          if (!client) return undefined;
          const result = await client.request('textDocument/completion', {
            textDocument: { uri: document.uri.toString() },
            position: { line: position.line, character: position.character },
          });
          const items = Array.isArray(result) ? result : result?.items ?? [];
          return items.map(toCompletion);
        },
      },
      ':',
      '<',
      '.',
    ),
  );

  return {
    start,
    stop,
    get running() {
      return client !== undefined || starting;
    },
  };
}

module.exports = { registerLanguageServer };
