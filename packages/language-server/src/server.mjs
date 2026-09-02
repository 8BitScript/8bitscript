// The 8BitScript language server.
//
// It contains no language knowledge of its own. Every diagnostic it publishes
// comes from @8bitscript/compiler — the same call `8bs check` makes — so the
// squiggle in the editor and the error in CI can never disagree.
//
// Despite the package names, `vscode-languageserver` is an editor-agnostic LSP
// implementation. This server speaks the protocol over stdio, so any client
// that speaks LSP can drive it: `8bs lsp --stdio` is all an editor needs.
import { fileURLToPath } from 'node:url';

import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  MarkupKind,
  CompletionItemKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { analyze, getHoverInfo, getCompletions } from '@8bitscript/compiler';

const SEVERITY = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
};

export function start() {
  const connection = createConnection(ProposedFeatures.all);
  const documents = new TextDocuments(TextDocument);

  connection.onInitialize(() => ({
    capabilities: {
      // Full sync: files on this hardware are small, and incremental sync buys
      // nothing until the compiler can reuse a previous parse.
      textDocumentSync: TextDocumentSyncKind.Full,
      hoverProvider: true,
      completionProvider: { triggerCharacters: [':', '<'] },
    },
    serverInfo: { name: '8BitScript Language Server', version: '0.0.0' },
  }));

  /**
   * Analyse one document and publish the result.
   *
   * Import resolution needs a real path on disk, so it is enabled only for
   * `file:` documents. An untitled buffer still gets every lexical and checker
   * diagnostic; it just cannot be asked whether its imports exist.
   */
  const validate = (document) => {
    const text = document.getText();
    let path = null;
    if (document.uri.startsWith('file://')) {
      try {
        path = fileURLToPath(document.uri);
      } catch {
        path = null;
      }
    }
    const diagnostics = analyze(text, path ?? document.uri, {
      resolveImports: path !== null,
    }).map((d) => ({
      severity: SEVERITY[d.severity] ?? DiagnosticSeverity.Error,
      range: {
        start: document.positionAt(d.start),
        end: document.positionAt(d.start + d.length),
      },
      code: d.code,
      source: '8bs',
      message: d.message,
    }));
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
  };

  documents.onDidChangeContent((event) => validate(event.document));
  documents.onDidClose((event) =>
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] }),
  );

  // Both handlers below are protocol glue only: the compiler decides what a
  // position means (a built-in type, `volatile`, `@address`, ...), this file
  // just converts its answer to LSP shapes. No language knowledge lives here.
  connection.onHover((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const offset = document.offsetAt(params.position);
    const info = getHoverInfo(document.getText(), offset);
    if (!info) return null;

    return {
      contents: { kind: MarkupKind.Markdown, value: info.markdown },
      range: {
        start: document.positionAt(info.start),
        end: document.positionAt(info.start + info.length),
      },
    };
  });

  connection.onCompletion((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const offset = document.offsetAt(params.position);
    return getCompletions(document.getText(), offset).map((item) => ({
      label: item.label,
      kind: CompletionItemKind.TypeParameter,
      detail: item.detail,
      documentation: { kind: MarkupKind.Markdown, value: item.documentation },
      // Canonical names sort ahead of short aliases within the same list.
      sortText: `${item.sortRank}${item.label}`,
    }));
  });

  documents.listen(connection);
  connection.listen();
}
