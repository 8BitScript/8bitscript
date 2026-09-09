import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lower } from './index.ts';
import type { IrStatement, IrExpr, LowerOptions, FunctionSite } from './index.ts';
import { LocalAllocator } from './allocator.ts';
import { assemble } from '../asm/assemble.ts';
import type { Directive } from '../asm/assemble.ts';

// A fresh, generously-budgeted context for a test that doesn't care about
// the zero-page ceiling — most of them. Tests that do care build their own.
// No parameters and no other functions unless a test says otherwise — most
// of these predate milestone 7 and were never about calls.
function ctx(globals: [string, { address: number; type: string }][] = [], functions: [string, FunctionSite][] = []): LowerOptions {
  return { globals: new Map(globals), locals: new LocalAllocator(0x90, 0x100), params: [], functions: new Map(functions) };
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

// A plain `{ kind: 'if', ..., then, ... }` literal trips SonarCloud's
// thenable-safety rule (S7739, "do not add `then` to an object") —
// `then` here is the IR's real field name for the taken branch
// (ir/index.mjs), always an array of statements, never a callable, so it
// can never behave like a thenable. Centralised once so the one
// necessary suppression lives in one place instead of at every call site.
function ifNode(test: IrExpr, then: IrStatement[], elseBranch: IrStatement[] | null = null): IrStatement {
  return { kind: 'if', test, then, else: elseBranch }; // NOSONAR: typescript:S7739 — 'then' is the IR's real field name, never a Promise
}

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
  const tight: LowerOptions = { globals: new Map(), locals: new LocalAllocator(0xff, 0x100), params: [], functions: new Map() };
  const result = lower([local('a', u8(1)), local('b', u8(2))], tight);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /local 'b' needs 1 byte of zero page but only 0 byte\(s\) remain/);
});

test('a block-scoped local is released once its block ends, so a later block can reuse the same byte', () => {
  const tight: LowerOptions = { globals: new Map(), locals: new LocalAllocator(0x90, 0x91), params: [], functions: new Map() }; // exactly one byte
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
    ifNode(bin('==', ref('x'), u8(0), 'bool'), [write(0x8000, 1)], [write(0x8000, 2)]),
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
        ifNode(bin('==', ref('i'), u8(5), 'bool'), [{ kind: 'break' }]),
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
  const tight: LowerOptions = { globals: new Map(), locals: new LocalAllocator(0x90, 0x92), params: [], functions: new Map() }; // 2 bytes: room for one 'i' plus one temp, never two 'i's at once
  const result = lower(program, tight);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

test('return with a value evaluates it into A, then jumps to the exit label — milestone 7', () => {
  const result = lower([{ kind: 'return', value: u8(42) }], ctx());
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assert.deepEqual(result.program[0], { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: 42 } });
  assert.equal(instruction(result.program[1]).mnemonic, 'JMP');
  assembles(result.program);
});

test('return with a 16-bit value is refused by name — 16-bit lands at milestone 8', () => {
  const result = lower([{ kind: 'return', value: { kind: 'const', value: 300, type: 'usmallint' } }], ctx());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /is 'usmallint' \(2 bytes\): only 8-bit/);
});

test('a bare return jumps to the function-exit label, which the epilogue can sit right after', () => {
  const result = lower([ifNode(bin('==', ref('x'), u8(0), 'bool'), [{ kind: 'return', value: null }])], ctx([['x', { address: 0x10, type: 'utinyint' }]]));
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
  const withEmptyElse = lower([ifNode(bin('==', ref('x'), u8(0), 'bool'), [write(0x8000, 1)], [])], ctx([['x', { address: 0x10, type: 'utinyint' }]]));
  const withNoElse = lower([ifNode(bin('==', ref('x'), u8(0), 'bool'), [write(0x8000, 1)])], ctx([['x', { address: 0x10, type: 'utinyint' }]]));
  assert.equal(withEmptyElse.ok, true);
  assert.equal(withNoElse.ok, true);
  if (!withEmptyElse.ok || !withNoElse.ok) return;
  assert.equal(withEmptyElse.program.length, withNoElse.program.length);
});

const mnemonicsOf = (program: Directive[]) =>
  program.filter((d) => d.kind === 'instruction').map((d) => (d as { mnemonic: string }).mnemonic);

const bool = (operator: string, left: IrExpr, right: IrExpr): IrExpr => bin(operator, left, right, 'bool');
const not = (argument: IrExpr): IrExpr => ({ kind: 'unop', operator: '!', argument, type: 'bool' });
const unary = (operator: string, argument: IrExpr, type = 'utinyint'): IrExpr => ({ kind: 'unop', operator, argument, type });

test('&& and || as values materialise to 0/1; as if-tests they short-circuit without that materialisation', () => {
  const env = ctx([
    ['a', { address: 0x10, type: 'utinyint' }],
    ['b', { address: 0x11, type: 'utinyint' }],
    ['flag', { address: 0x12, type: 'bool' }],
  ]);
  const asValue = lower([assign('flag', bool('&&', ref('a'), ref('b')))], env);
  assert.equal(asValue.ok, true, asValue.ok ? '' : asValue.error);
  if (!asValue.ok) return;
  assembles(asValue.program);
  assert.ok(mnemonicsOf(asValue.program).includes('LDA'));
  assert.ok(mnemonicsOf(asValue.program).includes('JMP')); // the 0/1 materialisation

  const orValue = lower([assign('flag', bool('||', ref('a'), ref('b')))], env);
  assert.equal(orValue.ok, true, orValue.ok ? '' : orValue.error);
  if (!orValue.ok) return;
  assembles(orValue.program);

  const andIf = lower([ifNode(bool('&&', ref('a'), ref('b')), [write(0x8000, 1)])], env);
  assert.equal(andIf.ok, true, andIf.ok ? '' : andIf.error);
  if (!andIf.ok) return;
  assembles(andIf.program);
  assert.ok(!mnemonicsOf(andIf.program).includes('JMP') || mnemonicsOf(andIf.program).filter((m) => m === 'LDA').length < mnemonicsOf(asValue.program).filter((m) => m === 'LDA').length);

  const orIf = lower([ifNode(bool('||', ref('a'), ref('b')), [write(0x8000, 1)], [write(0x8000, 2)])], env);
  assert.equal(orIf.ok, true, orIf.ok ? '' : orIf.error);
  if (!orIf.ok) return;
  assembles(orIf.program);
});

test('unary !, ~, -, and + each lower; an unknown unary operator is refused by name', () => {
  const env = ctx([
    ['x', { address: 0x10, type: 'utinyint' }],
    ['flag', { address: 0x12, type: 'bool' }],
    ['out', { address: 0x13, type: 'utinyint' }],
  ]);
  const bang = lower([assign('flag', not(ref('x')))], env);
  assert.equal(bang.ok, true, bang.ok ? '' : bang.error);
  if (!bang.ok) return;
  assembles(bang.program);

  const ifNot = lower([ifNode(not(ref('x')), [write(0x8000, 1)])], env);
  assert.equal(ifNot.ok, true, ifNot.ok ? '' : ifNot.error);
  if (!ifNot.ok) return;
  assembles(ifNot.program);

  const bitNot = lower([assign('out', unary('~', ref('x')))], env);
  assert.equal(bitNot.ok, true, bitNot.ok ? '' : bitNot.error);
  if (!bitNot.ok) return;
  assembles(bitNot.program);
  assert.ok(mnemonicsOf(bitNot.program).includes('EOR'));

  const neg = lower([assign('out', unary('-', ref('x')))], env);
  assert.equal(neg.ok, true, neg.ok ? '' : neg.error);
  if (!neg.ok) return;
  assembles(neg.program);
  assert.deepEqual(mnemonicsOf(neg.program).filter((m) => m === 'EOR' || m === 'ADC' || m === 'CLC'), ['EOR', 'CLC', 'ADC']);

  const plus = lower([assign('out', unary('+', ref('x')))], env);
  assert.equal(plus.ok, true, plus.ok ? '' : plus.error);
  if (!plus.ok) return;
  assembles(plus.program);
  // Unary plus is the identity: load x, store out, no EOR/ADC.
  assert.ok(!mnemonicsOf(plus.program).includes('EOR'));

  const unknown = lower([assign('out', unary('@', ref('x')))], env);
  assert.equal(unknown.ok, false);
  if (unknown.ok) return;
  assert.match(unknown.error, /unary '@' operator/);
});

test('>, <=, >=, and != as if-tests assemble; a bool local used as a condition is tested as zero/nonzero', () => {
  const env = ctx([
    ['a', { address: 0x10, type: 'utinyint' }],
    ['b', { address: 0x11, type: 'utinyint' }],
    ['flag', { address: 0x12, type: 'bool' }],
  ]);
  for (const operator of ['>', '<=', '>=', '!=']) {
    const result = lower([ifNode(bool(operator, ref('a'), ref('b')), [write(0x8000, 1)])], env);
    assert.equal(result.ok, true, result.ok ? '' : `${operator}: ${result.error}`);
    if (result.ok) assembles(result.program);
  }
  const onFlag = lower([ifNode(ref('flag', 'bool'), [write(0x8000, 1)])], env);
  assert.equal(onFlag.ok, true, onFlag.ok ? '' : onFlag.error);
  if (!onFlag.ok) return;
  assembles(onFlag.program);
  assert.ok(mnemonicsOf(onFlag.program).includes('BNE') || mnemonicsOf(onFlag.program).includes('BEQ'));
});

test('continue jumps to the loop\'s continue label — the top of a while, the update of a for', () => {
  const env = ctx([['i', { address: 0x10, type: 'utinyint' }]]);
  const whileCont = lower([
    {
      kind: 'while',
      test: bool('<', ref('i'), u8(10)),
      body: [
        ifNode(bool('==', ref('i'), u8(5)), [{ kind: 'continue' }]),
        assign('i', bin('+', ref('i'), u8(1))),
      ],
    },
  ], env);
  assert.equal(whileCont.ok, true, whileCont.ok ? '' : whileCont.error);
  if (!whileCont.ok) return;
  assembles(whileCont.program);
  assert.ok(mnemonicsOf(whileCont.program).includes('JMP'));

  const forCont = lower([
    {
      kind: 'for',
      init: local('j', u8(0)),
      test: bool('<', ref('j'), u8(9)),
      update: assign('j', bin('+', ref('j'), u8(1))),
      body: [{ kind: 'continue' }],
    },
  ], env);
  assert.equal(forCont.ok, true, forCont.ok ? '' : forCont.error);
  if (!forCont.ok) return;
  assembles(forCont.program);
});

test('a for with no init, test, or update is an infinite loop; break is how it ends', () => {
  const result = lower([{ kind: 'for', init: null, test: null, update: null, body: [{ kind: 'break' }] }], ctx());
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  assert.ok(mnemonicsOf(result.program).includes('JMP'));
});

test('break and continue outside any loop fail as a checker bug, not a missing rule', () => {
  const brk = lower([{ kind: 'break' }], ctx());
  assert.equal(brk.ok, false);
  if (!brk.ok) assert.match(brk.error, /break outside any loop/);
  const cont = lower([{ kind: 'continue' }], ctx());
  assert.equal(cont.ok, false);
  if (!cont.ok) assert.match(cont.error, /continue outside any loop/);
});

test('a bitwise or shift operator is refused by name the same way * / % are', () => {
  const result = lower([assign('out', bin('<<', u8(1), u8(1)))], ctx([['out', { address: 0x50, type: 'utinyint' }]]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /the '<<' operator/);
});

test('an expression kind with no rule yet fails naming it, not silently', () => {
  const result = lower([assign('out', { kind: 'index', type: 'utinyint' })], ctx([['out', { address: 0x50, type: 'utinyint' }]]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /no instruction-selection rule yet for the 'index' expression/);
});

// ---- milestone 7: calling convention -------------------------------------
//
// callSite() itself, in isolation — mos.test.ts's own new suite covers the
// real thing end to end (two call sites sharing one body, argument order,
// a function calling a function, all through build() against a real
// FunctionSite map assigned by mos/index.ts's own two passes). What these
// prove is narrower and cheaper: given a FunctionSite, a call stores each
// argument into the right address, in order, and emits JSR to the right
// label — as a value, and as a statement.

// A dedicated return type, not IrExpr: IrExpr's own `value?: number` (for
// `const`) is incompatible with IrStatement's `value?: IrExpr | null` (for
// `memoryWrite`), so a helper typed as either can't be used in the other's
// array position (`lower(body: IrStatement[], ...)` vs. an expression
// argument) — the same reason callSite() itself takes a narrow structural
// type rather than IrExpr. A call node needs neither field.
const call = (name: string, args: IrExpr[], type: string | null = 'utinyint') => ({ kind: 'call' as const, name, args, type });
const site = (label: string, paramAddresses: number[], returnType = 'utinyint'): FunctionSite => ({ label, paramAddresses, returnType });

test('a call used as a value stores each argument into the callee\'s own address, in order, then JSRs — the result is left in A like any other value', () => {
  const result = lower(
    [assign('out', call('place', [u8(1), u8(2)]))],
    ctx([['out', { address: 0x60, type: 'utinyint' }]], [['place', site('__8bs_fn_place', [0x50, 0x51])]]),
  );
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  // Not run through assembles(): the callee's own label ('__8bs_fn_place')
  // is never defined in this isolated snippet — mos.test.ts's build()-level
  // tests exercise the real, linkable, two-function program instead.
  // LDA #1; STA $50; LDA #2; STA $51; JSR place; STA $60 (assign); label(exit)
  assert.deepEqual(result.program.slice(0, 5).map((d) => instruction(d).mnemonic), ['LDA', 'STA', 'LDA', 'STA', 'JSR']);
  const firstStore = instruction(result.program[1]);
  assert.equal(firstStore.mode, 'zeropage');
  assert.equal(firstStore.operand!.kind === 'value' ? firstStore.operand!.value : -1, 0x50);
  const secondStore = instruction(result.program[3]);
  assert.equal(secondStore.operand!.kind === 'value' ? secondStore.operand!.value : -1, 0x51);
  const jsr = instruction(result.program[4]);
  assert.equal(jsr.mode, 'absolute');
  assert.equal(jsr.operand!.kind === 'label' ? jsr.operand!.name : '', '__8bs_fn_place');
});

test('a call used as a bare statement is not gated on its return type being 8-bit — a void call is a perfectly good statement', () => {
  const result = lower([call('prepare', [], 'void')], ctx([], [['prepare', site('__8bs_fn_prepare', [], 'void')]]));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assert.equal(instruction(result.program[0]).mnemonic, 'JSR');
});

test('a call to a name with no FunctionSite fails naming it — a linker bug, not a missing lowering rule', () => {
  const result = lower([call('ghost', [])], ctx());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /call to 'ghost' resolves to nothing this backend knows about/);
});

test('an argument-count mismatch against the FunctionSite fails naming both counts, defensively — completeCall should already have matched these', () => {
  const result = lower([call('place', [u8(1)])], ctx([], [['place', site('__8bs_fn_place', [0x50, 0x51])]]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /1 argument\(s\) but the function has 2 parameter\(s\)/);
});

test('memoryWrite of a computed address is refused; a missing value is refused; a zeropage address uses STA zeropage', () => {
  const computed = lower([{
    kind: 'memoryWrite',
    address: { kind: 'ref', name: 'p', type: 'usmallint' },
    value: u8(1),
  }], ctx([['p', { address: 0x10, type: 'usmallint' }]]));
  assert.equal(computed.ok, false);
  if (!computed.ok) assert.match(computed.error, /address must be a literal/);

  const missing = lower([{ kind: 'memoryWrite', address: { kind: 'const', value: 0x8000, type: 'usmallint' }, value: null }], ctx());
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /no value to write/);

  const zp = lower([write(0x80, 7)], ctx());
  assert.equal(zp.ok, true, zp.ok ? '' : zp.error);
  if (!zp.ok) return;
  assembles(zp.program);
  const sta = zp.program.find((d) => d.kind === 'instruction' && (d as { mnemonic: string }).mnemonic === 'STA');
  assert.ok(sta && sta.kind === 'instruction');
  if (sta?.kind === 'instruction') assert.equal(sta.mode, 'zeropage');
});

test('a 16-bit assignment is refused, not truncated to a byte', () => {
  const result = lower([assign('wide', u8(1))], ctx([['wide', { address: 0x10, type: 'usmallint' }]]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /assignment to 'wide' is 'usmallint'/);
});

test('a local with no type is refused rather than assumed 8-bit', () => {
  const result = lower([{ kind: 'local', name: 'x', init: u8(1) }], ctx());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /no type on this IR node/);
});

test('a lowering bug that is not a LowerError or a zp-budget error still throws', () => {
  assert.throws(
    () => lower([{ kind: 'local', name: 'x', type: 'utinyint', init: null }], ctx()),
    (error: unknown) => error instanceof TypeError,
  );
});
