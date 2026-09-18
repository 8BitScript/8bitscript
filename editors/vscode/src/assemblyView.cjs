// "8BitScript: View Generated Assembly" — runs `8bs build --debug`
// (runner.cjs already knows how to run every other `8bs` action; this
// reuses the exact same cliCommand()/execFile() shape rather than
// inventing a second way to invoke the toolchain, through the
// `buildArgsFor` callback runner.cjs supplies) and shows the generated
// instructions for one source file in a read-only virtual document beside
// the editor, colored by the `8bitscript-asm` grammar (syntaxes/asm-8bs.
// tmLanguage.json) and kept live: saving any file in the same project
// rebuilds every open tab in place, without moving the reader's scroll
// position or stealing focus from whatever they were editing.
//
// No compiler logic lives here — everything shown comes straight off the
// `.8bs.debug.json` the compiler already wrote (packages/compiler/src/mos/
// debug.ts), read as data. The extension stays thin: it runs the CLI,
// parses JSON, and formats it, the same as every other panel here.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const vscode = require('vscode');

const SCHEME = '8bitscript-asm';
const ASM_LANGUAGE = '8bitscript-asm';

function hexByte(value) {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function hexAddress(value) {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** Same file, allowing for one absolute and one differently-cased/slashed spelling of it — module.file (the linker's own path) and a VS Code document's fsPath usually agree exactly, but not on every platform. */
function samePath(a, b) {
  return path.resolve(a) === path.resolve(b) || path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

/** Whether `filePath` is `projectDir` or lives somewhere under it — how a saved file is matched back to the open assembly tabs its project owns. */
function isWithinProject(filePath, projectDir) {
  const rel = path.relative(path.resolve(projectDir), path.resolve(filePath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The instructions whose source span covers `offset` exactly, or — nothing
 * starts exactly under the cursor (mid-expression, a blank line, an
 * optimized-away statement) — the nearest statement at or before it. The
 * same "no fabricated relationship" rule the debug map itself follows:
 * shown as a fallback, not claimed as exact. Used only to mark the reader's
 * starting point in the view; never to decide what the view contains.
 */
function instructionsNearCursor(instructions, offset) {
  const atCursor = instructions.filter((instr) => offset >= instr.source.start && offset < instr.source.start + instr.source.length);
  if (atCursor.length > 0) return new Set(atCursor);
  const nearest = instructions.reduce((best, instr) => (
    instr.source.start <= offset && (!best || instr.source.start > best.source.start) ? instr : best
  ), null);
  if (!nearest) return new Set();
  return new Set(instructions.filter((instr) => instr.source.start === nearest.source.start));
}

/**
 * Renders one source file's whole set of generated instructions into the
 * virtual document's text, grouped by function/origin the same way the
 * .lst file is — and builds the line -> source map the selection listener
 * uses to jump back. The listing is the whole file, not just the
 * statement under the cursor, so it stays the same document across a
 * live-reload refresh regardless of where the cursor happens to be —
 * `highlight` marks a starting point for the reader, it never narrows what
 * is shown.
 */
function renderView(sourceFile, instructions, highlight) {
  const lines = [`; generated assembly for ${path.basename(sourceFile)}`, `; ${sourceFile}`, ''];
  const lineSources = [null, null, null];
  // Distinct from a real `function: null` (compiler-generated code with no
  // enclosing function is a legitimate group of its own) — a symbol no
  // debug-map instruction could ever carry, so it only ever matches before
  // the first instruction.
  const NONE = Symbol('no group yet');
  let lastFn = NONE;
  let lastOrigin = NONE;
  for (const instr of instructions) {
    if (instr.function !== lastFn || instr.origin !== lastOrigin) {
      if (lastFn !== NONE) { lines.push(''); lineSources.push(null); }
      const header = instr.function
        ? `; function: ${instr.function}${instr.origin ? ` (inlined from ${instr.origin})` : ''}`
        : '; (compiler-generated — no direct source)';
      lines.push(header, '');
      lineSources.push(null, null);
      lastFn = instr.function;
      lastOrigin = instr.origin;
    }
    const marker = highlight.has(instr) ? '>' : ' ';
    const bytes = instr.bytes.map(hexByte).join(' ').padEnd(9);
    const reason = instr.generated ? `  ; ${instr.generated.reason}` : '';
    lines.push(`${marker} $${hexAddress(instr.address)}   ${bytes}   ${instr.assembly}${reason}`);
    lineSources.push(instr.source);
  }
  lines.push('');
  lineSources.push(null);
  return { text: lines.join('\n'), lineSources };
}

class AssemblyViewController {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {{appendLine(line: string): void}} output
   * @param {(resolved: {project, target, hardware?, region?, system?}, opts?: {silent?: boolean}) => Promise<{invocation, cwd, args}|null>} buildArgsFor
   *   Everything machine-specific (toolchain, hardware, region, checkout) —
   *   runner.cjs already knows how to resolve all of that for every other
   *   command, so this controller never duplicates it.
   */
  constructor(context, output, buildArgsFor) {
    this.output = output;
    this.buildArgsFor = buildArgsFor;
    this.documents = new Map(); // uri string -> { text, lineSources }
    this.builds = new Map(); // uri string -> { project, target, sourceFile }
    this.pending = new Map(); // uri string -> promise chain, serializing refreshes
    this.pendingReveals = new Map(); // uri string -> { topLine, selection } captured just before a background refresh's fire()
    this.emitter = new vscode.EventEmitter();
    context.subscriptions.push(
      this.emitter,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        onDidChange: this.emitter.event,
        provideTextDocumentContent: (uri) => this.documents.get(uri.toString())?.text ?? '; no data',
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => this.onSelection(event)),
      vscode.workspace.onDidSaveTextDocument((document) => this.onSourceSaved(document)),
      // A content provider's own onDidChange only *asks* VS Code to
      // re-fetch and diff the document; the actual text lands some time
      // after fire() returns, as an ordinary edit that raises this event.
      // Restoring scroll/selection has to wait for that edit, or it runs
      // against the viewport VS Code is about to reset — see
      // refreshInPlace()/onDocumentChanged() below.
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event)),
    );
  }

  onSelection(event) {
    const document = event.textEditor.document;
    if (document.uri.scheme !== SCHEME) return;
    const entry = this.documents.get(document.uri.toString());
    if (!entry) return;
    const line = event.selections[0]?.active.line;
    const source = entry.lineSources[line];
    if (!source) return;
    // Only ever navigates on an explicit selection change the person made
    // by clicking or moving the cursor in the asm view — there is no
    // listener on the source side, so this can't ping-pong between the two
    // editors the way a fully live bidirectional sync would need to guard
    // against (see the plan's own "ultimate direction" section: this is
    // the one-shot version of it).
    this.revealSource(source);
  }

  async revealSource(source) {
    const uri = vscode.Uri.file(source.file);
    let document;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (error) {
      this.output.appendLine(`8BitScript: could not open ${source.file}: ${error.message}`);
      return;
    }
    const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
    const start = document.positionAt(source.start);
    const end = document.positionAt(source.start + source.length);
    const range = new vscode.Range(start, end);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  uriFor(target, sourceFile) {
    return vscode.Uri.parse(`${SCHEME}:/${target}/${path.basename(sourceFile)}.asm`);
  }

  /**
   * Runs `8bs build --debug` for `target`, filters the debug map down to
   * `sourceFile`'s own instructions, and renders them. Returns null (having
   * already reported why, unless `silent`) rather than throwing — a caller
   * refreshing a tab in the background treats null as "keep what's already
   * there," never as license to blank it.
   */
  async buildListing(project, target, sourceFile, { cursorOffset, silent = false } = {}) {
    const report = (message, isError) => {
      this.output.appendLine(message);
      if (silent) return;
      if (isError) vscode.window.showErrorMessage(message);
      else vscode.window.showInformationMessage(message);
    };
    const resolved = await this.buildArgsFor({ project, target }, { silent });
    if (!resolved) return null;
    const { invocation, cwd, args: baseArgs } = resolved;
    const args = [...invocation.args, ...baseArgs, '--debug'];
    this.output.appendLine(`$ 8bs ${args.join(' ')}`);
    let stdout;
    try {
      stdout = await new Promise((resolvePromise, reject) => {
        execFile(
          invocation.command, args,
          { cwd, maxBuffer: 8 * 1024 * 1024, ...(invocation.env ? { env: { ...process.env, ...invocation.env } } : {}) },
          (error, out, stderr) => {
            if (error) { reject(new Error(stderr || error.message)); return; }
            resolvePromise(out);
          },
        );
      });
    } catch (error) {
      report(`8bs build --debug failed: ${error.message}`, true);
      return null;
    }
    const match = /^debug map: (.+)$/m.exec(stdout);
    if (!match) {
      report('8bs build --debug did not report a debug map path — is the toolchain up to date?', true);
      return null;
    }
    let debugMap;
    try {
      debugMap = JSON.parse(fs.readFileSync(match[1].trim(), 'utf8'));
    } catch (error) {
      report(`Could not read ${match[1].trim()}: ${error.message}`, true);
      return null;
    }
    const fromThisFile = (debugMap.instructions ?? []).filter((instr) => instr.source && samePath(instr.source.file, sourceFile));
    if (fromThisFile.length === 0) {
      report(`No generated instructions are attributed to ${path.basename(sourceFile)} in the debug map.`, false);
      return null;
    }
    const highlight = cursorOffset === undefined ? new Set() : instructionsNearCursor(fromThisFile, cursorOffset);
    const { text, lineSources } = renderView(sourceFile, fromThisFile, highlight);
    return { uri: this.uriFor(target, sourceFile), text, lineSources };
  }

  /**
   * Opens (or, if this exact machine/file is already open, reveals) the
   * generated-assembly tab, focusing it beside `viewColumn` — the one
   * user-facing entry point every command below funnels through.
   */
  async render(project, target, sourceFile, { viewColumn = vscode.ViewColumn.Beside, cursorOffset } = {}) {
    const built = await this.buildListing(project, target, sourceFile, { cursorOffset });
    if (!built) return;
    const key = built.uri.toString();
    const wasOpen = this.documents.has(key);
    this.documents.set(key, { text: built.text, lineSources: built.lineSources });
    this.builds.set(key, { project, target, sourceFile });
    if (wasOpen) this.emitter.fire(built.uri);
    const document = await vscode.workspace.openTextDocument(built.uri);
    if (!wasOpen) {
      try { await vscode.languages.setTextDocumentLanguage(document, ASM_LANGUAGE); } catch { /* best-effort coloring; an unopened document still shows fine as plain text */ }
    }
    // Already open somewhere? Reveal it there rather than opening a second
    // copy beside whatever's currently active.
    const existing = (vscode.window.visibleTextEditors ?? []).find((editor) => editor.document.uri.toString() === key);
    await vscode.window.showTextDocument(document, { viewColumn: existing?.viewColumn ?? viewColumn, preview: false });
  }

  /** `editor`'s own file, at `resolved.target` — the plain "View Generated Assembly" command. */
  async showForCursor(editor, resolved) {
    const sourceFile = editor.document.uri.fsPath;
    const offset = editor.document.offsetAt(editor.selection.active);
    await this.render(resolved.project, resolved.target, sourceFile, { cursorOffset: offset });
  }

  /** Same file, a machine the reader picks — from the source editor's own command, or the asm tab's own "Open For Another Machine" button. `preferred` sorts first and is marked, the same way runner.cjs's own pickTarget() orders its system quickpick. */
  async pickTarget(candidates, preferred, placeHolder) {
    const offered = candidates.filter((target) => target !== 'web');
    if (offered.length === 0) {
      vscode.window.showInformationMessage('This project has no machine with a generated-assembly listing to show (WebAssembly has none).');
      return undefined;
    }
    if (offered.length === 1) return offered[0];
    const ordered = [...offered].sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
    const picked = await vscode.window.showQuickPick(
      ordered.map((target) => ({ label: target, description: target === preferred ? 'current' : undefined, target })),
      { placeHolder },
    );
    return picked?.target;
  }

  async pickAndShow(editor, resolved) {
    const target = await this.pickTarget(resolved.project.targets ?? [], resolved.target, `View the generated assembly for which machine?`);
    if (!target) return;
    await this.showForCursor(editor, { ...resolved, target });
  }

  async openForMachine(asmEditor) {
    if (!asmEditor || asmEditor.document.uri.scheme !== SCHEME) return;
    const info = this.builds.get(asmEditor.document.uri.toString());
    if (!info) return;
    const target = await this.pickTarget(info.project.targets ?? [], info.target, `Open ${path.basename(info.sourceFile)}'s generated assembly for which machine?`);
    if (!target || target === info.target) return;
    await this.render(info.project, target, info.sourceFile);
  }

  /**
   * Rebuilds every open assembly tab whose project contains the file that
   * was just saved, in place: no tab gains or loses focus, and each tab's
   * own scroll position and selection are restored after its content is
   * replaced. A tab whose rebuild fails (a mid-edit syntax error, most
   * often) is left showing its last successful build — buildListing()
   * reports the failure to the output channel and returns null, which this
   * never treats as "blank the tab."
   */
  onSourceSaved(document) {
    if (!/\.(8bs|8bx)$/.test(document.fileName)) return Promise.resolve();
    const refreshes = [];
    for (const [key, info] of this.builds) {
      if (!isWithinProject(document.fileName, info.project.dir)) continue;
      const previous = this.pending.get(key) ?? Promise.resolve();
      const next = previous.then(() => this.refreshInPlace(key, info)).catch((error) => {
        this.output.appendLine(`8BitScript: assembly view refresh failed: ${error.message}`);
      });
      this.pending.set(key, next);
      refreshes.push(next);
    }
    return Promise.all(refreshes);
  }

  async refreshInPlace(key, info) {
    const built = await this.buildListing(info.project, info.target, info.sourceFile, { silent: true });
    if (!built) return;
    const editor = (vscode.window.visibleTextEditors ?? []).find((candidate) => candidate.document.uri.toString() === key);
    const topLine = editor?.visibleRanges?.[0]?.start.line;
    if (editor && topLine !== undefined) this.pendingReveals.set(key, { topLine, selection: editor.selection });
    this.documents.set(key, { text: built.text, lineSources: built.lineSources });
    // Only *asks* VS Code to re-fetch this document's content; the actual
    // text lands afterward, as an edit that fires onDidChangeTextDocument —
    // onDocumentChanged() does the reveal once that edit has really landed.
    this.emitter.fire(built.uri);
  }

  /** Restores the scroll position and selection a refresh captured, once the refreshed content has actually landed in the document (never before — see refreshInPlace()'s own comment). */
  onDocumentChanged(event) {
    const key = event.document.uri.toString();
    const pending = this.pendingReveals.get(key);
    if (!pending) return;
    this.pendingReveals.delete(key);
    const editor = (vscode.window.visibleTextEditors ?? []).find((candidate) => candidate.document.uri.toString() === key);
    if (!editor) return;
    const lastLine = Math.max((this.documents.get(key)?.text.split('\n').length ?? 1) - 1, 0);
    const line = Math.min(pending.topLine, lastLine);
    const position = new vscode.Position(line, 0);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
    if (pending.selection) editor.selection = pending.selection;
  }
}

module.exports = { AssemblyViewController, SCHEME, ASM_LANGUAGE, renderView, samePath, isWithinProject, instructionsNearCursor };
