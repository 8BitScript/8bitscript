// The 8BitScript language server.
//
// It contains no language knowledge of its own. Every diagnostic it publishes
// comes from @8bitscript/compiler — the same call `8bs check` makes — so the
// squiggle in the editor and the error in CI can never disagree.
//
// Despite the package names, `vscode-languageserver` is an editor-agnostic LSP
// implementation. This server speaks the protocol over stdio, so any client
// that speaks LSP can drive it: `8bs lsp --stdio` is all an editor needs.
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  InsertTextFormat,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { analyze, getHoverInfo, getCompletions, getDefinition, resolveImportAliases, sourceKindOf } from '@8bitscript/compiler';

// What the compiler calls a completion item, in LSP's vocabulary. The
// compiler says what kind of thing a name is (a type, a compile-time
// function, a unit constant); this file only translates.
const COMPLETION_KIND = {
  type: CompletionItemKind.TypeParameter,
  function: CompletionItemKind.Function,
  constant: CompletionItemKind.Constant,
  component: CompletionItemKind.Class,
  namespace: CompletionItemKind.Module,
  variable: CompletionItemKind.Variable,
};

const SEVERITY = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
};

// 8bitscript.config.ts is the current name; 8bs.config.ts (every project
// through 0.3.0) still loads — see packages/cli/src/config.mjs's
// CONFIG_FILENAMES, which this mirrors for the same reason it duplicates
// resolveFrameRate rather than importing it.
const CONFIG_FILENAMES = ['8bitscript.config.ts', '8bs.config.ts'];

/**
 * Walk upward from `dir` looking for 8bitscript.config.ts (or the older
 * 8bs.config.ts), so a document opened from src/ (or deeper) still finds
 * its project's config. Stops at the filesystem root.
 */
function findConfigPath(dir) {
  let current = dir;
  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = join(current, filename);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The project's `frameRate` (8bitscript.config.ts, default 60) for the document at
 * `filePath` — so `#frames(...)` diagnostics in the editor agree with what
 * `8bs build`/`8bs check` would actually report, the same invariant this
 * file's header comment already promises for every other diagnostic.
 *
 * Mirrors packages/cli/src/config.mjs's resolveFrameRate, duplicated rather
 * than imported: `@8bitscript/cli` already depends on this package (`8bs lsp
 * --stdio`), so importing it back here would cycle.
 *
 * The `?t=<mtime>` on the dynamic import is a cache-buster: Node's ESM
 * loader otherwise caches a resolved file URL for the life of the process,
 * so an edited 8bitscript.config.ts would need a server restart to take effect
 * without it.
 */
async function frameRateFor(filePath) {
  const config = await configFor(filePath);
  const frameRate = config?.frameRate;
  return Number.isInteger(frameRate) && frameRate > 0 ? frameRate : 60;
}

/** The project's config object for the document at `filePath`, or null without one (or with one that fails to load). */
async function configFor(filePath) {
  const configPath = findConfigPath(dirname(filePath));
  if (!configPath) return null;
  try {
    const { mtimeMs } = statSync(configPath);
    const module = await import(`${pathToFileURL(configPath).href}?t=${mtimeMs}`);
    return module.default ?? null;
  } catch {
    return null;
  }
}

/**
 * The one machine the project builds for, when its config names exactly
 * one target — the machine a target-dependent import (`@8bitscript/screen`,
 * one file per machine) is read *for* in hover, completion and Go to
 * Definition; see the compiler's intellisense `machineFor`. A project with
 * several targets, or none, has no single answer, and the compiler shows
 * the portable view with nothing singled out.
 */
async function projectMachineFor(filePath) {
  const config = await configFor(filePath);
  const targets = config?.targets;
  if (!targets || typeof targets !== 'object') return null;
  // `targets` is an array of names or an object keyed by them (docs/config.md).
  const names = Array.isArray(targets) ? targets.filter((name) => typeof name === 'string') : Object.keys(targets);
  return names.length === 1 ? names[0] : null;
}

/** Absolute import-alias directories from the project's `imports` block, or {}. */
async function importAliasesFor(filePath) {
  const configPath = findConfigPath(dirname(filePath));
  if (!configPath) return {};
  const config = await configFor(filePath);
  const resolved = resolveImportAliases(config?.imports, dirname(configPath));
  return resolved.ok ? resolved.importAliases : {};
}

/**
 * A document's absolute path on disk, or `null` for an `untitled:` buffer or
 * a URI that fails to parse as one. Shared by every handler below that needs
 * a real path — diagnostics' import resolution, and hover/completion's
 * member lookup (getHoverInfo/getCompletions's `options.path`) — so an
 * untitled buffer degrades the same honest way everywhere: the feature that
 * needs a path on disk is simply unavailable, not guessed at.
 */
/**
 * What a document is written in: the editor's language id decides for an
 * untitled buffer, the path's extension otherwise; null when neither says.
 */
function sourceKindFor(document, path) {
  if (document.languageId === '8bitextensible') return '.8bx';
  if (document.languageId === '8bitgraphics') return '.8bg';
  if (document.languageId === '8bitaudio') return '.8ba';
  return path ? sourceKindOf(path) : (document.languageId === '8bitscript' ? '.8bs' : null);
}

/** The text of a file on disk, or '' when it cannot be read — a range then lands at its start. */
function readTextOf(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function filePathOf(uri) {
  if (!uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * @param {{ checkout?: string|null }} [options]
 *   A local 8BitScript tree whose packages win over node_modules for
 *   `@8bitscript/*` — the same root `8bs lsp --checkout` names.
 */
export function start({ checkout } = {}) {
  const connection = createConnection(ProposedFeatures.all);
  const documents = new TextDocuments(TextDocument);

  connection.onInitialize(() => ({
    capabilities: {
      // Full sync: files on this hardware are small, and incremental sync buys
      // nothing until the compiler can reuse a previous parse.
      textDocumentSync: TextDocumentSyncKind.Full,
      hoverProvider: true,
      definitionProvider: true,
      // `.` triggers member completion (screen.bl| -> blank) on a named
      // import's own namespace; getCompletions checks isFactKeyPosition
      // first, so `#fact(video.|)` still completes fact keys rather than
      // being hijacked by a coincidentally-named import binding. `<` is a
      // type argument in `.8bs` and a tag in `.8bx`; `/` is the `</` that
      // closes one.
      completionProvider: { triggerCharacters: [':', '<', '.', '/'] },
    },
    serverInfo: { name: '8BitScript Language Server', version: '0.1.0' },
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
    const path = filePathOf(document.uri);
    const frameRate = path ? await frameRateFor(path) : 60;
    const importAliases = path ? await importAliasesFor(path) : {};
    // Two things can happen while frameRateFor() awaits the filesystem: a
    // newer edit can land (the TextDocument is mutated in place, not
    // replaced, so `document.version` — not object identity — is what
    // reveals that), or the document can close (onDidClose already
    // published empty diagnostics for it; publishing again here would
    // resurrect them). Either way, an out-of-order publish would be wrong.
    if (document.version !== version || documents.get(document.uri) !== document) return;
    const sourceKind = sourceKindFor(document, path);
    const diagnostics = analyze(text, path ?? document.uri, {
      resolveImports: path !== null,
      frameRate,
      checkout,
      importAliases,
      ...(sourceKind ? { sourceKind } : {}),
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
  connection.onHover(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const offset = document.offsetAt(params.position);
    const path = filePathOf(document.uri);
    const machine = path ? await projectMachineFor(path) : null;
    const importAliases = path ? await importAliasesFor(path) : {};
    const info = getHoverInfo(document.getText(), offset, {
      path, checkout, sourceKind: sourceKindFor(document, path), machine, importAliases,
    });
    if (!info) return null;

    return {
      contents: { kind: MarkupKind.Markdown, value: info.markdown },
      range: {
        start: document.positionAt(info.start),
        end: document.positionAt(info.start + info.length),
      },
    };
  });

  connection.onCompletion(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const offset = document.offsetAt(params.position);
    const path = filePathOf(document.uri);
    const machine = path ? await projectMachineFor(path) : null;
    const importAliases = path ? await importAliasesFor(path) : {};
    return getCompletions(document.getText(), offset, {
      path, checkout, sourceKind: sourceKindFor(document, path), machine, importAliases,
    }).map((item) => ({
      label: item.label,
      kind: COMPLETION_KIND[item.kind] ?? CompletionItemKind.TypeParameter,
      detail: item.detail,
      documentation: { kind: MarkupKind.Markdown, value: item.documentation },
      // Canonical names sort ahead of short aliases within the same list.
      sortText: `${item.sortRank}${item.label}`,
      // Present only when what gets typed differs from the label — the
      // `#` of a `#frames` already in the buffer, say — and a snippet when
      // it has cursor stops (a prop's `row={$1}`).
      ...(item.insertText ? { insertText: item.insertText } : {}),
      ...(item.snippet ? { insertTextFormat: InsertTextFormat.Snippet } : {}),
    }));
  });

  // Go to definition: the compiler answers with a file and a range; a
  // location in another file is that file's own URI.
  connection.onDefinition(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const offset = document.offsetAt(params.position);
    const path = filePathOf(document.uri);
    const machine = path ? await projectMachineFor(path) : null;
    const importAliases = path ? await importAliasesFor(path) : {};
    const target = getDefinition(document.getText(), offset, {
      path, checkout, sourceKind: sourceKindFor(document, path), machine, importAliases,
    });
    if (!target) return null;
    const uri = pathToFileURL(target.path).href;
    const inOther = documents.get(uri);
    const other = inOther ?? TextDocument.create(uri, '8bitscript', 0, readTextOf(target.path));
    return {
      uri,
      range: { start: other.positionAt(target.start), end: other.positionAt(target.start + target.length) },
    };
  });

  documents.listen(connection);
  connection.listen();
}
