import { test } from 'node:test';
import assert from 'node:assert/strict';

import { epilogue, prologue, usesDecimalSensitiveMath } from './commodore.ts';
import type { Directive } from '../asm/assemble.ts';

const VIA_PCR = 0xe84c; // the PET's character-set register: nothing here may touch it

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

test('neither end of a program touches the character-set register', () => {
  // A program exits in whatever set it selected. This used to save $E84C
  // on the way in and put it back on the way out, and could not work: the
  // bit is retroactive, so restoring it re-rendered the text the program
  // had already drawn through the set it had switched away from to draw
  // it. Asserted rather than assumed, because the failure is invisible in
  // a unit test and shows up as mangled glyphs on a real 3032.
  const touchesPcr = (d: Directive) => d.kind === 'instruction' && d.operand?.kind === 'value' && d.operand.value === VIA_PCR;
  for (const needsCld of [true, false]) {
    assert.equal(prologue(needsCld).some(touchesPcr), false, `prologue(${needsCld})`);
  }
  assert.equal(epilogue().some(touchesPcr), false, 'epilogue');
});
