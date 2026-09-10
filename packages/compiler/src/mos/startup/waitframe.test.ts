import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WAIT_FRAME_LABEL, WAIT_FRAME_ZP_BYTES, usesWaitFrame, waitFrameRoutine, waitFrameSetup } from './waitframe.ts';
import type { IrFunction } from '../lower/index.ts';
import { assemble } from '../asm/assemble.ts';
import type { Directive } from '../asm/assemble.ts';

const ACC = 0x8e;
const NUM = 0x92;

function fn(name: string, body: unknown[]): IrFunction {
  return { name, body: body as IrFunction['body'] };
}

// ---- usesWaitFrame ---------------------------------------------------

test('usesWaitFrame: false for a program with no waitFrame() call anywhere', () => {
  assert.equal(usesWaitFrame([fn('main', [{ kind: 'memoryWrite' }])]), false);
});

test('usesWaitFrame: true when the entry function calls it directly', () => {
  assert.equal(usesWaitFrame([fn('main', [{ kind: 'waitFrame' }])]), true);
});

test('usesWaitFrame: true when it is nested inside a for loop\'s body, not just top-level', () => {
  const program = [fn('main', [{ kind: 'for', body: [{ kind: 'if', then: [{ kind: 'waitFrame' }], else: null }] }])];
  assert.equal(usesWaitFrame(program), true);
});

test('usesWaitFrame: true when a function OTHER than the entry calls it — every function reachable from the program counts, not just main', () => {
  const program = [fn('main', [{ kind: 'call', name: 'tick' }]), fn('tick', [{ kind: 'waitFrame' }])];
  assert.equal(usesWaitFrame(program), true);
});

test('usesWaitFrame: an empty function list uses nothing', () => {
  assert.equal(usesWaitFrame([]), false);
});

// ---- waitFrameSetup ----------------------------------------------------

test('waitFrameSetup starts with SEI — presync owns the CB1 flag before the KERNAL\'s jiffy-clock IRQ can', () => {
  const program = waitFrameSetup(60, ACC, NUM);
  assert.deepEqual(program[0], { kind: 'instruction', mnemonic: 'SEI', mode: 'implied' });
});

test('waitFrameSetup ends by zeroing all four accumulator bytes — no logical-frame credit owed before the program runs', () => {
  const program = waitFrameSetup(60, ACC, NUM);
  const last5 = program.slice(-5);
  assert.deepEqual(last5[0], { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: 0 } });
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(last5[1 + i], { kind: 'instruction', mnemonic: 'STA', mode: 'zeropage', operand: { kind: 'value', value: ACC + i } });
  }
});

test('waitFrameSetup measures elapsed into ACC, then zeros ACC at the end so the running program never sees the sample', () => {
  const program = waitFrameSetup(60, ACC, NUM);
  const last5 = program.slice(-5);
  assert.deepEqual(last5[0], { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: 0 } });
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(last5[1 + i], { kind: 'instruction', mnemonic: 'STA', mode: 'zeropage', operand: { kind: 'value', value: ACC + i } });
  }
  const storesToAcc = program.filter(
    (d) => d.kind === 'instruction' && d.mnemonic === 'STA' && d.operand?.kind === 'value' && d.operand.value === ACC,
  );
  assert.ok(storesToAcc.length >= 2, 'elapsed low byte and the final zero both STA ACC');
});

test('waitFrameSetup assembles as real, self-contained 6502 — every one of its own internal poll labels resolves, nothing references outside itself', () => {
  const result = assemble(waitFrameSetup(60, ACC, NUM), 0x1000);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

test('waitFrameSetup(60, ...) uses an 8-bit Russian-peasant loop — one add32 and one shift in the body, Y as the bit counter, no extra zp', () => {
  const program = waitFrameSetup(60, ACC, NUM);
  const adcCount = program.filter((d) => d.kind === 'instruction' && d.mnemonic === 'ADC').length;
  const aslCount = program.filter((d) => d.kind === 'instruction' && d.mnemonic === 'ASL').length;
  assert.equal(adcCount, 4, 'the loop body contains one 32-bit add, not one per set bit of 60');
  assert.equal(aslCount, 1, 'one 32-bit shift in the loop body');
  assert.ok(program.some((d) => d.kind === 'instruction' && d.mnemonic === 'LDY' && d.operand?.kind === 'value' && d.operand.value === 8));
  assert.ok(program.some((d) => d.kind === 'instruction' && d.mnemonic === 'LSR' && d.mode === 'accumulator'));
});

test('waitFrameSetup(300, ...) — a rate that does not fit in a byte — still unrolls rather than truncating', () => {
  const program = waitFrameSetup(300, ACC, NUM);
  const adcCount = program.filter((d) => d.kind === 'instruction' && d.mnemonic === 'ADC').length;
  // 300 = 0b100101100, four bits set → four 32-bit adds
  assert.equal(adcCount, 16);
  assert.equal(program.some((d) => d.kind === 'instruction' && d.mnemonic === 'LDY'), false);
});

// ---- waitFrameRoutine ----------------------------------------------------

test('waitFrameRoutine opens on WAIT_FRAME_LABEL — the JSR target every call site lowers to', () => {
  const program = waitFrameRoutine(ACC, NUM);
  assert.deepEqual(program[0], { kind: 'label', name: WAIT_FRAME_LABEL });
});

test('waitFrameRoutine compares against exactly 1,000,000 (0x000F4240) — the PET\'s own fixed, documented 1MHz clock, never a stored `den`', () => {
  const program = waitFrameRoutine(ACC, NUM);
  const immediateCompares = (program.filter((d) => d.kind === 'instruction' && d.mnemonic === 'CMP') as Extract<Directive, { kind: 'instruction' }>[])
    .map((d) => (d.operand?.kind === 'value' ? d.operand.value : -1));
  // Most-significant byte first: 0x00, 0x0F, 0x42, then the low byte 0x40
  // appears twice — once in the compare chain, once in the subtract below.
  assert.deepEqual(immediateCompares, [0x00, 0x0f, 0x42, 0x40]);
});

test('waitFrameRoutine subtracts the same four bytes it compared against, low byte first, ending in RTS', () => {
  const program = waitFrameRoutine(ACC, NUM);
  const sbcBytes = (program.filter((d) => d.kind === 'instruction' && d.mnemonic === 'SBC') as Extract<Directive, { kind: 'instruction' }>[])
    .map((d) => (d.operand?.kind === 'value' ? d.operand.value : -1));
  assert.deepEqual(sbcBytes, [0x40, 0x42, 0x0f, 0x00]);
  const rtsIndex = program.findIndex((d) => d.kind === 'instruction' && d.mnemonic === 'RTS');
  assert.notEqual(rtsIndex, -1);
  assert.deepEqual(program[rtsIndex - 1], { kind: 'instruction', mnemonic: 'STA', mode: 'zeropage', operand: { kind: 'value', value: ACC + 3 } });
});

test('waitFrameRoutine polls $E813 bit 7 and acknowledges by reading $E812 — the exact PIA1 contract packages/pet/src/index.8bs documents', () => {
  const program = waitFrameRoutine(ACC, NUM);
  const pollLda = program.find(
    (d) => d.kind === 'instruction' && d.mnemonic === 'LDA' && d.mode === 'absolute' && d.operand?.kind === 'value' && d.operand.value === 0xe813,
  );
  assert.ok(pollLda, 'polls $E813');
  const ackLda = program.find(
    (d) => d.kind === 'instruction' && d.mnemonic === 'LDA' && d.mode === 'absolute' && d.operand?.kind === 'value' && d.operand.value === 0xe812,
  );
  assert.ok(ackLda, 'acknowledges by reading $E812');
});

test('waitFrameRoutine assembles as real, self-contained 6502 — every branch and the trailing JMP resolve to its own internal labels', () => {
  const result = assemble(waitFrameRoutine(ACC, NUM), 0x1000);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

test('WAIT_FRAME_ZP_BYTES is 8 — a 4-byte accumulator and a 4-byte measured num; setup scratch reuses the accumulator', () => {
  assert.equal(WAIT_FRAME_ZP_BYTES, 8);
});
