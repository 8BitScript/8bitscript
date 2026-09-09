import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assembleRelaxed } from './relax.ts';
import type { Directive } from './assemble.ts';

const nop = (): Directive => ({ kind: 'instruction', mnemonic: 'NOP', mode: 'implied' });
const filler = (n: number): Directive[] => Array.from({ length: n }, nop);

test('a branch already in range assembles unchanged, byte for byte the same as assemble() alone', () => {
  const program: Directive[] = [
    { kind: 'instruction', mnemonic: 'BEQ', mode: 'relative', operand: { kind: 'label', name: 'done' } },
    ...filler(10),
    { kind: 'label', name: 'done' },
  ];
  const result = assembleRelaxed(program, 0x1000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bytes.length, 12); // BEQ (2) + 10 NOPs
  assert.equal(result.bytes[0], 0xf0); // BEQ opcode, unrewritten
});

test('a branch past +127 is rewritten as an inverted branch over a JMP to the same label', () => {
  const program: Directive[] = [
    { kind: 'instruction', mnemonic: 'BEQ', mode: 'relative', operand: { kind: 'label', name: 'done' } },
    ...filler(200),
    { kind: 'label', name: 'done' },
    { kind: 'instruction', mnemonic: 'RTS', mode: 'implied' },
  ];
  const result = assembleRelaxed(program, 0x1000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // BNE +3 (skip the JMP); JMP done; 200 NOPs; RTS
  assert.equal(result.bytes[0], 0xd0); // BNE, the inverse of BEQ
  assert.equal(result.bytes[1], 0x03); // skip exactly the 3-byte JMP
  assert.equal(result.bytes[2], 0x4c); // JMP absolute
  assert.equal(result.bytes.length, 2 + 3 + 200 + 1);
  assert.equal(result.labels.get('done'), 0x1000 + 5 + 200);
});

test('a branch past -128 the other direction is relaxed too', () => {
  const program: Directive[] = [
    { kind: 'label', name: 'top' },
    ...filler(200),
    { kind: 'instruction', mnemonic: 'BCS', mode: 'relative', operand: { kind: 'label', name: 'top' } },
  ];
  const result = assembleRelaxed(program, 0x1000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bytes[200], 0x90); // BCC, the inverse of BCS
  assert.equal(result.bytes.length, 200 + 5);
});

test('one relaxation growing the program by 3 bytes can push a second, earlier-safe branch out of range too — both get fixed', () => {
  // Two branches to the same far label, back to back: the first relaxation
  // alone would still leave the second one (now 3 bytes further away) out
  // of range if this only fixed one branch and stopped.
  const program: Directive[] = [
    { kind: 'instruction', mnemonic: 'BEQ', mode: 'relative', operand: { kind: 'label', name: 'done' } },
    { kind: 'instruction', mnemonic: 'BNE', mode: 'relative', operand: { kind: 'label', name: 'done' } },
    ...filler(250),
    { kind: 'label', name: 'done' },
  ];
  const result = assembleRelaxed(program, 0x1000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bytes[0], 0xd0); // BNE, inverse of the first BEQ
  assert.equal(result.bytes[5], 0xf0); // BEQ, inverse of the second, originally-BNE branch — at 5, past the first relaxed BNE+JMP pair
  assert.equal(result.bytes.length, 5 + 5 + 250);
});

test('an error that is not an out-of-range branch passes through unchanged', () => {
  const program: Directive[] = [{ kind: 'instruction', mnemonic: 'BEQ', mode: 'relative', operand: { kind: 'label', name: 'nowhere' } }];
  const result = assembleRelaxed(program, 0x1000);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /undefined label 'nowhere'/);
});
