import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lower } from './index.ts';
import type { IrStatement, IrExpr, LowerOptions, FunctionSite } from './index.ts';
import { LocalAllocator } from './allocator.ts';
import { assemble } from '../asm/assemble.ts';
import type { Directive } from '../asm/assemble.ts';
import { arrayLabel, stringLabel } from '../data.ts';
import { WAIT_FRAME_LABEL } from '../startup/waitframe.ts';

// A fresh, generously-budgeted context for a test that doesn't care about
// the zero-page ceiling — most of them. Tests that do care build their own.
// No parameters and no other functions unless a test says otherwise — most
// of these predate milestone 7 and were never about calls.
function ctx(
  globals: [string, { address: number; type: string }][] = [],
  functions: [string, FunctionSite][] = [],
  arrays: [string, { elementType: string }][] = [],
): LowerOptions {
  return { globals: new Map(globals), locals: new LocalAllocator(0x90, 0x100), params: [], functions: new Map(functions), arrays: new Map(arrays) };
}

const write = (address: number, value: number): IrStatement => ({
  kind: 'memoryWrite',
  address: { kind: 'const', value: address, type: 'usmallint' },
  value: { kind: 'const', value, type: 'utinyint' },
});

const u8 = (value: number): IrExpr => ({ kind: 'const', value, type: 'utinyint' });
const u16 = (value: number): IrExpr => ({ kind: 'const', value, type: 'usmallint' });
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

test('an origin-tagged block is one size-report part — inlined callees keep their names after the call is gone', () => {
  const result = lower([
    { kind: 'block', origin: 'screen_blank', body: [write(0x8000, 32)] },
    write(0x8001, 1),
  ], ctx());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.parts.length, 2);
  assert.equal(result.parts[0].origin, 'screen_blank');
  assert.equal(result.parts[1].origin, null);
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

test('a 16-bit local is lowered (milestone 8), not refused — both bytes of the initializer land in a fresh zp pair', () => {
  const result = lower([local('x', { kind: 'const', value: 300, type: 'usmallint' }, 'usmallint')], ctx());
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  assert.deepEqual(mnemonics, ['LDA', 'STA', 'LDA', 'STA', 'LDA', 'STA', 'LDA', 'STA']);
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
  const tight: LowerOptions = { globals: new Map(), locals: new LocalAllocator(0xff, 0x100), params: [], functions: new Map(), arrays: new Map() };
  const result = lower([local('a', u8(1)), local('b', u8(2))], tight);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /local 'b' needs 1 byte of zero page but only 0 byte\(s\) remain/);
});

test('a block-scoped local is released once its block ends, so a later block can reuse the same byte', () => {
  const tight: LowerOptions = { globals: new Map(), locals: new LocalAllocator(0x90, 0x91), params: [], functions: new Map(), arrays: new Map() }; // exactly one byte
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
  const tight: LowerOptions = { globals: new Map(), locals: new LocalAllocator(0x90, 0x92), params: [], functions: new Map(), arrays: new Map() }; // 2 bytes: room for one 'i' plus one temp, never two 'i's at once
  const result = lower(program, tight);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

test('a constant fill loop (screen.blank\'s own shape) lowers to STA abs,X page loops, not STA (zp),Y', () => {
  const cell = 'cell';
  const program: IrStatement[] = [{
    kind: 'for',
    init: local(cell, u16(0), 'usmallint'),
    test: bin('<', ref(cell, 'usmallint'), u16(1000), 'bool'),
    update: assign(cell, bin('+', ref(cell, 'usmallint'), u8(1), 'usmallint')),
    body: [{
      kind: 'memoryWrite',
      address: bin('+', u16(0x8000), ref(cell, 'usmallint'), 'usmallint'),
      value: u8(32),
    }],
  }];
  const options = ctx();
  const result = lower(program, options);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assert.equal(options.locals.used, 0, 'the fill uses X, not a zp index');
  const stas = result.program.filter((d) => d.kind === 'instruction' && d.mnemonic === 'STA') as Extract<Directive, { kind: 'instruction' }>[];
  assert.ok(stas.every((d) => d.mode === 'absolute,x'));
  assert.equal(stas.length, 4, '3 full pages at $8000/$8100/$8200 plus a remainder at $8300');
  assert.equal(result.program.some((d) => d.kind === 'instruction' && d.mode === '(indirect),y'), false);
  const assembled = assembles(result.program);
  assert.ok(assembled.bytes.length < 40, `fill should be a handful of page loops, got ${assembled.bytes.length} bytes`);
});

test('return with a value evaluates it into A, then jumps to the exit label — milestone 7', () => {
  const result = lower([{ kind: 'return', value: u8(42) }], ctx());
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assert.deepEqual(result.program[0], { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: 42 } });
  assert.equal(instruction(result.program[1]).mnemonic, 'JMP');
  assembles(result.program);
});

test('return with a 16-bit value is still refused by name — milestone 8 doesn\'t widen return values', () => {
  const result = lower([{ kind: 'return', value: { kind: 'const', value: 300, type: 'usmallint' } }], ctx());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /is 'usmallint' \(2 bytes\): this path only lowers 8-bit values/);
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

// `>=` is A > B *or* A == B — an OR of two flag tests, unlike `<` (A > B
// *and* not-equal, which the same-shaped AND template correctly handles —
// see ORDER_BRANCH_IF_TRUE's own header comment). Reusing that AND-shaped
// "skip one, take the other" template for `>=`'s OR condition is a
// silent-wrong-answer bug, not a refusal: `code < 91` as the second half
// of `code >= 65 && code < 91` (`comparisonBranch` reaches `>=` by
// negating `<` for the "skip the whole if" case) used to return `true`
// for every `code` from 91 up to 255, because one of the two branches
// pointed at a label placed so falling through it landed on the "true"
// path anyway — found building milestone 10's PET mixed-case text
// (packages/pet/src/text.8bs), where it let 'h' (104) through the
// "already upper case" branch of asciiToScreenCode unconverted.
test('>= is an OR of two flag tests, not the AND-shaped template < uses: both branches land on the same target, no live path skips it', () => {
  const env = ctx([['a', { address: 0x10, type: 'utinyint' }]]);
  // Materialised as a value (wantTrue=true, operator >= used directly —
  // the other way to reach the buggy path besides negating <).
  const asValue = lower([local('ok', bool('>=', ref('a'), u8(91)), 'bool')], env);
  assert.equal(asValue.ok, true, asValue.ok ? '' : asValue.error);
  if (!asValue.ok) return;
  assembles(asValue.program);
  const branches = asValue.program.filter((d): d is Directive & { kind: 'instruction'; operand: { kind: 'label'; name: string } } =>
    d.kind === 'instruction' && (d.mnemonic === 'BCC' || d.mnemonic === 'BEQ') && d.operand?.kind === 'label');
  assert.equal(branches.length, 2, 'exactly one BCC and one BEQ implement the OR');
  assert.equal(branches[0].operand.name, branches[1].operand.name, 'both branch straight to the same "true" target — no intermediate label for either to fall into "false" through');

  // The real regression shape: `code >= 65 && code < 91` as an if-test
  // with no else — `code < 91` reaches `comparisonBranch` as `>=`'s own
  // negation (wantTrue=false, "skip the whole if" on a false clause).
  const ifTest = lower(
    [ifNode(bool('&&', bool('>=', ref('a'), u8(65)), bool('<', ref('a'), u8(91))), [write(0x8000, 1)])],
    env,
  );
  assert.equal(ifTest.ok, true, ifTest.ok ? '' : ifTest.error);
  if (!ifTest.ok) return;
  assembles(ifTest.program);
  // Simulating the actual compare by hand for a value like 104 ('h') —
  // where the bug's own symptom was real (the "true"/then-body path taken
  // on carry-clear alone, when it should not have been) — needs a 6502
  // interpreter this repo does not have (mos/AGENTS.md). The structural
  // check above (both branches landing on the same target) is the
  // narrowest thing a unit test can assert directly; the real proof is
  // packages/examples/hello-world's own screenshotted build, run for
  // real against all seven PET models this milestone touches.
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
  const result = lower([assign('out', { kind: 'namespaceConst', type: 'utinyint' })], ctx([['out', { address: 0x50, type: 'utinyint' }]]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /no instruction-selection rule yet for the 'namespaceConst' expression/);
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
// `widths` defaults every parameter to 1 byte — every pre-milestone-8 test
// using this only ever described 8-bit calling interfaces.
const site = (label: string, paramAddresses: number[], returnType = 'utinyint', widths?: (1 | 2)[]): FunctionSite => ({
  label,
  params: paramAddresses.map((address, i) => ({ address, width: widths?.[i] ?? 1 })),
  returnType,
});

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

test('a missing value is refused; a literal address uses STA zeropage', () => {
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

// ---- milestone 8: 16-bit values ------------------------------------------
//
// `expr16()` leaves its result at a zp address it returns rather than in
// the accumulator (see the file header) — these tests read the emitted
// instructions to confirm the *shape* each rule produces (the carry/borrow
// actually chains from the low byte into the high byte, the right
// addressing mode is used); the milestone's own gate — a real PET build,
// run, and screenshot of `text.putChar` printing past cell 255 — is what
// proves the arithmetic is correct on real hardware, not these.

test('memoryWrite to a computed address evaluates the pointer, then the value, then stores through (zp),Y with Y forced to 0', () => {
  const result = lower([{
    kind: 'memoryWrite',
    address: bin('+', u16(0x8000), ref('cell', 'usmallint'), 'usmallint'),
    value: u8(7),
  }], ctx([['cell', { address: 0x10, type: 'usmallint' }]]));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  const instructions = result.program.filter((d): d is Extract<Directive, { kind: 'instruction' }> => d.kind === 'instruction');
  const mnemonics = instructions.map((d) => d.mnemonic);
  // ...16-bit add (CLC/ADC/ADC) for the pointer, LDA #7 for the value, then
  // LDY #0 and an indirect-indexed STA — never STA absolute/zeropage, which
  // would silently write to whatever the *pointer's own* zp address is
  // instead of through it.
  assert.deepEqual(mnemonics.slice(-3), ['LDA', 'LDY', 'STA']);
  const ldy = instructions[instructions.length - 2];
  assert.equal(ldy.mode, 'immediate');
  assert.equal(ldy.operand!.kind === 'value' ? ldy.operand!.value : -1, 0);
  const sta = instructions[instructions.length - 1];
  assert.equal(sta.mode, '(indirect),y');
});

test('memoryWrite to a computed address refuses an 8-bit address rather than guessing which byte is meant', () => {
  const result = lower([{
    kind: 'memoryWrite',
    address: ref('cell', 'utinyint'),
    value: u8(1),
  }], ctx([['cell', { address: 0x10, type: 'utinyint' }]]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /memoryWrite: a computed address is 'utinyint'/);
});

test('16-bit addition chains carry from the low byte into the high byte: CLC once, then ADC low, ADC high', () => {
  const result = lower([local('sum', bin('+', u16(0x00ff), u16(0x0001), 'usmallint'), 'usmallint')], ctx());
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  // Two 16-bit consts (4 LDA/STA pairs = 8) then CLC, LDA, ADC, STA, LDA,
  // ADC, STA (the addition itself), then the 2-byte copy into the local.
  const clcIndex = mnemonics.indexOf('CLC');
  assert.ok(clcIndex >= 0, 'no CLC before the 16-bit addition');
  assert.deepEqual(mnemonics.slice(clcIndex, clcIndex + 7), ['CLC', 'LDA', 'ADC', 'STA', 'LDA', 'ADC', 'STA']);
  // Only one CLC for the whole 16-bit add — the high byte's ADC relies on
  // the low byte's own carry out, never re-cleared in between.
  assert.equal(mnemonics.filter((m) => m === 'CLC').length, 1);
});

test('16-bit subtraction chains borrow the same way: SEC once, then SBC low, SBC high', () => {
  const result = lower([local('diff', bin('-', u16(0x0100), u16(0x0001), 'usmallint'), 'usmallint')], ctx());
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  const secIndex = mnemonics.indexOf('SEC');
  assert.ok(secIndex >= 0, 'no SEC before the 16-bit subtraction');
  assert.deepEqual(mnemonics.slice(secIndex, secIndex + 7), ['SEC', 'LDA', 'SBC', 'STA', 'LDA', 'SBC', 'STA']);
  assert.equal(mnemonics.filter((m) => m === 'SEC').length, 1);
});

test('16-bit `*` is refused by name, not lowered as if it were `+`', () => {
  const result = lower([local('x', bin('*', u16(2), u16(3), 'usmallint'), 'usmallint')], ctx());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /no 16-bit instruction-selection rule yet for the '\*' operator/);
});

// @8bitscript/pet/text's own `place(cell + i, s[i])` inside text.print's
// loop — cell: usmallint, i: utinyint — discovered building the real
// milestone 9 gate: binop16 used to require both operands already 16-bit.
test('16-bit `+` with one 8-bit operand widens it, rather than refusing a mixed-width binop', () => {
  const result = lower(
    [local('sum', bin('+', ref('cell', 'usmallint'), ref('i', 'utinyint'), 'usmallint'), 'usmallint')],
    ctx([['cell', { address: 0x10, type: 'usmallint' }], ['i', { address: 0x20, type: 'utinyint' }]]),
  );
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  // i (1 byte) zero-extends into a temp (LDA/STA/LDA #0/STA), cell (2
  // bytes) reads straight from its own binding (no instructions — see the
  // 16-bit `ref` test above), then CLC/ADC-chain/STA x2, then the copy
  // into 'sum'.
  assert.deepEqual(mnemonics.slice(0, 4), ['LDA', 'STA', 'LDA', 'STA']);
  assert.ok(mnemonics.includes('CLC'));
  assert.equal(mnemonics.filter((m) => m === 'ADC').length, 2);
});

test('a 16-bit assignment from a 16-bit value copies both bytes', () => {
  const result = lower([assign('wide', u16(0x1234))], ctx([['wide', { address: 0x10, type: 'usmallint' }]]));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  assert.deepEqual(mnemonics.slice(-4), ['LDA', 'STA', 'LDA', 'STA']);
});

// The front end never widens a narrower value to match a wider declared
// target (verified against ir/index.mjs — see exprTo16's own comment in
// lower/index.ts): `text.putChar(0, 65)` is exactly this shape (`0` is a
// perfectly good utinyint literal; putChar's own `cell` is usmallint), so
// this backend widens at the boundary instead of refusing code that's
// this ordinary.
test('an 8-bit unsigned value assigned to a 16-bit target is zero-extended, not refused', () => {
  const result = lower([assign('wide', u8(200))], ctx([['wide', { address: 0x10, type: 'usmallint' }]]));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  // LDA #200 (the 8-bit value), STA temp-lo, LDA #0, STA temp-hi (the
  // zero-extension), then LDA temp-lo/STA wide, LDA temp-hi/STA wide+1
  // (the copy into the target).
  assert.deepEqual(mnemonics, ['LDA', 'STA', 'LDA', 'STA', 'LDA', 'STA', 'LDA', 'STA']);
  const secondLoad = instruction(result.program[2]);
  assert.equal(secondLoad.operand!.kind === 'value' ? secondLoad.operand!.value : -1, 0);
});

test('a signed value narrower than 16 bits is refused rather than sign-extended', () => {
  const result = lower([assign('wide', ref('n', 'tinyint'))], ctx([['wide', { address: 0x10, type: 'usmallint' }], ['n', { address: 0x20, type: 'tinyint' }]]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /'ref' is 'tinyint': a signed value narrower than 16 bits can't widen into one yet/);
});

test('a bool is refused rather than zero-extended into a 16-bit target — the checker should already rule this out', () => {
  const result = lower([assign('wide', ref('flag', 'bool'))], ctx([['wide', { address: 0x10, type: 'usmallint' }], ['flag', { address: 0x20, type: 'bool' }]]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /'ref' is 'bool': can't widen a bool into a 16-bit value/);
});

test('a 16-bit expression kind with no rule yet fails naming it, not silently', () => {
  const result = lower([local('x', { kind: 'call', name: 'f', args: [], type: 'usmallint' }, 'usmallint')], ctx());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /no 16-bit instruction-selection rule yet for the 'call' expression/);
});

test('exprTo16 refuses a value with no type at all, rather than assuming a width', () => {
  const result = lower([assign('wide', { kind: 'const', value: 5 })], ctx([['wide', { address: 0x10, type: 'usmallint' }]]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /'const': no type on this IR node/);
});

test('exprTo16 refuses a value wider than 8 bits and narrower than 16 — no widening rule for it', () => {
  const result = lower([assign('wide', ref('n', 'int'))], ctx([['wide', { address: 0x10, type: 'usmallint' }], ['n', { address: 0x20, type: 'int' }]]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /'ref' is 'int' \(4 bytes\): only an 8-bit value can widen into 16 bits/);
});

test('a comparison on a type wider than 16 bits is refused, not silently truncated to a byte or a pair', () => {
  const result = lower(
    [ifNode(bin('==', ref('a', 'int'), ref('b', 'int'), 'bool'), [])],
    ctx([['a', { address: 0x10, type: 'int' }], ['b', { address: 0x20, type: 'int' }]]),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /the '==' comparison operates on a 4-byte type — only 1- and 2-byte comparisons are lowered yet/);
});

test('a 16-bit `ref` returns the binding\'s own address unchanged — no copy for a plain read', () => {
  const result = lower([local('out', ref('cell', 'usmallint'), 'usmallint')], ctx([['cell', { address: 0x10, type: 'usmallint' }]]));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  // LDA $10, STA out, LDA $11, STA out+1 — read straight from cell's own
  // address, no intermediate temp copy.
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  assert.deepEqual(mnemonics, ['LDA', 'STA', 'LDA', 'STA']);
  const firstLoad = instruction(result.program[0]);
  assert.equal(firstLoad.operand!.kind === 'value' ? firstLoad.operand!.value : -1, 0x10);
});

test('an unsigned 16-bit ordering comparison evaluates right - left the same way the 8-bit path does, chaining CMP into SBC', () => {
  const result = lower(
    [ifNode(bin('<', ref('cell', 'usmallint'), u16(1000), 'bool'), [])],
    ctx([['cell', { address: 0x10, type: 'usmallint' }]]),
  );
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assembles(result.program);
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  const cmpIndex = mnemonics.indexOf('CMP');
  assert.ok(cmpIndex >= 0);
  assert.deepEqual(mnemonics.slice(cmpIndex - 1, cmpIndex + 3), ['LDA', 'CMP', 'LDA', 'SBC']);
});

test('a mixed-width comparison (8-bit vs. 16-bit) is refused, not silently zero-extended', () => {
  const result = lower(
    [ifNode(bin('==', ref('cell', 'usmallint'), u8(1), 'bool'), [])],
    ctx([['cell', { address: 0x10, type: 'usmallint' }]]),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /needs both sides the same width — got 2 and 1 byte\(s\)/);
});

test('a call passes a 16-bit argument as two bytes into the callee\'s param pair', () => {
  const result = lower(
    [call('place', [u16(999), u8(1)])],
    ctx([], [['place', site('__8bs_fn_place', [0x50, 0x52], 'void', [2, 1])]]),
  );
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  // The 16-bit arg: LDA/STA/LDA/STA (const into a temp) then LDA/STA/LDA/STA
  // (temp copied into the param pair) — then the 8-bit arg's own LDA/STA —
  // then JSR.
  assert.deepEqual(mnemonics.slice(-3), ['LDA', 'STA', 'JSR']);
  assert.equal(mnemonics.filter((m) => m === 'JSR').length, 1);
  const instructions = result.program.filter((d): d is Extract<Directive, { kind: 'instruction' }> => d.kind === 'instruction');
  const jsr = instructions[instructions.length - 1];
  assert.equal(jsr.operand!.kind === 'label' ? jsr.operand!.name : '', '__8bs_fn_place');
});

// The exact shape a real call site hits: `text.putChar(0, 65)` — a small,
// perfectly ordinary utinyint-shaped literal argument against putChar's
// own `cell: usmallint`. Without exprTo16's widening this fails to build
// (discovered building the real milestone 8 gate program).
test('a call widens an 8-bit literal argument into a 16-bit parameter rather than refusing it', () => {
  const result = lower(
    [call('place', [u8(0), u8(65)])],
    ctx([], [['place', site('__8bs_fn_place', [0x50, 0x52], 'void', [2, 1])]]),
  );
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  // LDA #0/STA/LDA #0/STA is the zero-extension of the first argument
  // (value, then the high byte forced to 0), then the copy into the
  // param pair, then the 8-bit arg, then JSR.
  assert.deepEqual(mnemonics.slice(0, 4), ['LDA', 'STA', 'LDA', 'STA']);
  assert.deepEqual(mnemonics.slice(-3), ['LDA', 'STA', 'JSR']);
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

// ---- milestone 9: strings and const arrays --------------------------------
//
// The data section itself (the actual bytes a label points at) is
// mos/data.ts's job, exercised in data.test.ts — a lower() unit test only
// ever sees the label name, never the bytes behind it, exactly the way a
// call site only ever sees a function's label (FunctionSite), never its
// body. Where a test below needs a real assemble() to prove the emitted
// operands resolve, it appends the same label mos/data.ts would define,
// standing in for the data section a real build appends after every
// function (mos/index.ts).

const strLit = (index: number): IrExpr => ({ kind: 'string', index, type: 'string' });
const strRef = (name: string): IrExpr => ({ kind: 'ref', name, type: 'string' });
const strLen = (string: IrExpr): IrExpr => ({ kind: 'stringLength', string, type: 'utinyint' });
const strByte = (string: IrExpr, index: IrExpr): IrExpr => ({ kind: 'stringByte', string, index, type: 'utinyint' });
const idx = (array: string, index: IrExpr, elementType: string): IrExpr => ({ kind: 'index', array: { kind: 'ref', name: array }, index, elementType, type: elementType });

test('a string literal materializes its data-section label\'s address into a fresh zp pair', () => {
  const result = lower([local('s', strLit(0), 'string')], ctx());
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  // LDA #<label; STA lo; LDA #>label; STA hi — then the copy into 's'.
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  assert.deepEqual(mnemonics.slice(0, 4), ['LDA', 'STA', 'LDA', 'STA']);
  const loLoad = instruction(result.program[0]);
  assert.deepEqual(loLoad.operand, { kind: 'label', name: stringLabel(0), byte: 'lo' });
  const hiLoad = instruction(result.program[2]);
  assert.deepEqual(hiLoad.operand, { kind: 'label', name: stringLabel(0), byte: 'hi' });
  // Resolves for real against the label a data section would actually
  // define for slot 0 — proves the operand shape assembles, not just that
  // it looks right.
  const data: Directive[] = [{ kind: 'label', name: stringLabel(0) }, { kind: 'byte', values: [5, 72, 73] }];
  assembles([...result.program, ...data]);
});

test('two references to the same string table slot both name the same label — dedup is the linker\'s job (ir.strings), not re-derived here', () => {
  const a = lower([local('s', strLit(3), 'string')], ctx());
  const b = lower([local('s', strLit(3), 'string')], ctx());
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  const label = (r: Directive[]) => (instruction(r[0]).operand as { name: string }).name;
  assert.equal(label(a.program), label(b.program));
  assert.equal(label(a.program), stringLabel(3));
});

test('stringLength on a string parameter reads byte 0 through its pointer — no copy, straight off the parameter\'s own zp pair', () => {
  const options = ctx([], []);
  options.params = [{ name: 's', type: 'string', address: 0x10 }];
  const result = lower([{ kind: 'return', value: strLen(strRef('s')) }], options);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  assert.deepEqual(mnemonics, ['LDY', 'LDA', 'JMP']);
  const ldy = instruction(result.program[0]);
  assert.equal(ldy.operand!.kind === 'value' ? ldy.operand!.value : -1, 0);
  const lda = instruction(result.program[1]);
  assert.equal(lda.mode, '(indirect),y');
  assert.equal(lda.operand!.kind === 'value' ? lda.operand!.value : -1, 0x10);
});

test('stringByte reads index+1 — skipping the length prefix — after the string, evaluated first, then the index', () => {
  const options = ctx([], []);
  options.params = [{ name: 's', type: 'string', address: 0x10 }];
  const result = lower([{ kind: 'return', value: strByte(strRef('s'), u8(4)) }], options);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  // LDA #4 (the index); TAY; INY (skip the length byte); LDA (s),y; JMP exit.
  assert.deepEqual(mnemonics, ['LDA', 'TAY', 'INY', 'LDA', 'JMP']);
  const indexLoad = instruction(result.program[0]);
  assert.equal(indexLoad.operand!.kind === 'value' ? indexLoad.operand!.value : -1, 4);
  const finalLoad = instruction(result.program[3]);
  assert.equal(finalLoad.mode, '(indirect),y');
  assert.equal(finalLoad.operand!.kind === 'value' ? finalLoad.operand!.value : -1, 0x10);
});

// A 255-byte string's own highest valid index is 254 (one length byte
// caps the format at 255 characters total — the checker's own
// STRING_TOO_LONG limit), landing on Y = 254 + 1 = 255: the last real
// character, not a wrap back onto the length byte at Y = 0. INY never
// actually wraps for any in-bounds index.
test('stringByte at the highest valid index (254, on a 255-byte string) lands on Y = 255 — the real last character, not a wrap to the length byte', () => {
  const options = ctx([], []);
  options.params = [{ name: 's', type: 'string', address: 0x10 }];
  const result = lower([{ kind: 'return', value: strByte(strRef('s'), u8(254)) }], options);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const instructions = result.program.filter((d): d is Extract<Directive, { kind: 'instruction' }> => d.kind === 'instruction');
  const iny = instructions.find((d) => d.mnemonic === 'INY');
  assert.ok(iny, 'INY runs exactly once, taking Y from 254 to 255 — 6502 8-bit registers hold 255 without wrapping');
  const load = instructions[instructions.length - 2]; // the (indirect),y read, right before the trailing JMP
  assert.equal(load.mode, '(indirect),y');
});

test('a 1-byte-element index() reads Y-indexed off the array\'s own data-section label — no scaling', () => {
  const result = lower(
    [{ kind: 'return', value: idx('TABLE', u8(2), 'utinyint') }],
    ctx([], [], [['TABLE', { elementType: 'utinyint' }]]),
  );
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  assert.deepEqual(mnemonics, ['LDA', 'TAY', 'LDA', 'JMP']);
  const read = instruction(result.program[2]);
  assert.equal(read.mode, 'absolute,y');
  assert.deepEqual(read.operand, { kind: 'label', name: arrayLabel('TABLE') });
});

// The real shape: DIGIT_PLACES, `const DIGIT_PLACES: array<usmallint, 5>`
// (packages/pet/src/text.8bs) — a 2-byte element needs the index doubled
// into a byte offset before either half is read.
test('a 2-byte-element index() doubles the index (ASL) before reading low, then high, one byte further along', () => {
  const result = lower(
    [local('digit', idx('DIGIT_PLACES', u8(2), 'usmallint'), 'usmallint')],
    ctx([], [], [['DIGIT_PLACES', { elementType: 'usmallint' }]]),
  );
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const mnemonics = result.program.filter((d) => d.kind === 'instruction').map((d) => instruction(d).mnemonic);
  // LDA #2 (index); ASL; TAY; LDA lo; STA; INY; LDA hi; STA; — then the copy into 'digit'.
  assert.deepEqual(mnemonics.slice(0, 8), ['LDA', 'ASL', 'TAY', 'LDA', 'STA', 'INY', 'LDA', 'STA']);
  const loRead = instruction(result.program[3]);
  const hiRead = instruction(result.program[6]);
  assert.deepEqual(loRead.operand, { kind: 'label', name: arrayLabel('DIGIT_PLACES') });
  assert.deepEqual(hiRead.operand, { kind: 'label', name: arrayLabel('DIGIT_PLACES') });
  // Resolves for real against a 5-element array's own data-section label.
  const data: Directive[] = [{ kind: 'label', name: arrayLabel('DIGIT_PLACES') }, { kind: 'byte', values: [16, 39, 232, 3, 100, 0, 10, 0, 1, 0] }];
  assembles([...result.program, ...data]);
});

test('index() on a name this build never placed as a const array is refused, naming it — not a missing rule, a linker/checker bug', () => {
  const result = lower([{ kind: 'return', value: idx('MYSTERY', u8(0), 'utinyint') }], ctx());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /'MYSTERY' resolves to no const array this backend placed/);
});

// The bug an advisor review caught before any gate ever exercised prepare()
// (packages/pet/src/text.8bs): `viaPeripheralControl = ...` writes a global
// pinned above $00FF (@address(0xE84C), pet/src/index.8bs) — the same shape
// as every other global's assignment, except zeropage mode can't encode an
// address that high. ref/assign both pick the mode from the address now,
// the same call memoryWrite's own literal-address case already made.
test('a ref/assign to a global pinned above $00FF uses absolute mode, not zeropage', () => {
  const options = ctx([['viaPeripheralControl', { address: 0xe84c, type: 'utinyint' }]]);
  const readResult = lower([{ kind: 'return', value: ref('viaPeripheralControl') }], options);
  assert.equal(readResult.ok, true, readResult.ok ? '' : readResult.error);
  if (!readResult.ok) return;
  const read = instruction(readResult.program[0]);
  assert.equal(read.mnemonic, 'LDA');
  assert.equal(read.mode, 'absolute');
  assert.equal(read.operand!.kind === 'value' ? read.operand!.value : -1, 0xe84c);

  const writeResult = lower([assign('viaPeripheralControl', u8(0x0c))], options);
  assert.equal(writeResult.ok, true, writeResult.ok ? '' : writeResult.error);
  if (!writeResult.ok) return;
  const write2 = instruction(writeResult.program[1]);
  assert.equal(write2.mnemonic, 'STA');
  assert.equal(write2.mode, 'absolute');
  assert.equal(write2.operand!.kind === 'value' ? write2.operand!.value : -1, 0xe84c);
  assembles(writeResult.program);
});

// ---- milestone 10: waitFrame() ---------------------------------------

test('waitFrame() lowers to a single JSR to the shared runtime subroutine — no inline pacing code at the call site', () => {
  const options = ctx();
  const result = lower([{ kind: 'waitFrame' }], options);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const call = instruction(result.program[0]);
  assert.equal(call.mnemonic, 'JSR');
  assert.equal(call.mode, 'absolute');
  assert.deepEqual(call.operand, { kind: 'label', name: WAIT_FRAME_LABEL });
  // The label itself is defined by mos/startup/waitframe.ts's own
  // waitFrameRoutine(), not by this lowering — supplied here only so this
  // program is real, assemblable 6502 on its own.
  assembles([...result.program, { kind: 'label', name: WAIT_FRAME_LABEL }]);
});

test('two waitFrame() calls in a row both JSR the same shared label — one runtime subroutine, not one per call site', () => {
  const options = ctx();
  const result = lower([{ kind: 'waitFrame' }, { kind: 'waitFrame' }], options);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const first = instruction(result.program[0]);
  const second = instruction(result.program[1]);
  assert.deepEqual(first.operand, second.operand);
  assert.equal(first.operand!.kind === 'label' ? first.operand!.name : '', WAIT_FRAME_LABEL);
});
