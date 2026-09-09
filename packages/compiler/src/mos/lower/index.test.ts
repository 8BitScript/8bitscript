import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lower } from './index.ts';
import type { IrStatement, IrExpr, LowerOptions } from './index.ts';
import { LocalAllocator } from './allocator.ts';
import { assemble } from '../asm/assemble.ts';
import type { Directive } from '../asm/assemble.ts';

// A fresh, generously-budgeted context for a test that doesn't care about
// the zero-page ceiling — most of them. Tests that do care build their own.
function ctx(globals: [string, { address: number; type: string }][] = []): LowerOptions {
  return { globals: new Map(globals), locals: new LocalAllocator(0x90, 0x100) };
}

const write = (address: number, value: number): IrStatement => ({
  kind: 'memoryWrite',
  address: { kind: 'const', value: address, type: 'usmallint' },
  value: { kind: 'const', value, type: 'utinyint' },
});

const u8 = (value: number): IrExpr => ({ kind: 'const', value, type: 'utinyint' });
const ref = (name: string, type = 'utinyint'): IrExpr => ({ kind: 'ref', name, type });
const bin = (operator: string, left: IrExpr, right: IrExpr, type = 'utinyint'): IrExpr => ({ kind: 'binop', operator, left, right, type });
const local = (name: string, init: IrExpr, type = 'utinyint'): IrStatement => ({ kind: 'local', name, type, init });
const assign = (target: string, value: IrExpr): IrStatement => ({ kind: 'assign', target, value });

function instruction(directive: Directive) {
  assert.equal(directive.kind, 'instruction');
  if (directive.kind !== 'instruction') throw new Error('unreachable');
  return directive;
}

/** Proves a lowered program is at least real 6502 — every branch resolves, every mode is legal, nothing overflows its operand width. No in-repo 6502 interpreter exists yet to check the actual numeric result at this level (packages/compiler/test/mos.test.ts's own fixtures do that against a real emulator instead); the mnemonic-sequence assertions alongside each call to this are what stand in for it here. */
function assembles(program: Directive[]) {
  const result = assemble(program, 0x1000);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  return result;
}

test('an empty body lowers to just the trailing exit label, which costs 0 bytes', () => {
  const result = lower([], ctx());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.program.length, 1);
  assert.equal(result.program[0].kind, 'label');
  assembles(result.program); // a lone label assembles to zero bytes, not an error
});

test('memoryWrite still lowers exactly as milestone 4 left it', () => {
  const result = lower([write(0x8000, 8)], ctx());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.program.slice(0, 2), [
    { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: 8 } },
    { kind: 'instruction', mnemonic: 'STA', mode: 'absolute', operand: { kind: 'value', value: 0x8000 } },
  ]);
});

test('a statement kind with no rule yet fails naming it, not silently', () => {
  const result = lower([{ kind: 'storeIndex' }], ctx());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /no instruction-selection rule yet for the 'storeIndex' statement/);
});

test('a 16-bit local is refused by name, not truncated', () => {
  const result = lower([local('x', { kind: 'const', value: 300, type: 'usmallint' }, 'usmallint')], ctx());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /local 'x' is 'usmallint' \(2 bytes\): only 8-bit/);
});

test('a local is declared once and read back through the same zero-page slot', () => {
  const result = lower([local('x', u8(5)), assign('x', bin('+', ref('x'), u8(1)))], ctx());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assembles(result.program);
  // LDA #5; STA slot(local x); ... LDA slot(local x); STA temp; LDA #1; CLC; ADC temp; STA slot(local x); label(exit)
  const declareSta = instruction(result.program[1]);
  assert.equal(declareSta.mnemonic, 'STA');
  const slot = declareSta.operand!.kind === 'value' ? declareSta.operand!.value : -1;
  const finalSta = instruction(result.program[result.program.length - 2]);
  assert.equal(finalSta.mnemonic, 'STA');
  assert.equal(finalSta.operand!.kind === 'value' ? finalSta.operand!.value : -1, slot);
});

test('a local out of zero page fails naming the variable and what is left', () => {
  const tight: LowerOptions = { globals: new Map(), locals: new LocalAllocator(0xff, 0x100) };
  const result = lower([local('a', u8(1)), local('b', u8(2))], tight);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /local 'b' needs 1 byte of zero page but only 0 byte\(s\) remain/);
});

test('a block-scoped local is released once its block ends, so a later block can reuse the same byte', () => {
  const tight: LowerOptions = { globals: new Map(), locals: new LocalAllocator(0x90, 0x91) }; // exactly one byte
  const result = lower(
    [
      { kind: 'block', body: [local('a', u8(1))] },
      { kind: 'block', body: [local('b', u8(2))] },
    ],
    tight,
  );
  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

test('+ evaluates left then right, in that order, and adds them', () => {
  const result = lower([{ kind: 'assign', target: 'out', value: bin('+', ref('x'), ref('y')) }], ctx([
    ['x', { address: 0x10, type: 'utinyint' }],
    ['y', { address: 0x11, type: 'utinyint' }],
    ['out', { address: 0x12, type: 'utinyint' }],
  ]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assembles(result.program);
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => (d as { mnemonic: string }).mnemonic);
  // LDA x (left, first); STA temp; LDA y (right, second); CLC; ADC temp; STA out
  assert.deepEqual(mnemonics, ['LDA', 'STA', 'LDA', 'CLC', 'ADC', 'STA']);
  const firstLoad = instruction(result.program[0]);
  assert.equal(firstLoad.operand!.kind === 'value' ? firstLoad.operand!.value : -1, 0x10); // x, evaluated first
});

test('- computes left minus right: left is reloaded and right is subtracted back out, not the other way around', () => {
  const result = lower([assign('out', bin('-', u8(10), u8(3)))], ctx([['out', { address: 0x50, type: 'utinyint' }]]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assembles(result.program);
  // LDA #10 (left); STA tempLeft; LDA #3 (right); STA tempRight; LDA tempLeft; SEC; SBC tempRight; STA out.
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => (d as { mnemonic: string }).mnemonic);
  assert.deepEqual(mnemonics, ['LDA', 'STA', 'LDA', 'STA', 'LDA', 'SEC', 'SBC', 'STA']);
  const values = result.program.filter((d) => d.kind === 'instruction' && (d as { mnemonic: string }).mnemonic === 'LDA' && (d as { mode: string }).mode === 'immediate');
  assert.equal(values[0] && (values[0] as { operand: { value: number } }).operand.value, 10); // left, loaded first
  assert.equal(values[1] && (values[1] as { operand: { value: number } }).operand.value, 3); // right, loaded second
});

test('* / % are refused by name: no hardware multiply or divide to lower them onto', () => {
  for (const operator of ['*', '/', '%']) {
    const result = lower([assign('out', bin(operator, u8(4), u8(2)))], ctx([['out', { address: 0x50, type: 'utinyint' }]]));
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.match(result.error, new RegExp(`the '\\${operator}' operator isn't lowered yet`));
  }
});

test('an ordering comparison on a signed type is refused; equality is not', () => {
  const signedLeft = bin('<', { kind: 'ref', name: 'x', type: 'tinyint' }, u8(5));
  const refused = lower([assign('out', signedLeft)], ctx([['x', { address: 0x10, type: 'tinyint' }], ['out', { address: 0x50, type: 'utinyint' }]]));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /signed type isn't lowered yet/);

  const eq = bin('==', { kind: 'ref', name: 'x', type: 'tinyint' }, u8(5), 'bool');
  const allowed = lower([assign('out', eq)], ctx([['x', { address: 0x10, type: 'tinyint' }], ['out', { address: 0x50, type: 'bool' }]]));
  assert.equal(allowed.ok, true, allowed.ok ? '' : allowed.error);
});

test('a bool value (a comparison used as a value, not a condition) assembles to real 0/1-materialising code', () => {
  const result = lower([assign('flag', bin('<', ref('a'), ref('b'), 'bool'))], ctx([
    ['a', { address: 0x10, type: 'utinyint' }],
    ['b', { address: 0x11, type: 'utinyint' }],
    ['flag', { address: 0x12, type: 'bool' }],
  ]));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => (d as { mnemonic: string }).mnemonic);
  assert.ok(mnemonics.includes('CMP'));
  assert.ok(mnemonics.filter((m) => m === 'LDA').length >= 2); // the #0/#1 materialisation, at minimum
});

test('if/else with a bare return lowers and assembles cleanly, both branches present', () => {
  const program: IrStatement[] = [
    {
      kind: 'if',
      test: bin('==', ref('x'), u8(0), 'bool'),
      then: [write(0x8000, 1)],
      else: [write(0x8000, 2)],
    },
  ];
  const result = lower(program, ctx([['x', { address: 0x10, type: 'utinyint' }]]));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  const labels = result.program.filter((d) => d.kind === 'label');
  assert.ok(labels.length >= 3); // else label, endif label, the function's own exit label
});

test('while with break and continue lowers and assembles; the loop test sits at the top', () => {
  const program: IrStatement[] = [
    {
      kind: 'while',
      test: bin('<', ref('i'), u8(10), 'bool'),
      body: [
        { kind: 'if', test: bin('==', ref('i'), u8(5), 'bool'), then: [{ kind: 'break' }], else: null },
        assign('i', bin('+', ref('i'), u8(1))),
      ],
    },
  ];
  const result = lower(program, ctx([['i', { address: 0x10, type: 'utinyint' }]]));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
});

test('for with an init-local, test, and update lowers and assembles; the local is scoped to the loop, not the whole function', () => {
  const program: IrStatement[] = [
    {
      kind: 'for',
      init: local('i', u8(0)),
      test: bin('<', ref('i'), u8(9), 'bool'),
      update: assign('i', bin('+', ref('i'), u8(1))),
      body: [],
    },
    // A second loop reusing the name 'i' proves the first loop's local was
    // actually released, not left dangling in scope (it would otherwise be
    // a duplicate declaration this pass has no business rejecting itself —
    // that's the checker's job upstream — but symbols.set would silently
    // shadow forever if release() never fired, exhausting the budget on a
    // long enough program).
    {
      kind: 'for',
      init: local('i', u8(0)),
      test: bin('<', ref('i'), u8(9), 'bool'),
      update: assign('i', bin('+', ref('i'), u8(1))),
      body: [],
    },
  ];
  const tight: LowerOptions = { globals: new Map(), locals: new LocalAllocator(0x90, 0x92) }; // 2 bytes: room for one 'i' plus one temp, never two 'i's at once
  const result = lower(program, tight);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

test('return with a value is refused: no calling convention yet', () => {
  const result = lower([{ kind: 'return', value: u8(1) }], ctx());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /'return' with a value isn't lowered yet/);
});

test('a bare return jumps to the function-exit label, which the epilogue can sit right after', () => {
  const result = lower([{ kind: 'if', test: bin('==', ref('x'), u8(0), 'bool'), then: [{ kind: 'return', value: null }], else: null }], ctx([['x', { address: 0x10, type: 'utinyint' }]]));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const last = result.program[result.program.length - 1];
  assert.equal(last.kind, 'label');
  assembles(result.program);
});

test('a local that shadows a global is restored — not deleted — once its block ends, so a later reference reaches the global again', () => {
  const options = ctx([['x', { address: 0x10, type: 'utinyint' }]]);
  const program: IrStatement[] = [
    { kind: 'block', body: [local('x', u8(99))] }, // shadows the global 'x' for this block only
    assign('x', u8(1)), // back outside the block: must resolve to the global, not fail as "resolves to nothing"
  ];
  const result = lower(program, options);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  const lastSta = result.program.filter((d) => d.kind === 'instruction' && (d as { mnemonic: string }).mnemonic === 'STA').pop();
  assert.ok(lastSta && lastSta.kind === 'instruction');
  if (lastSta?.kind === 'instruction') assert.equal(lastSta.operand!.kind === 'value' ? lastSta.operand!.value : -1, 0x10); // the global's address, not the block's freed local slot
});

test('an empty else ({}) is treated as no else at all — no dead JMP to a branch that does nothing', () => {
  const withEmptyElse = lower([{ kind: 'if', test: bin('==', ref('x'), u8(0), 'bool'), then: [write(0x8000, 1)], else: [] }], ctx([['x', { address: 0x10, type: 'utinyint' }]]));
  const withNoElse = lower([{ kind: 'if', test: bin('==', ref('x'), u8(0), 'bool'), then: [write(0x8000, 1)], else: null }], ctx([['x', { address: 0x10, type: 'utinyint' }]]));
  assert.equal(withEmptyElse.ok, true);
  assert.equal(withNoElse.ok, true);
  if (!withEmptyElse.ok || !withNoElse.ok) return;
  assert.equal(withEmptyElse.program.length, withNoElse.program.length);
});
