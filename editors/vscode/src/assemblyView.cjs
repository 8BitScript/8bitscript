// "8BitScript: View Generated Assembly" — runs `8bs build --debug`
// (runner.cjs already knows how to run every other `8bs` action; this
// reuses the exact same cliCommand()/execFile() shape rather than
// inventing a second way to invoke the toolchain) and shows the generated
// instructions for the cursor's source location in a read-only virtual
// document beside the editor.
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

/**
 * Renders the instructions for one source file into the virtual document's
 * text, grouped by function/origin the same way the .lst file is — and
 * builds the line -> source map showForCursor's own selection listener
 * uses to jump back. `highlight` is the exact instruction set the cursor's
 * own span matched; everything else in the same function is shown too, for
 * context, but not marked.
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
  constructor(context, output) {
    this.output = output;
    this.documents = new Map(); // uri string -> { text, lineSources }
    this.emitter = new vscode.EventEmitter();
    context.subscriptions.push(
      this.emitter,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        onDidChange: this.emitter.event,
        provideTextDocumentContent: (uri) => this.documents.get(uri.toString())?.text ?? '; no data',
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => this.onSelection(event)),
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

  /**
   * Runs `8bs build --debug` with `baseArgs` (runner.cjs's own
   * commandArgs() output, so hardware/region/checkout match whatever a
   * normal Build would use), finds the instructions generated for
   * `editor`'s file and cursor, and opens/refreshes the virtual document.
   */
  async showForCursor(editor, invocation, cwd, baseArgs) {
    const args = [...invocation.args, ...baseArgs, '--debug'];
    this.output.appendLine(`$ 8bs ${args.join(' ')}`);
    let stdout;
    try {
      stdout = await new Promise((resolve, reject) => {
        execFile(
          invocation.command, args,
          { cwd, maxBuffer: 8 * 1024 * 1024, ...(invocation.env ? { env: { ...process.env, ...invocation.env } } : {}) },
          (error, out, stderr) => {
            if (error) { reject(new Error(stderr || error.message)); return; }
            resolve(out);
          },
        );
      });
    } catch (error) {
      vscode.window.showErrorMessage(`8bs build --debug failed: ${error.message}`);
      this.output.appendLine(error.message);
      return;
    }
    const match = /^debug map: (.+)$/m.exec(stdout);
    if (!match) {
      vscode.window.showErrorMessage('8bs build --debug did not report a debug map path — is the toolchain up to date?');
      return;
    }
    const debugMapPath = match[1].trim();
    let debugMap;
    try {
      debugMap = JSON.parse(fs.readFileSync(debugMapPath, 'utf8'));
    } catch (error) {
      vscode.window.showErrorMessage(`Could not read ${debugMapPath}: ${error.message}`);
      return;
    }

    const sourceFile = editor.document.uri.fsPath;
    const offset = editor.document.offsetAt(editor.selection.active);
    const fromThisFile = (debugMap.instructions ?? []).filter((instr) => instr.source && samePath(instr.source.file, sourceFile));
    if (fromThisFile.length === 0) {
      vscode.window.showInformationMessage(`No generated instructions are attributed to ${path.basename(sourceFile)} in the debug map.`);
      return;
    }
    let atCursor = fromThisFile.filter((instr) => offset >= instr.source.start && offset < instr.source.start + instr.source.length);
    if (atCursor.length === 0) {
      // Nothing starts exactly under the cursor (mid-expression, a blank
      // line, an optimized-away statement) — fall back to the nearest
      // statement at or before it, the same "no fabricated relationship"
      // rule the debug map itself follows: shown as a fallback, not
      // claimed as exact.
      const nearest = fromThisFile.reduce((best, instr) => (
        instr.source.start <= offset && (!best || instr.source.start > best.source.start) ? instr : best
      ), null);
      if (nearest) atCursor = fromThisFile.filter((instr) => instr.source.start === nearest.source.start);
    }
    if (atCursor.length === 0) {
      vscode.window.showInformationMessage('No generated instructions found at or before the cursor in this file.');
      return;
    }
    // The whole function those instructions belong to, for context — not
    // just the matched span — grouped the same way the .lst file groups.
    const functions = new Set(atCursor.map((instr) => instr.function));
    const shown = fromThisFile.filter((instr) => functions.has(instr.function));
    const highlight = new Set(atCursor);
    const { text, lineSources } = renderView(sourceFile, shown, highlight);

    const uri = vscode.Uri.parse(`${SCHEME}:/${path.basename(sourceFile)}.asm?${Date.now()}`);
    this.documents.set(uri.toString(), { text, lineSources });
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }
}

module.exports = { AssemblyViewController, SCHEME, renderView, samePath };
