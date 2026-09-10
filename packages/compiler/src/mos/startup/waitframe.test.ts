import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WAIT_FRAME_LABEL, WAIT_FRAME_ZP_BYTES, usesWaitFrame, waitFrameRoutine, waitFrameSetup } from './waitframe.ts';
import type { IrFunction } from '../lower/index.ts';
import { assemble } from '../asm/assemble.ts';
import type { Directive } from '../asm/assemble.ts';

const ACC = 0x8e;
const NUM = 0x92;
const TMP = 0x96;

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
  const program = waitFrameSetup(60, ACC, NUM, TMP);
  assert.deepEqual(program[0], { kind: 'instruction', mnemonic: 'SEI', mode: 'implied' });
});

test('waitFrameSetup ends by zeroing all four accumulator bytes — no logical-frame credit owed before the program runs', () => {
  const program = waitFrameSetup(60, ACC, NUM, TMP);
  const last5 = program.slice(-5);
  assert.deepEqual(last5[0], { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: 0 } });
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(last5[1 + i], { kind: 'instruction', mnemonic: 'STA', mode: 'zeropage', operand: { kind: 'value', value: ACC + i } });
  }
});

test('waitFrameSetup never touches WF_ACC or WF_TMP before the multiply — the elapsed measurement lands in WF_TMP untouched by any earlier zeroing of WF_ACC', () => {
  // Regression guard for a specific ordering bug: if setup ever zeroed
  // WF_ACC before computing `num`, that would be harmless today (they're
  // different cells) but the assertion below is really about there being
  // no accidental STA to ACC anywhere before the final 4-byte zeroing block
  // at the very end — i.e. exactly 4 stores to the ACC range in the whole
  // program, not more.
  const program = waitFrameSetup(60, ACC, NUM, TMP);
  const storesToAcc = program.filter(
    (d) => d.kind === 'instruction' && d.mnemonic === 'STA' && d.operand?.kind === 'value' && d.operand.value >= ACC && d.operand.value < ACC + 4,
  );
  assert.equal(storesToAcc.length, 4);
});

test('waitFrameSetup assembles as real, self-contained 6502 — every one of its own internal poll labels resolves, nothing references outside itself', () => {
  const result = assemble(waitFrameSetup(60, ACC, NUM, TMP), 0x1000);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

test('waitFrameSetup(1, ...) — frameRate a power of two minus none, exactly one bit set — emits exactly one 32-bit add and no doubling', () => {
  const program = waitFrameSetup(1, ACC, NUM, TMP);
  const adcCount = program.filter((d) => d.kind === 'instruction' && d.mnemonic === 'ADC').length;
  const aslCount = program.filter((d) => d.kind === 'instruction' && d.mnemonic === 'ASL').length;
  assert.equal(adcCount, 4, 'one 32-bit add is four ADCs, one per byte');
  assert.equal(aslCount, 0, 'a single bit needs no doubling at all');
});

test('waitFrameSetup(3, ...) — two bits set (0b11) — emits two 32-bit adds and exactly one doubling between them', () => {
  const program = waitFrameSetup(3, ACC, NUM, TMP);
  const adcCount = program.filter((d) => d.kind === 'instruction' && d.mnemonic === 'ADC').length;
  const aslCount = program.filter((d) => d.kind === 'instruction' && d.mnemonic === 'ASL').length;
  assert.equal(adcCount, 8, 'two 32-bit adds is eight ADCs');
  assert.equal(aslCount, 1, 'one doubling between the two set bits, none after the last');
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

test('WAIT_FRAME_ZP_BYTES is 12 — a 4-byte accumulator, a 4-byte measured num, and setup\'s own 4-byte scratch cell', () => {
  assert.equal(WAIT_FRAME_ZP_BYTES, 12);
});
