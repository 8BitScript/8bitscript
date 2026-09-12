// The editor client. It is deliberately small: it knows how to find the
// 8BitScript toolchain and how to speak to it. It contains no knowledge of the
// language whatsoever.
//
// All the intelligence — diagnostics now, and hover, completion, and
// go-to-definition later — comes from `8bs lsp`, which is part of the toolchain
// rather than part of this extension. That is what lets other editors get the
// same behavior by running the same command. The side bar's launcher
// (launcherView.cjs, over runner.cjs) follows the same rule for building and
// running: it only ever starts the `8bs run`/`8bs build` commands a person
// would type.
//
// The LSP speaker is lspClient.cjs: Content-Length JSON-RPC over stdio, only
// the methods `8bs lsp` implements. Microsoft's vscode-languageclient is not
// a dependency.
//
// CommonJS on purpose: it is the entry format every version of the editor host
// loads without configuration.
const path = require('path');

const vscode = require('vscode');

const { BINARY, findToolchain } = require('./projects.cjs');
const { registerRunner } = require('./runner.cjs');
const { registerLauncherView } = require('./launcherView.cjs');
const { registerControllerView } = require('./controllerView.cjs');
const { registerLanguageServer } = require('./lsp.cjs');

let server;
let output;

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

/** Look for the toolchain and start the server, or explain why we cannot. */
function tryStart({ quiet } = {}) {
  if (server.running) return;

  const roots = searchRoots();
  for (const root of roots) {
    const toolchain = findToolchain(root);
    if (toolchain) {
      server.start(toolchain);
      return;
    }
  }

  output.appendLine(`No ${BINARY} found. Searched upward from:`);
  for (const root of roots) output.appendLine(`  ${root}`);
  if (!quiet) {
    vscode.window.showWarningMessage(
      '8BitScript compiler not found. Run: pnpm add -D @8bitscript/cli (or npm/yarn/bun)',
    );
  }
}

function activate(context) {
  output = vscode.window.createOutputChannel('8BitScript', { log: true });
  context.subscriptions.push(output);
  server = registerLanguageServer(context, output);

  // A .8bs file may be opened after activation, or in a project the first scan
  // could not see, so retry rather than giving up on the first miss.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.languageId === '8bitscript') tryStart({ quiet: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('8bitscript.restartServer', async () => {
      await server.stop();
      tryStart();
    }),
  );

  const projects = registerRunner(context, output);
  registerLauncherView(context, projects);
  // The Controller Setup panel shares the launcher's view of the world —
  // which project is selected, and what the toolchain says each machine
  // has — so it is handed the same Projects rather than building its own.
  registerControllerView(context, projects);

  tryStart();
}

function deactivate() {
  return server?.stop();
}

module.exports = { activate, deactivate };
