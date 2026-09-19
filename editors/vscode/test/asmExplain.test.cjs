// asmExplain.cjs — the plain-English comment "View Generated Assembly" puts
// beside each instruction. Pure: one instruction's text (+ address) and the
// debug map's symbols in, one short string out. The cases here pin the
// wording a reader actually sees, one per addressing mode and per symbol
// situation, and the rule that nothing is ever guessed: no symbol, no
// name; no recognized instruction, no comment.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { describe, indexSymbols, parseOperand, TYPE_BYTES } = require('../src/asmExplain.cjs');

const SYMBOLS = [
  { name: 'moved', kind: 'global', address: 0x0f, type: 'bool' },
  { name: 'score', kind: 'global', address: 0x18, type: 'usmallint' },
  { name: 'total', kind: 'global', address: 0x1a, type: 'int' },
  { name: 'tiles', kind: 'global', address: 0x0e96, type: null },
  { name: 'pia1PortA', kind: 'global', address: 0xe810, type: 'utinyint' },
  { name: 'screen_blank', kind: 'function', address: 0x0668 },
];
const index = indexSymbols(SYMBOLS);
const explain = (assembly, address = 0x1000) => describe({ assembly, address }, index);

test('parseOperand: every spelling the assembler prints, and nothing else', () => {
  assert.deepEqual(parseOperand(undefined), { mode: 'implied' });
  assert.deepEqual(parseOperand('A'), { mode: 'accumulator' });
  assert.deepEqual(parseOperand('#$06'), { mode: 'immediate', value: 6 });
  assert.deepEqual(parseOperand('$18'), { mode: 'direct', value: 0x18, digits: 2 });
  assert.deepEqual(parseOperand('$0668'), { mode: 'direct', value: 0x668, digits: 4 });
  assert.deepEqual(parseOperand('$0EB6,Y'), { mode: 'indexed', value: 0xeb6, digits: 4, register: 'Y' });
  assert.deepEqual(parseOperand('($1234)'), { mode: 'indirect', value: 0x1234, digits: 4 });
  assert.deepEqual(parseOperand('($34,X)'), { mode: '(indirect,x)', value: 0x34, digits: 2 });
  assert.deepEqual(parseOperand('($34),Y'), { mode: '(indirect),y', value: 0x34, digits: 2 });
  assert.equal(parseOperand('label'), null);
  assert.equal(parseOperand('#$1234'), null, 'an immediate is one byte');
});

test('loads and stores read as assignments, small numbers in decimal, larger ones with their hex alongside', () => {
  assert.equal(explain('LDA #$06'), 'A = 6');
  assert.equal(explain('LDX #$3C'), 'X = 60 ($3C)');
  assert.equal(explain('LDY #$08'), 'Y = 8');
  assert.equal(explain('STA $E848'), 'mem[$E848] = A');
  assert.equal(explain('STX $26'), 'mem[$26] = X');
  assert.equal(explain('STY $0400'), 'mem[$0400] = Y');
});

test('a known global reads by name; a two-byte one says which half; a wider one says which byte', () => {
  assert.equal(explain('STA $0F'), 'moved = A');
  assert.equal(explain('LDA $18'), 'A = score (lo)');
  assert.equal(explain('LDA $19'), 'A = score (hi)');
  assert.equal(explain('INC $1A'), 'total (byte 0) += 1');
  assert.equal(explain('LDA $1D'), 'A = total (byte 3)');
  assert.equal(TYPE_BYTES.int, 4);
});

test('no near-miss naming: an address just past a one-byte global, or an unlisted one, stays a bare address', () => {
  assert.equal(explain('LDA $E813'), 'A = mem[$E813]', 'pia1PortA is $E810, one byte — $E813 is not it');
  assert.equal(explain('LDA $10'), 'A = mem[$10]', 'moved is $0F, one byte');
  assert.equal(explain('LDA $1E'), 'A = mem[$1E]', 'total ends at $1D');
});

test('indexed and indirect operands name the base when it is exactly a global, and spell out the index otherwise', () => {
  assert.equal(explain('LDA $0E96,Y'), 'A = tiles[Y]');
  assert.equal(explain('STA $0E97,Y'), 'mem[$0E97 + Y] = A', 'an untyped global is only its first byte');
  assert.equal(explain('STA $8000,X'), 'mem[$8000 + X] = A');
  assert.equal(explain('LDA ($34),Y'), 'A = mem[pointer at mem[$34] + Y]');
  assert.equal(explain('LDA ($34,X)'), 'A = mem[pointer at mem[$34] + X]');
});

test('arithmetic, compares, and bit operations say what happens to A and the flags', () => {
  assert.equal(explain('ADC #$01'), 'A = A + 1 + carry');
  assert.equal(explain('ADC $18'), 'A = A + score (lo) + carry');
  assert.equal(explain('SBC $2E'), 'A = A - mem[$2E] - borrow');
  assert.equal(explain('CMP #$10'), 'compare A with 16 ($10) (sets the flags for the next branch)');
  assert.equal(explain('CPX #$E8'), 'compare X with 232 ($E8) (sets the flags for the next branch)');
  assert.equal(explain('CPY $18'), 'compare Y with score (lo) (sets the flags for the next branch)');
  assert.equal(explain('AND #$80'), 'A = A & $80 (keep bit 7)');
  assert.equal(explain('AND #$0F'), 'A = A & $0F (keep the low nibble)');
  assert.equal(explain('AND #$F0'), 'A = A & $F0 (keep the high nibble)');
  assert.equal(explain('AND $2E'), 'A = A & mem[$2E]');
  assert.equal(explain('ORA #$01'), 'A = A | $01 (set bit 0)');
  assert.equal(explain('EOR #$FF'), 'A = A ^ $FF (invert every bit)');
  assert.equal(explain('EOR #$40'), 'A = A ^ $40 (flip bit 6)');
  assert.equal(explain('BIT $0F'), 'test moved against A (flags only; A unchanged)');
});

test('shifts and rotates say the direction, the ×2/÷2 meaning, and where the carry goes', () => {
  assert.equal(explain('LSR A'), 'A >>= 1 (÷2; bit 0 → carry)');
  assert.equal(explain('ASL $18'), 'score (lo) <<= 1 (×2; bit 7 → carry)');
  assert.equal(explain('ROL $19'), 'score (hi) = (score (hi) << 1) | carry (continues a multi-byte ×2)');
  assert.equal(explain('ROR $20'), 'mem[$20] = (mem[$20] >> 1) | (carry << 7) (continues a multi-byte ÷2)');
});

test('calls and jumps name the function they land in, or the address and direction', () => {
  assert.equal(explain('JSR $0668'), 'call screen_blank');
  assert.equal(explain('JSR $0B9E'), 'call the subroutine at $0B9E');
  assert.equal(explain('JMP $0668'), 'jump to screen_blank');
  assert.equal(explain('JMP $0554', 0x0600), 'jump back to $0554');
  assert.equal(explain('JMP $0700', 0x0600), 'jump ahead to $0700');
  assert.equal(explain('JMP ($FFFC)'), 'jump to the address stored at mem[$FFFC]');
  assert.equal(explain('RTS'), 'return to the caller');
});

test('branches say the condition in words and whether they loop back or skip ahead', () => {
  assert.equal(explain('BEQ $043C', 0x0441), 'if zero, loop back to $043C');
  assert.equal(explain('BNE $07D9', 0x07c0), 'if not zero, skip ahead to $07D9');
  assert.equal(explain('BCS $0629', 0x0600), 'if carry set (≥ after a compare), skip ahead to $0629');
  assert.equal(explain('BCC $049A', 0x047f), 'if carry clear (< after a compare), skip ahead to $049A');
  assert.equal(explain('BMI $0400', 0x0500), 'if negative (bit 7 set), loop back to $0400');
  assert.equal(explain('BPL $0600', 0x0500), 'if not negative (bit 7 clear), skip ahead to $0600');
  assert.equal(explain('BEQ $0668', 0x0600), 'if zero, go to screen_blank', 'a branch into a function names it');
  assert.equal(describe({ assembly: 'BEQ $0668' }, index), 'if zero, go to screen_blank');
  assert.equal(describe({ assembly: 'BNE $0700' }, index), 'if not zero, go to $0700', 'no address to compare against: no direction claimed');
});

test('flag, register-transfer, stack, and misc instructions each have a fixed reading', () => {
  assert.equal(explain('CLC'), 'carry = 0 (before an add)');
  assert.equal(explain('SEC'), 'carry = 1 (before a subtract)');
  assert.equal(explain('SEI'), 'disable interrupts');
  assert.equal(explain('CLD'), 'binary (not decimal) arithmetic mode');
  assert.equal(explain('TAX'), 'X = A');
  assert.equal(explain('TXA'), 'A = X');
  assert.equal(explain('INX'), 'X += 1');
  assert.equal(explain('DEY'), 'Y -= 1');
  assert.equal(explain('PHA'), 'push A onto the stack');
  assert.equal(explain('PLA'), 'A = pop from the stack');
  assert.equal(explain('NOP'), 'do nothing');
});

test('.byte runs are data, counted', () => {
  assert.equal(explain('.byte $00'), 'data: 1 byte');
  assert.equal(explain('.byte $04, $32, $30, $34, $38'), 'data: 5 bytes');
});

test('anything unrecognized gets no comment rather than a guess', () => {
  assert.equal(explain('XYZ #$01'), '');
  assert.equal(explain('LDA label'), '');
  assert.equal(explain('LDA'), '', 'LDA has no implied form');
  assert.equal(explain('BEQ #$01'), '');
  assert.equal(explain(''), '');
  assert.equal(describe({}, index), '');
});

test('indexSymbols tolerates a map with no symbols or malformed entries', () => {
  assert.equal(describe({ assembly: 'LDA $18' }, indexSymbols()), 'A = mem[$18]');
  assert.equal(describe({ assembly: 'JSR $0668' }, indexSymbols([null, { name: 'x' }, { kind: 'function', address: 1 }])), 'call the subroutine at $0668');
});
