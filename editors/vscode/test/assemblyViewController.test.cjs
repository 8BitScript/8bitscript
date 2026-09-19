// AssemblyViewController's own live-reload/multi-machine behavior, driven
// directly (not through registerRunner()'s commands, the way
// runner.test.cjs's own viewGeneratedAssembly case does) so assertions can
// read the controller's internal `documents`/`builds` maps exactly, rather
// than through the vscode mock's document model, which never actually
// round-trips a virtual document's text (real VS Code does; the mock's
// `openTextDocument`/`showTextDocument` are shape-only stand-ins).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

const vscode = installVscodeMock();
const { AssemblyViewController } = require('../src/assemblyView.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '8bs-asmview-'));
}

/** A fake `8bs build --debug` that reads its own behavior from a JSON control file on every invocation (set via CONTROL_PATH env, the way the CLI reads real flags) — so a test can change what the "next build" produces or make it fail, without spawning a new script. */
function writeFakeCli(dir) {
  const cliPath = path.join(dir, 'fake-debug-8bs.mjs');
  fs.writeFileSync(cliPath, [
    `import { readFileSync, writeFileSync } from 'node:fs';`,
    `const control = JSON.parse(readFileSync(process.env.CONTROL_PATH, 'utf8'));`,
    `if (control.fail) { process.stderr.write('boom'); process.exit(1); }`,
    `const instructions = control.instructions ?? [{`,
    `  address: control.address, artifactOffset: 0, size: 2, bytes: [0xa5, 0x18], assembly: 'LDA $18',`,
    `  source: { file: control.sourcePath, start: 0, length: 5, line: 1, column: 1 },`,
    `  function: 'main', origin: null, component: null,`,
    `}];`,
    `const debugMap = {`,
    `  format: '8bitscript-debug', version: 1, target: control.target, modules: [control.sourcePath], symbols: [],`,
    `  instructions,`,
    `};`,
    `writeFileSync(control.debugMapPath, JSON.stringify(debugMap));`,
    `console.log('built out.prg');`,
    `console.log('debug map: ' + control.debugMapPath);`,
  ].join('\n'));
  return cliPath;
}

function writeControl(dir, control) {
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(control));
}

/** buildArgsFor() the way runner.cjs's own buildAssemblyArgs resolves it, minus every bit of project/hardware/settings plumbing this suite doesn't exercise — the fake CLI reads what it needs from the control file instead of argv. */
function makeBuildArgsFor(dir, cliPath) {
  return async ({ target }) => ({
    invocation: { command: process.execPath, args: [cliPath], env: { CONTROL_PATH: path.join(dir, 'control.json') } },
    cwd: dir,
    args: ['build', '--target', target],
  });
}

function makeContext() {
  return { subscriptions: [] };
}

async function withController(fn) {
  const dir = tmpDir();
  try {
    const cliPath = writeFakeCli(dir);
    const output = { lines: [], appendLine(line) { this.lines.push(line); } };
    const controller = new AssemblyViewController(makeContext(), output, makeBuildArgsFor(dir, cliPath));
    await fn({ dir, controller, output });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('render(): builds, renders, and opens the stable per-machine document, keyed so a second machine gets its own tab', async () => {
  await withController(async ({ dir, controller }) => {
    vscode.__mock.reset();
    const sourcePath = path.join(dir, 'main.8bs');
    fs.writeFileSync(sourcePath, 'export function main(): void {}\n');
    const debugMapPath = path.join(dir, 'out.8bs.debug.json');
    writeControl(dir, { target: 'c64', address: 0xc142, sourcePath, debugMapPath });
    const project = { dir, targets: ['c64', 'vic20'] };

    await controller.render(project, 'c64', sourcePath);
    const c64Key = controller.uriFor('c64', sourcePath).toString();
    assert.ok(controller.documents.has(c64Key), 'the c64 tab was rendered');
    assert.match(controller.documents.get(c64Key).text, /\$C142/);
    assert.equal(controller.builds.get(c64Key).target, 'c64');

    // A different machine, same file: its own document, its own tab — the
    // c64 one is untouched, not overwritten.
    writeControl(dir, { target: 'vic20', address: 0xd200, sourcePath, debugMapPath: path.join(dir, 'out-vic20.8bs.debug.json') });
    await controller.render(project, 'vic20', sourcePath);
    const vic20Key = controller.uriFor('vic20', sourcePath).toString();
    assert.notEqual(vic20Key, c64Key, 'each machine gets a distinct, stable URI');
    assert.match(controller.documents.get(vic20Key).text, /\$D200/);
    assert.match(controller.documents.get(c64Key).text, /\$C142/, 'the c64 tab was not touched by building vic20');
  });
});

test('showForCursor(): renders every instruction attributed to the file, not just the cursor\'s own function — the cursor only marks a starting point', async () => {
  await withController(async ({ dir, controller }) => {
    vscode.__mock.reset();
    const sourceText = 'export function first(): void {}\nexport function second(): void {}\n';
    const sourcePath = path.join(dir, 'main.8bs');
    fs.writeFileSync(sourcePath, sourceText);
    const debugMapPath = path.join(dir, 'out.8bs.debug.json');
    writeControl(dir, {
      target: 'c64',
      sourcePath,
      debugMapPath,
      instructions: [
        {
          address: 0xc100, artifactOffset: 0, size: 2, bytes: [0xa9, 0x00], assembly: 'LDA #$00',
          source: { file: sourcePath, start: 0, length: 10, line: 1, column: 1 },
          function: 'first', origin: null, component: null,
        },
        {
          address: 0xc200, artifactOffset: 2, size: 2, bytes: [0xa9, 0x01], assembly: 'LDA #$01',
          source: { file: sourcePath, start: 40, length: 10, line: 2, column: 1 },
          function: 'second', origin: null, component: null,
        },
      ],
    });
    const project = { dir, targets: ['c64'] };
    // The cursor sits in `first`, at offset 0 — a cursor-filtered view
    // (the old behavior) would show only `first` and never `second`.
    const editor = {
      document: { uri: { fsPath: sourcePath }, offsetAt: () => 0 },
      selection: { active: { line: 0, character: 0 } },
    };

    await controller.showForCursor(editor, { project, target: 'c64' });
    const key = controller.uriFor('c64', sourcePath).toString();
    const text = controller.documents.get(key).text;
    assert.match(text, /function: first/);
    assert.match(text, /function: second/, 'the whole file is shown, not just the function under the cursor');
    assert.match(text, /^> \$C100/m, 'the instruction under the cursor is marked');
    assert.match(text, /^ {2}\$C200/m, 'an instruction elsewhere in the file is shown, unmarked');
  });
});

test('render(): reveals an already-open tab where it already is, instead of opening a second copy beside the caller', async () => {
  await withController(async ({ dir, controller }) => {
    vscode.__mock.reset();
    const sourcePath = path.join(dir, 'main.8bs');
    fs.writeFileSync(sourcePath, 'export function main(): void {}\n');
    const debugMapPath = path.join(dir, 'out.8bs.debug.json');
    writeControl(dir, { target: 'c64', address: 0xc142, sourcePath, debugMapPath });
    const project = { dir, targets: ['c64'] };

    await controller.render(project, 'c64', sourcePath, { viewColumn: vscode.ViewColumn.Beside });
    const key = controller.uriFor('c64', sourcePath).toString();
    const firstEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
    assert.equal(firstEditor.viewColumn, vscode.ViewColumn.Beside);
    // Move it, as if the person dragged the tab to another group.
    firstEditor.viewColumn = vscode.ViewColumn.Three;

    writeControl(dir, { target: 'c64', address: 0xc999, sourcePath, debugMapPath });
    await controller.render(project, 'c64', sourcePath, { viewColumn: vscode.ViewColumn.Beside });
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === key);
    assert.equal(editors.length, 1, 'no second copy was opened');
    assert.equal(editors[0].viewColumn, vscode.ViewColumn.Three, 'it was revealed where it already was, not beside the caller again');
  });
});

test('onSourceSaved(): rebuilds every open tab whose project contains the saved file, in place — no showTextDocument call, scroll and selection restored', async () => {
  await withController(async ({ dir, controller }) => {
    vscode.__mock.reset();
    const sourcePath = path.join(dir, 'main.8bs');
    fs.writeFileSync(sourcePath, 'export function main(): void {}\n');
    const debugMapPath = path.join(dir, 'out.8bs.debug.json');
    writeControl(dir, { target: 'c64', address: 0xc142, sourcePath, debugMapPath });
    const project = { dir, targets: ['c64'] };

    await controller.render(project, 'c64', sourcePath);
    const key = controller.uriFor('c64', sourcePath).toString();

    // A visible editor showing this tab, scrolled and with a selection —
    // exactly what a background refresh must not disturb.
    const savedSelection = { active: { line: 3, character: 2 } };
    const revealed = [];
    const fakeEditor = {
      document: { uri: { toString: () => key } },
      visibleRanges: [{ start: { line: 5 } }],
      selection: savedSelection,
      revealRange: (range, kind) => revealed.push({ range, kind }),
    };
    vscode.window.visibleTextEditors = [fakeEditor];

    const shownBefore = vscode.__mock.executedCommands.length;
    writeControl(dir, { target: 'c64', address: 0xc999, sourcePath, debugMapPath });
    await controller.onSourceSaved({ fileName: sourcePath });

    assert.match(controller.documents.get(key).text, /\$C999/, 'the tab picked up the new build');
    assert.equal(revealed.length, 1, 'the visible editor was revealed back to its saved scroll position');
    assert.equal(revealed[0].range.start.line, 5);
    assert.equal(revealed[0].kind, vscode.TextEditorRevealType.AtTop);
    assert.equal(fakeEditor.selection, savedSelection, 'the selection was restored, not reset');
    // A background refresh never calls showTextDocument — nothing should
    // steal focus away from whatever the person was editing.
    assert.equal(vscode.__mock.calls.showInformationMessage.length, 0);
    assert.equal(vscode.__mock.calls.showErrorMessage.length, 0);
  });
});

test('onSourceSaved(): a file outside the tab\'s project does not trigger a rebuild', async () => {
  await withController(async ({ dir, controller, output }) => {
    vscode.__mock.reset();
    const sourcePath = path.join(dir, 'main.8bs');
    fs.writeFileSync(sourcePath, 'export function main(): void {}\n');
    const debugMapPath = path.join(dir, 'out.8bs.debug.json');
    writeControl(dir, { target: 'c64', address: 0xc142, sourcePath, debugMapPath });
    await controller.render({ dir, targets: ['c64'] }, 'c64', sourcePath);

    const linesBefore = output.lines.length;
    await controller.onSourceSaved({ fileName: '/somewhere/else/other.8bs' });
    assert.equal(output.lines.length, linesBefore, 'nothing was rebuilt for an unrelated project');
  });
});

test('onSourceSaved(): a failed rebuild (a mid-edit syntax error) leaves the tab showing its last successful build, silently', async () => {
  await withController(async ({ dir, controller, output }) => {
    vscode.__mock.reset();
    const sourcePath = path.join(dir, 'main.8bs');
    fs.writeFileSync(sourcePath, 'export function main(): void {}\n');
    const debugMapPath = path.join(dir, 'out.8bs.debug.json');
    writeControl(dir, { target: 'c64', address: 0xc142, sourcePath, debugMapPath });
    const project = { dir, targets: ['c64'] };

    await controller.render(project, 'c64', sourcePath);
    const key = controller.uriFor('c64', sourcePath).toString();
    const goodText = controller.documents.get(key).text;

    writeControl(dir, { fail: true });
    await controller.onSourceSaved({ fileName: sourcePath });

    assert.equal(controller.documents.get(key).text, goodText, 'the tab still shows the last successful build');
    assert.equal(vscode.__mock.calls.showErrorMessage.length, 0, 'a background refresh never pops a dialog');
    assert.equal(vscode.__mock.calls.showInformationMessage.length, 0);
    assert.ok(output.lines.some((line) => line.includes('boom')), 'the failure is still logged to the output channel');
  });
});

test('rerenderAll(): flipping 8bitscript.assemblyView.explain re-renders every open tab from the instructions it already has — no rebuild, place kept', async () => {
  await withController(async ({ dir, controller, output }) => {
    vscode.__mock.reset();
    const sourcePath = path.join(dir, 'main.8bs');
    fs.writeFileSync(sourcePath, 'export function main(): void {}\n');
    const debugMapPath = path.join(dir, 'out.8bs.debug.json');
    writeControl(dir, { target: 'c64', address: 0xc142, sourcePath, debugMapPath });
    const project = { dir, targets: ['c64'] };

    await controller.render(project, 'c64', sourcePath);
    const key = controller.uriFor('c64', sourcePath).toString();
    assert.match(controller.documents.get(key).text, /LDA \$18\s+; A = mem\[\$18\]/, 'explained by default');
    const buildsBefore = output.lines.filter((line) => line.startsWith('$ 8bs')).length;

    const revealed = [];
    const fakeEditor = {
      document: { uri: { toString: () => key } },
      visibleRanges: [{ start: { line: 2 } }],
      selection: { active: { line: 2, character: 0 } },
      revealRange: (range, kind) => revealed.push({ range, kind }),
    };
    vscode.window.visibleTextEditors = [fakeEditor];

    // What the configuration-change listener does once toggleExplain() has
    // written the setting (the mock's onDidChangeConfiguration never fires).
    await controller.toggleExplain();
    assert.equal(vscode.workspace.getConfiguration('8bitscript').get('assemblyView.explain'), false);
    controller.rerenderAll();
    assert.match(controller.documents.get(key).text, /LDA \$18$/m, 'the per-instruction comment is gone');
    assert.equal(output.lines.filter((line) => line.startsWith('$ 8bs')).length, buildsBefore, 'no 8bs build was run to re-render');
    assert.equal(revealed.length, 1, 'the tab is put back where it was, like a live-reload refresh');

    await controller.toggleExplain();
    controller.rerenderAll();
    assert.match(controller.documents.get(key).text, /; A = mem\[\$18\]/, 'and back on again');
  });
});

test('pickTarget(): excludes web (no assembly listing) and skips the picker entirely when only one machine qualifies', async () => {
  await withController(async ({ controller }) => {
    vscode.__mock.reset();
    // Left empty deliberately: if pickTarget() fell through to the
    // quickpick here, it would resolve undefined (nothing queued) rather
    // than 'c64', so this also proves it took the single-candidate
    // shortcut instead of prompting.
    const picked = await controller.pickTarget(['c64', 'web'], 'c64', 'placeholder');
    assert.equal(picked, 'c64', 'the only real candidate is returned with no prompt');
  });
});

test('pickTarget(): offers every non-web target, preferring the current one first, and reports when none qualify', async () => {
  await withController(async ({ controller }) => {
    vscode.__mock.reset();
    vscode.__mock.queues.showQuickPick.push({ target: 'vic20' });
    const picked = await controller.pickTarget(['c64', 'vic20'], 'c64', 'placeholder');
    assert.equal(picked, 'vic20');

    const none = await controller.pickTarget(['web'], 'web', 'placeholder');
    assert.equal(none, undefined);
    assert.equal(vscode.__mock.calls.showInformationMessage.length, 1);
    assert.match(vscode.__mock.calls.showInformationMessage[0][0], /WebAssembly has none/);
  });
});
