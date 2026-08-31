// The editor client. This is the whole extension's behaviour, and it is
// deliberately tiny: it knows how to find the 8BitScript toolchain and how to
// speak to it. It contains no knowledge of the language whatsoever.
//
// All the intelligence — diagnostics now, and hover, completion, and
// go-to-definition later — comes from `8bs lsp`, which is part of the toolchain
// rather than part of this extension. That is what lets other editors get the
// same behaviour by running the same command.
//
// CommonJS on purpose: it is the entry format every version of the editor host
// loads without configuration.
const path = require('path');
const fs = require('fs');

const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;
let output;

const BINARY = process.platform === 'win32' ? '8bs.cmd' : '8bs';

/**
 * Find the `8bs` binary that applies to a given path.
 *
 * The search walks up from the file itself rather than starting at the
 * workspace root, because in a monorepo the toolchain belongs to the project
 * the file is in, not to the directory the editor happens to have open. Opening
 * this repository at its root and editing examples/hello-vic/src/main.8bs has to
 * find examples/hello-vic/node_modules/.bin/8bs.
 */
function findToolchain(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', BINARY);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Every directory worth searching: open documents first, then folder roots. */
function searchRoots() {
  const roots = [];
  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === '8bitscript' && document.uri.scheme === 'file') {
      roots.push(path.dirname(document.uri.fsPath));
    }
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    roots.push(folder.uri.fsPath);
  }
  return roots;
}

function startClient(toolchain) {
  if (client) return;

  output.appendLine(`Starting language server: ${toolchain} lsp --stdio`);

  const run = { command: toolchain, args: ['lsp', '--stdio'], transport: TransportKind.stdio };
  client = new LanguageClient(
    '8bitscript',
    '8BitScript Language Server',
    { run, debug: run },
    {
      documentSelector: [{ scheme: 'file', language: '8bitscript' }],
      diagnosticCollectionName: '8bs',
      outputChannel: output,
    },
  );

  client.start().then(
    () => output.appendLine('Language server started.'),
    (error) => {
      output.appendLine(`Language server failed to start: ${error?.stack ?? error}`);
      vscode.window.showErrorMessage(
        `8BitScript language server failed to start: ${error?.message ?? error}`,
      );
      client = undefined;
    },
  );
}

/** Look for the toolchain and start the server, or explain why we cannot. */
function tryStart({ quiet } = {}) {
  if (client) return;

  const roots = searchRoots();
  for (const root of roots) {
    const toolchain = findToolchain(root);
    if (toolchain) {
      startClient(toolchain);
      return;
    }
  }

  output.appendLine(`No ${BINARY} found. Searched upward from:`);
  for (const root of roots) output.appendLine(`  ${root}`);
  if (!quiet) {
    vscode.window.showWarningMessage(
      '8BitScript compiler not found. Run: pnpm add -D @8bitscript/cli',
    );
  }
}

function activate(context) {
  output = vscode.window.createOutputChannel('8BitScript');
  context.subscriptions.push(output);

  // A .8bs file may be opened after activation, or in a project the first scan
  // could not see, so retry rather than giving up on the first miss.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.languageId === '8bitscript') tryStart({ quiet: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('8bitscript.restartServer', async () => {
      await client?.stop();
      client = undefined;
      tryStart();
    }),
  );

  tryStart();
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
