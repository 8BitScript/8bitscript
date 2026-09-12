import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assemble } from './assemble.ts';
import type { Directive, Operand } from './assemble.ts';
import type { AddressingMode } from './encode.ts';

const inst = (mnemonic: string, mode: AddressingMode, operand?: Operand): Directive =>
  ({ kind: 'instruction', mnemonic, mode, operand });
const label = (name: string): Directive => ({ kind: 'label', name });
const byte = (...values: number[]): Directive => ({ kind: 'byte', values });
const value = (n: number): Operand => ({ kind: 'value', value: n });
const ref = (name: string): Operand => ({ kind: 'label', name });

test('a program with no labels assembles to exactly its instructions, in order', () => {
  const result = assemble([
    inst('LDA', 'immediate', value(0x08)),
    inst('STA', 'absolute', value(0x8000)),
    inst('RTS', 'implied'),
  ], 0x0400);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual([...result.bytes], [0xa9, 0x08, 0x8d, 0x00, 0x80, 0x60]);
  assert.equal(result.listing.length, 3);
  assert.equal(result.listing[0].text, 'LDA #$08');
  assert.equal(result.listing[1].text, 'STA $8000');
});

test('a forward label reference resolves once the whole program has been walked', () => {
  const result = assemble([
    inst('JMP', 'absolute', ref('start')),
    byte(0xff), // one byte the jump skips over
    label('start'),
    inst('RTS', 'implied'),
  ], 0x0400);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // JMP $0404: the byte at $0403 is skipped, RTS lands at $0404.
  assert.deepEqual([...result.bytes], [0x4c, 0x04, 0x04, 0xff, 0x60]);
});

test('a backward label reference resolves the same way', () => {
  const result = assemble([
    label('loop'),
    inst('DEX', 'implied'),
    inst('BNE', 'relative', ref('loop')),
  ], 0x0400);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // BNE at $0401, next instruction at $0403, loop at $0400: delta -3.
  assert.deepEqual([...result.bytes], [0xca, 0xd0, (-3) & 0xff]);
});

test('.byte emits raw bytes and advances the address for labels after it', () => {
  const result = assemble([
    byte(0x01, 0x02, 0x03),
    label('after'),
    inst('LDA', 'absolute', ref('after')),
  ], 0x0400);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual([...result.bytes], [0x01, 0x02, 0x03, 0xad, 0x03, 0x04]);
});

test('a branch exactly +127 bytes away assembles; +128 is refused as out of range', () => {
  const filler = (n: number): Directive[] => Array.from({ length: n }, () => inst('NOP', 'implied'));

  const ok = assemble([
    inst('BEQ', 'relative', ref('target')),
    ...filler(127),
    label('target'),
  ], 0x0400);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.bytes[1], 0x7f, 'delta +127, as an unsigned byte: 0x7F');

  const tooFar = assemble([
    inst('BEQ', 'relative', ref('target')),
    ...filler(128),
    label('target'),
  ], 0x0400);
  assert.equal(tooFar.ok, false);
  assert.match(tooFar.ok ? '' : tooFar.error, /128 bytes away, out of range/);
});

test('a duplicate label is refused, naming it', () => {
  const result = assemble([label('here'), label('here')], 0x0400);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /'here' is defined more than once/);
});

test('an undefined label is refused, naming it and the instruction that used it', () => {
  const result = assemble([inst('JMP', 'absolute', ref('nowhere'))], 0x0400);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /JMP at \$0400: undefined label 'nowhere'/);
});

test('an unknown mnemonic or an unsupported mode fails the same way encode() would, with the address folded in', () => {
  const result = assemble([inst('STA', 'immediate', value(1))], 0x0400);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /STA at \$0400: STA does not take immediate/);
});

test('an operand that overflows its addressing mode\'s byte width is refused', () => {
  const zp = assemble([inst('LDA', 'zeropage', value(0x100))], 0x0400);
  assert.equal(zp.ok, false);
  assert.match(zp.ok ? '' : zp.error, /does not fit in zeropage's one byte/);

  const abs = assemble([inst('LDA', 'absolute', value(0x10000))], 0x0400);
  assert.equal(abs.ok, false);
  assert.match(abs.ok ? '' : abs.error, /does not fit in absolute's two bytes/);
});

test('a .byte value outside 0..255 is refused, naming the address', () => {
  const result = assemble([byte(256)], 0x0400);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /\.byte 256 at \$0400 does not fit in one byte/);
});

test('a label operand with a byte selector resolves to its address\'s low or high half', () => {
  const result = assemble([
    inst('LDA', 'immediate', { kind: 'label', name: 'data', byte: 'lo' }),
    inst('LDA', 'immediate', { kind: 'label', name: 'data', byte: 'hi' }),
    byte(0xff), // pushes 'data' to $0405, so its low/high halves are both interesting
    label('data'),
  ], 0x0400);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual([...result.bytes], [0xa9, 0x05, 0xa9, 0x04, 0xff]);
});

test('accumulator mode disassembles as "A"; implied as the bare mnemonic', () => {
  const result = assemble([inst('ASL', 'accumulator'), inst('RTS', 'implied')], 0x0400);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.listing[0].text, 'ASL A');
  assert.equal(result.listing[1].text, 'RTS');
});

test('an equate binds a name to an address the program does not contain, and occupies no space', () => {
  // What an `@address` array needs: the C64's screen is at $0400 whether or
  // not a single byte of the program lives there, so the name has to resolve
  // without a position to resolve from. Placed BEFORE the code here on
  // purpose — an equate that shifted what follows it would be a bug the
  // byte count catches.
  const result = assemble([
    { kind: 'equate', name: 'screen', value: 0x0400 },
    inst('LDA', 'immediate', { kind: 'value', value: 32 }),
    inst('STA', 'absolute,x', { kind: 'label', name: 'screen' }),
  ], 0xc000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual([...result.bytes], [0xa9, 0x20, 0x9d, 0x00, 0x04], 'STA $0400,X — the pinned address, not a position in the program');
  assert.equal(result.labels.get('screen'), 0x0400);
});

test('an equate collides with a label of the same name, and says so', () => {
  const result = assemble([
    { kind: 'equate', name: 'screen', value: 0x0400 },
    label('screen'),
  ], 0xc000);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /'screen' is defined more than once/);
});

test('an equate outside the 16-bit address space is refused, not truncated', () => {
  const result = assemble([{ kind: 'equate', name: 'nowhere', value: 0x10000 }], 0xc000);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /is not an address/);
});
