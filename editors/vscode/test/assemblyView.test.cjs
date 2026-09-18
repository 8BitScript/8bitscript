// renderView()/samePath() — the pure half of "8BitScript: View Generated
// Assembly" (assemblyView.cjs): turning a slice of a real
// .8bs.debug.json into the virtual document's text and its line -> source
// map, and matching a debug map's `source.file` against an open editor's
// path. The vscode-calling half (running `8bs build --debug`, opening the
// document, the selection listener) is exercised indirectly by
// runner.test.cjs's own registerRunner() cases, which construct an
// AssemblyViewController for real against the shared vscode mock.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

installVscodeMock();
const { renderView, samePath, isWithinProject, instructionsNearCursor } = require('../src/assemblyView.cjs');

test('samePath: the same absolute path always matches, regardless of case/slash differences', () => {
  assert.equal(samePath('/a/b/game.8bs', '/a/b/game.8bs'), true);
  assert.equal(samePath('/a/b/GAME.8BS', '/a/b/game.8bs'), true);
  assert.equal(samePath('/a/b/game.8bs', '/a/c/other.8bs'), false);
});

test('renderView: groups consecutive instructions by function/origin, marks the highlighted ones, and builds a parallel line -> source map', () => {
  const instructions = [
    {
      address: 0xc142, bytes: [0xa5, 0x18], assembly: 'LDA $18', function: 'updateScore', origin: null,
      source: { file: '/game.8bs', start: 10, length: 5, line: 4, column: 1 },
    },
    {
      address: 0xc144, bytes: [0x69, 0x01], assembly: 'ADC #$01', function: 'updateScore', origin: null,
      source: { file: '/game.8bs', start: 10, length: 5, line: 4, column: 1 },
    },
    {
      address: 0xc146, bytes: [0x85, 0x18], assembly: 'STA $18', function: 'updateScore', origin: null,
      source: { file: '/game.8bs', start: 10, length: 5, line: 4, column: 1 },
    },
    {
      address: 0xc148, bytes: [0x60], assembly: 'RTS', function: 'main', origin: 'updateScore',
      source: { file: '/game.8bs', start: 30, length: 3, line: 7, column: 1 }, generated: { reason: 'branch-relaxation' },
    },
  ];
  const highlight = new Set([instructions[0], instructions[1], instructions[2]]);
  const { text, lineSources } = renderView('/game.8bs', instructions, highlight);

  assert.match(text, /function: updateScore\n/);
  assert.ok(text.includes('A5 18') && text.includes('LDA $18'));
  assert.match(text, /^> \$C142/m, 'a highlighted instruction is marked with >');
  assert.match(text, /^ {2}\$C148/m, 'a non-highlighted instruction is not marked');
  assert.match(text, /function: main \(inlined from updateScore\)/);
  assert.ok(text.includes('RTS') && text.includes('; branch-relaxation'));

  const lines = text.split('\n');
  const ldaLine = lines.findIndex((l) => l.includes('LDA $18'));
  assert.deepEqual(lineSources[ldaLine], instructions[0].source);
  const rtsLine = lines.findIndex((l) => l.includes('RTS'));
  assert.deepEqual(lineSources[rtsLine], instructions[3].source);
  // A header/blank line carries no source of its own — clicking it should
  // do nothing rather than navigate somewhere wrong.
  const headerLine = lines.findIndex((l) => l.startsWith('; function: main'));
  assert.equal(lineSources[headerLine], null);
});

test('renderView: an instruction with no function/source (compiler structure) gets its own labeled section', () => {
  const instructions = [
    { address: 0x1000, bytes: [0xa9, 0x00], assembly: 'LDA #$00', function: null, origin: null, source: null },
  ];
  const { text } = renderView('/game.8bs', instructions, new Set());
  assert.match(text, /compiler-generated — no direct source/);
});

// ---- isWithinProject: does a saved file belong to a project whose open ----
// assembly tabs should be refreshed (onSourceSaved's own filter).

test('isWithinProject: a file under the project directory, or the project directory itself, matches', () => {
  assert.equal(isWithinProject('/repo/game/src/main.8bs', '/repo/game'), true);
  assert.equal(isWithinProject('/repo/game', '/repo/game'), true);
  assert.equal(isWithinProject('/repo/other/src/main.8bs', '/repo/game'), false);
  // A sibling directory that merely shares a prefix is not "within" it.
  assert.equal(isWithinProject('/repo/game2/src/main.8bs', '/repo/game'), false);
});

// ---- instructionsNearCursor: the reader's starting point, never a filter ----

test('instructionsNearCursor: an offset inside an instruction\'s own span matches it exactly', () => {
  const instructions = [
    { source: { start: 10, length: 5 } },
    { source: { start: 20, length: 5 } },
  ];
  const found = instructionsNearCursor(instructions, 12);
  assert.deepEqual([...found], [instructions[0]]);
});

test('instructionsNearCursor: an offset between statements falls back to the nearest one at or before it', () => {
  const instructions = [
    { source: { start: 10, length: 5 } },
    { source: { start: 30, length: 3 } },
  ];
  // 25 lands after the first statement's span and before the second's.
  const found = instructionsNearCursor(instructions, 25);
  assert.deepEqual([...found], [instructions[0]]);
});

test('instructionsNearCursor: an offset before every statement matches nothing', () => {
  const instructions = [{ source: { start: 10, length: 5 } }];
  assert.equal(instructionsNearCursor(instructions, 0).size, 0);
});
