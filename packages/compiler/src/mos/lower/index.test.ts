import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lower } from './index.ts';
import type { IrStatement } from './index.ts';
import type { Directive } from '../asm/assemble.ts';

const write = (address: number, value: number): IrStatement => ({
  kind: 'memoryWrite',
  address: { kind: 'const', value: address, type: 'usmallint' },
  value: { kind: 'const', value, type: 'utinyint' },
});

// lower() only ever emits 'instruction' directives (no labels, no .byte),
// so this narrows the union for the tests that inspect mode/mnemonic.
function instruction(directive: Directive) {
  assert.equal(directive.kind, 'instruction');
  if (directive.kind !== 'instruction') throw new Error('unreachable');
  return directive;
}

test('an empty body lowers to an empty program', () => {
  const result = lower([]);
  assert.deepEqual(result, { ok: true, program: [] });
});

test('memoryWrite of a literal to a literal absolute address is LDA #value; STA address', () => {
  const result = lower([write(0x8000, 8)]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.program, [
    { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: 8 } },
    { kind: 'instruction', mnemonic: 'STA', mode: 'absolute', operand: { kind: 'value', value: 0x8000 } },
  ]);
});

test('a store to a zero-page address ($0000-$00FF) uses the 2-byte STA zeropage form, not the 3-byte absolute one', () => {
  const zp = lower([write(0x00fb, 1)]);
  assert.equal(zp.ok, true);
  if (zp.ok) assert.equal(instruction(zp.program[1]).mode, 'zeropage');

  const justPast = lower([write(0x0100, 1)]);
  assert.equal(justPast.ok, true);
  if (justPast.ok) assert.equal(instruction(justPast.program[1]).mode, 'absolute');
});

test('several writes in a row lower in order, one LDA/STA pair per statement', () => {
  const result = lower([write(0x8000, 8), write(0x8001, 5)]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.program.length, 4);
  assert.equal(instruction(result.program[0]).mnemonic, 'LDA');
  assert.equal(instruction(result.program[1]).mnemonic, 'STA');
  assert.equal(instruction(result.program[2]).mnemonic, 'LDA');
  assert.equal(instruction(result.program[3]).mnemonic, 'STA');
});

test('a memoryWrite whose address is not yet a literal is refused, naming the construct and what it got instead', () => {
  const result = lower([{ kind: 'memoryWrite', address: { kind: 'ref' }, value: { kind: 'const', value: 1 } }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /memoryWrite: the address must be a literal for now \(got 'ref'\)/);
});

test('a memoryWrite whose value is not yet a literal is refused the same way', () => {
  const result = lower([{ kind: 'memoryWrite', address: { kind: 'const', value: 1 }, value: { kind: 'call' } }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /memoryWrite: the value must be a literal for now \(got 'call'\)/);
});

test('a statement kind with no rule yet fails naming it, not silently', () => {
  const result = lower([{ kind: 'if' }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /no instruction-selection rule yet for 'if'/);
});
