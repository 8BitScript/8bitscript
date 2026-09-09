import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encode, operandBytes, instructionBytes, OPCODES } from './encode.ts';
import type { AddressingMode } from './encode.ts';

// Every legal NMOS 6502 opcode: mnemonic, mode, the opcode byte, and the
// instruction's total length — copied from a published reference
// (masswerk.at/6502/6502_instruction_set.html), not retyped from the table
// above, so this test can actually catch a transcription mistake in it.
const PUBLISHED: [string, AddressingMode, number, 1 | 2 | 3][] = [
  ['ADC', 'immediate', 0x69, 2], ['ADC', 'zeropage', 0x65, 2], ['ADC', 'zeropage,x', 0x75, 2],
  ['ADC', 'absolute', 0x6d, 3], ['ADC', 'absolute,x', 0x7d, 3], ['ADC', 'absolute,y', 0x79, 3],
  ['ADC', '(indirect,x)', 0x61, 2], ['ADC', '(indirect),y', 0x71, 2],
  ['AND', 'immediate', 0x29, 2], ['AND', 'zeropage', 0x25, 2], ['AND', 'zeropage,x', 0x35, 2],
  ['AND', 'absolute', 0x2d, 3], ['AND', 'absolute,x', 0x3d, 3], ['AND', 'absolute,y', 0x39, 3],
  ['AND', '(indirect,x)', 0x21, 2], ['AND', '(indirect),y', 0x31, 2],
  ['ASL', 'accumulator', 0x0a, 1], ['ASL', 'zeropage', 0x06, 2], ['ASL', 'zeropage,x', 0x16, 2],
  ['ASL', 'absolute', 0x0e, 3], ['ASL', 'absolute,x', 0x1e, 3],
  ['BCC', 'relative', 0x90, 2], ['BCS', 'relative', 0xb0, 2], ['BEQ', 'relative', 0xf0, 2],
  ['BIT', 'zeropage', 0x24, 2], ['BIT', 'absolute', 0x2c, 3],
  ['BMI', 'relative', 0x30, 2], ['BNE', 'relative', 0xd0, 2], ['BPL', 'relative', 0x10, 2],
  ['BRK', 'implied', 0x00, 1], ['BVC', 'relative', 0x50, 2], ['BVS', 'relative', 0x70, 2],
  ['CLC', 'implied', 0x18, 1], ['CLD', 'implied', 0xd8, 1], ['CLI', 'implied', 0x58, 1], ['CLV', 'implied', 0xb8, 1],
  ['CMP', 'immediate', 0xc9, 2], ['CMP', 'zeropage', 0xc5, 2], ['CMP', 'zeropage,x', 0xd5, 2],
  ['CMP', 'absolute', 0xcd, 3], ['CMP', 'absolute,x', 0xdd, 3], ['CMP', 'absolute,y', 0xd9, 3],
  ['CMP', '(indirect,x)', 0xc1, 2], ['CMP', '(indirect),y', 0xd1, 2],
  ['CPX', 'immediate', 0xe0, 2], ['CPX', 'zeropage', 0xe4, 2], ['CPX', 'absolute', 0xec, 3],
  ['CPY', 'immediate', 0xc0, 2], ['CPY', 'zeropage', 0xc4, 2], ['CPY', 'absolute', 0xcc, 3],
  ['DEC', 'zeropage', 0xc6, 2], ['DEC', 'zeropage,x', 0xd6, 2], ['DEC', 'absolute', 0xce, 3], ['DEC', 'absolute,x', 0xde, 3],
  ['DEX', 'implied', 0xca, 1], ['DEY', 'implied', 0x88, 1],
  ['EOR', 'immediate', 0x49, 2], ['EOR', 'zeropage', 0x45, 2], ['EOR', 'zeropage,x', 0x55, 2],
  ['EOR', 'absolute', 0x4d, 3], ['EOR', 'absolute,x', 0x5d, 3], ['EOR', 'absolute,y', 0x59, 3],
  ['EOR', '(indirect,x)', 0x41, 2], ['EOR', '(indirect),y', 0x51, 2],
  ['INC', 'zeropage', 0xe6, 2], ['INC', 'zeropage,x', 0xf6, 2], ['INC', 'absolute', 0xee, 3], ['INC', 'absolute,x', 0xfe, 3],
  ['INX', 'implied', 0xe8, 1], ['INY', 'implied', 0xc8, 1],
  ['JMP', 'absolute', 0x4c, 3], ['JMP', 'indirect', 0x6c, 3], ['JSR', 'absolute', 0x20, 3],
  ['LDA', 'immediate', 0xa9, 2], ['LDA', 'zeropage', 0xa5, 2], ['LDA', 'zeropage,x', 0xb5, 2],
  ['LDA', 'absolute', 0xad, 3], ['LDA', 'absolute,x', 0xbd, 3], ['LDA', 'absolute,y', 0xb9, 3],
  ['LDA', '(indirect,x)', 0xa1, 2], ['LDA', '(indirect),y', 0xb1, 2],
  ['LDX', 'immediate', 0xa2, 2], ['LDX', 'zeropage', 0xa6, 2], ['LDX', 'zeropage,y', 0xb6, 2],
  ['LDX', 'absolute', 0xae, 3], ['LDX', 'absolute,y', 0xbe, 3],
  ['LDY', 'immediate', 0xa0, 2], ['LDY', 'zeropage', 0xa4, 2], ['LDY', 'zeropage,x', 0xb4, 2],
  ['LDY', 'absolute', 0xac, 3], ['LDY', 'absolute,x', 0xbc, 3],
  ['LSR', 'accumulator', 0x4a, 1], ['LSR', 'zeropage', 0x46, 2], ['LSR', 'zeropage,x', 0x56, 2],
  ['LSR', 'absolute', 0x4e, 3], ['LSR', 'absolute,x', 0x5e, 3],
  ['NOP', 'implied', 0xea, 1],
  ['ORA', 'immediate', 0x09, 2], ['ORA', 'zeropage', 0x05, 2], ['ORA', 'zeropage,x', 0x15, 2],
  ['ORA', 'absolute', 0x0d, 3], ['ORA', 'absolute,x', 0x1d, 3], ['ORA', 'absolute,y', 0x19, 3],
  ['ORA', '(indirect,x)', 0x01, 2], ['ORA', '(indirect),y', 0x11, 2],
  ['PHA', 'implied', 0x48, 1], ['PHP', 'implied', 0x08, 1], ['PLA', 'implied', 0x68, 1], ['PLP', 'implied', 0x28, 1],
  ['ROL', 'accumulator', 0x2a, 1], ['ROL', 'zeropage', 0x26, 2], ['ROL', 'zeropage,x', 0x36, 2],
  ['ROL', 'absolute', 0x2e, 3], ['ROL', 'absolute,x', 0x3e, 3],
  ['ROR', 'accumulator', 0x6a, 1], ['ROR', 'zeropage', 0x66, 2], ['ROR', 'zeropage,x', 0x76, 2],
  ['ROR', 'absolute', 0x6e, 3], ['ROR', 'absolute,x', 0x7e, 3],
  ['RTI', 'implied', 0x40, 1], ['RTS', 'implied', 0x60, 1],
  ['SBC', 'immediate', 0xe9, 2], ['SBC', 'zeropage', 0xe5, 2], ['SBC', 'zeropage,x', 0xf5, 2],
  ['SBC', 'absolute', 0xed, 3], ['SBC', 'absolute,x', 0xfd, 3], ['SBC', 'absolute,y', 0xf9, 3],
  ['SBC', '(indirect,x)', 0xe1, 2], ['SBC', '(indirect),y', 0xf1, 2],
  ['SEC', 'implied', 0x38, 1], ['SED', 'implied', 0xf8, 1], ['SEI', 'implied', 0x78, 1],
  ['STA', 'zeropage', 0x85, 2], ['STA', 'zeropage,x', 0x95, 2], ['STA', 'absolute', 0x8d, 3],
  ['STA', 'absolute,x', 0x9d, 3], ['STA', 'absolute,y', 0x99, 3], ['STA', '(indirect,x)', 0x81, 2], ['STA', '(indirect),y', 0x91, 2],
  ['STX', 'zeropage', 0x86, 2], ['STX', 'zeropage,y', 0x96, 2], ['STX', 'absolute', 0x8e, 3],
  ['STY', 'zeropage', 0x84, 2], ['STY', 'zeropage,x', 0x94, 2], ['STY', 'absolute', 0x8c, 3],
  ['TAX', 'implied', 0xaa, 1], ['TAY', 'implied', 0xa8, 1], ['TSX', 'implied', 0xba, 1],
  ['TXA', 'implied', 0x8a, 1], ['TXS', 'implied', 0x9a, 1], ['TYA', 'implied', 0x98, 1],
];

test('every published NMOS 6502 opcode encodes to its documented byte and length', () => {
  assert.equal(PUBLISHED.length, 151, 'the well-known total: 56 mnemonics, 151 legal opcodes');
  for (const [mnemonic, mode, opcode, bytes] of PUBLISHED) {
    const result = encode(mnemonic, mode);
    assert.equal(result.ok, true, `${mnemonic} ${mode}`);
    if (result.ok) {
      assert.equal(result.opcode, opcode, `${mnemonic} ${mode} opcode`);
      assert.equal(result.bytes, bytes, `${mnemonic} ${mode} length`);
    }
  }
});

test('OPCODES has exactly 151 entries across exactly 56 mnemonics — nothing extra, nothing missing', () => {
  const mnemonics = Object.keys(OPCODES);
  assert.equal(mnemonics.length, 56);
  const total = mnemonics.reduce((sum, m) => sum + Object.keys(OPCODES[m]).length, 0);
  assert.equal(total, 151);
});

test('encode: an unknown mnemonic is an error naming it', () => {
  const result = encode('STZ', 'zeropage');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /unknown mnemonic 'STZ'/);
});

test('encode: a mode a real mnemonic does not take is an error listing what it does take', () => {
  const result = encode('STA', 'immediate'); // no STA #imm on real 6502 hardware
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /STA does not take immediate/);
  assert.match(result.ok ? '' : result.error, /zeropage/);
});

test('operandBytes and instructionBytes agree: implied/accumulator carry none, absolute-family carries two, everything else carries one', () => {
  assert.equal(operandBytes('implied'), 0);
  assert.equal(operandBytes('accumulator'), 0);
  assert.equal(operandBytes('immediate'), 1);
  assert.equal(operandBytes('relative'), 1);
  assert.equal(operandBytes('zeropage,x'), 1);
  assert.equal(operandBytes('(indirect,x)'), 1);
  assert.equal(operandBytes('(indirect),y'), 1);
  assert.equal(operandBytes('absolute'), 2);
  assert.equal(operandBytes('absolute,x'), 2);
  assert.equal(operandBytes('absolute,y'), 2);
  assert.equal(operandBytes('indirect'), 2);
  for (const mode of Object.keys(OPCODES.LDA) as AddressingMode[]) {
    assert.equal(instructionBytes(mode), 1 + operandBytes(mode));
  }
});
