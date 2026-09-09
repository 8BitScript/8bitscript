import { test } from 'node:test';
import assert from 'node:assert/strict';

import { epilogue, prologue, usesDecimalSensitiveMath } from './commodore.ts';
import type { Directive } from '../asm/assemble.ts';

test('epilogue: RTS, and nothing else', () => {
  assert.deepEqual(epilogue(), [{ kind: 'instruction', mnemonic: 'RTS', mode: 'implied' }]);
});

test('usesDecimalSensitiveMath: false for a program with no ADC or SBC', () => {
  const program: Directive[] = [
    { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: 1 } },
    { kind: 'instruction', mnemonic: 'STA', mode: 'zeropage', operand: { kind: 'value', value: 0x90 } },
  ];
  assert.equal(usesDecimalSensitiveMath(program), false);
});

test('usesDecimalSensitiveMath: true the moment an ADC or an SBC appears anywhere in the program', () => {
  const withAdc: Directive[] = [{ kind: 'instruction', mnemonic: 'ADC', mode: 'zeropage', operand: { kind: 'value', value: 0x90 } }];
  assert.equal(usesDecimalSensitiveMath(withAdc), true);
  const withSbc: Directive[] = [{ kind: 'instruction', mnemonic: 'SBC', mode: 'immediate', operand: { kind: 'value', value: 1 } }];
  assert.equal(usesDecimalSensitiveMath(withSbc), true);
});

test('prologue(true) is CLD; prologue(false) is empty — a program with no +/- pays nothing for a flag it never reads', () => {
  assert.deepEqual(prologue(true), [{ kind: 'instruction', mnemonic: 'CLD', mode: 'implied' }]);
  assert.deepEqual(prologue(false), []);
});
