// The 8BitScript language server.
//
// It contains no language knowledge of its own. Every diagnostic it publishes
// comes from @8bitscript/compiler — the same call `8bs check` makes — so the
// squiggle in the editor and the error in CI can never disagree.
//
// Despite the package names, `vscode-languageserver` is an editor-agnostic LSP
// implementation. This server speaks the protocol over stdio, so any client
// that speaks LSP can drive it: `8bs lsp --stdio` is all an editor needs.
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * Walk upward from `dir` looking for 8bs.config.ts, so a document opened
 * from src/ (or deeper) still finds its project's config. Stops at the
 * filesystem root.
 */
function findConfigPath(dir) {
  let current = dir;
  for (;;) {
    const candidate = join(current, '8bs.config.ts');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The project's `frameRate` (8bs.config.ts, default 60) for the document at
 * `filePath` — so `frames(...)` diagnostics in the editor agree with what
 * `8bs build`/`8bs check` would actually report, the same invariant this
 * file's header comment already promises for every other diagnostic.
 *
 * Mirrors packages/cli/src/config.mjs's resolveFrameRate, duplicated rather
 * than imported: `@8bitscript/cli` already depends on this package (`8bs lsp
 * --stdio`), so importing it back here would cycle.
 *
 * The `?t=<mtime>` on the dynamic import is a cache-buster: Node's ESM
 * loader otherwise caches a resolved file URL for the life of the process,
 * so an edited 8bs.config.ts would need a server restart to take effect
 * without it.
 */
async function frameRateFor(filePath) {
  const configPath = findConfigPath(dirname(filePath));
  if (!configPath) return 60;
  try {
    const { mtimeMs } = statSync(configPath);
    const module = await import(`${pathToFileURL(configPath).href}?t=${mtimeMs}`);
    const frameRate = module.default?.frameRate;
    return Number.isInteger(frameRate) && frameRate > 0 ? frameRate : 60;
  } catch {
    return 60;
  }
}

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
  const validate = async (document) => {
    const text = document.getText();
    const { version } = document;
    let path = null;
    if (document.uri.startsWith('file://')) {
      try {
        path = fileURLToPath(document.uri);
      } catch {
        path = null;
      }
    }
    const frameRate = path ? await frameRateFor(path) : 60;
    // Two things can happen while frameRateFor() awaits the filesystem: a
    // newer edit can land (the TextDocument is mutated in place, not
    // replaced, so `document.version` — not object identity — is what
    // reveals that), or the document can close (onDidClose already
    // published empty diagnostics for it; publishing again here would
    // resurrect them). Either way, an out-of-order publish would be wrong.
    if (document.version !== version || documents.get(document.uri) !== document) return;
    const diagnostics = analyze(text, path ?? document.uri, {
      resolveImports: path !== null,
      frameRate,
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
