import { test } from 'node:test';
import assert from 'node:assert/strict';

import { epilogue, prologue, usesCharacterSet, usesDecimalSensitiveMath } from './commodore.ts';
import type { Directive } from '../asm/assemble.ts';

const staPcr: Directive = { kind: 'instruction', mnemonic: 'STA', mode: 'absolute', operand: { kind: 'value', value: 0xe84c } };

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

test('usesCharacterSet: false for a program that never writes $E84C', () => {
  const program: Directive[] = [
    { kind: 'instruction', mnemonic: 'LDA', mode: 'absolute', operand: { kind: 'value', value: 0xe84c } },
    { kind: 'instruction', mnemonic: 'STA', mode: 'absolute', operand: { kind: 'value', value: 0x8000 } },
  ];
  assert.equal(usesCharacterSet(program), false, 'reading the register, or writing the screen, is not selecting a character set');
});

test('usesCharacterSet: true for any store to $E84C, whichever register it came from', () => {
  assert.equal(usesCharacterSet([staPcr]), true);
  for (const mnemonic of ['STX', 'STY']) {
    assert.equal(usesCharacterSet([{ kind: 'instruction', mnemonic, mode: 'absolute', operand: { kind: 'value', value: 0xe84c } }]), true, mnemonic);
  }
});

test('the character set is saved on the stack and given back — four bytes each side, no RAM cell', () => {
  assert.deepEqual(prologue(false, true), [
    { kind: 'instruction', mnemonic: 'LDA', mode: 'absolute', operand: { kind: 'value', value: 0xe84c } },
    { kind: 'instruction', mnemonic: 'PHA', mode: 'implied' },
  ]);
  assert.deepEqual(epilogue(true), [
    { kind: 'instruction', mnemonic: 'PLA', mode: 'implied' },
    staPcr,
    { kind: 'instruction', mnemonic: 'RTS', mode: 'implied' },
  ]);
});

test('CLD comes before the character-set save, so the copy is taken with the flag already known-clear', () => {
  assert.deepEqual(prologue(true, true).map((d) => (d.kind === 'instruction' ? d.mnemonic : d.kind)), ['CLD', 'LDA', 'PHA']);
});

test('a program that never selects a character set pays nothing for restoring one', () => {
  assert.deepEqual(prologue(false, false), []);
  assert.deepEqual(epilogue(false), [{ kind: 'instruction', mnemonic: 'RTS', mode: 'implied' }]);
});
