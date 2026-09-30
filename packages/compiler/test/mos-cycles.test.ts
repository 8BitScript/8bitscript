// packages/compiler/src/mos/asm/cycles.ts — cross-checked against the same
// published reference encode.ts's own OPCODES table cites
// (masswerk.at/6502/6502_instruction_set.html). Coverage (every mnemonic
// and addressing mode OPCODES has, the eight branch mnemonics excepted) is
// checked here directly against OPCODES itself, so the two tables can never
// silently drift apart — a mode added to one without the other is a bug
// this test catches, not a manual audit someone has to remember to redo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OPCODES } from '../src/mos/asm/encode.ts';
import { CYCLES, BRANCH_MNEMONICS, branchCycles, instructionCycles } from '../src/mos/asm/cycles.ts';

// The HuC6280's own VDC-port stores — real opcodes in OPCODES, out of scope
// for cycles.ts until a PC Engine build needs them (see cycles.ts's header).
const NOT_YET_COVERED = new Set(['ST0', 'ST1', 'ST2']);

test('CYCLES covers exactly the same mnemonics and addressing modes as OPCODES, branches and the HuC6280 extras aside', () => {
  for (const [mnemonic, modes] of Object.entries(OPCODES)) {
    if (BRANCH_MNEMONICS.has(mnemonic) || NOT_YET_COVERED.has(mnemonic)) continue;
    const covered = CYCLES[mnemonic];
    assert.ok(covered, `${mnemonic} has no entry in CYCLES`);
    assert.deepEqual(
      Object.keys(covered).sort(),
      Object.keys(modes).sort(),
      `${mnemonic}: CYCLES and OPCODES disagree on which addressing modes it takes`,
    );
  }
  for (const mnemonic of Object.keys(CYCLES)) {
    assert.ok(OPCODES[mnemonic], `CYCLES has ${mnemonic}, which OPCODES does not — a mnemonic that doesn't exist`);
  }
});

test('every eight branch mnemonics is absent from CYCLES — use branchCycles(), not a table lookup', () => {
  for (const mnemonic of BRANCH_MNEMONICS) {
    assert.equal(CYCLES[mnemonic], undefined, mnemonic);
  }
  assert.deepEqual([...BRANCH_MNEMONICS].sort(), ['BCC', 'BCS', 'BEQ', 'BMI', 'BNE', 'BPL', 'BVC', 'BVS']);
});

test('branchCycles: 2 untaken, 3 taken same page, 4 taken across a page', () => {
  assert.equal(branchCycles(false, false), 2);
  assert.equal(branchCycles(false, true), 2, 'an untaken branch never pays the page-crossing cycle');
  assert.equal(branchCycles(true, false), 3);
  assert.equal(branchCycles(true, true), 4);
});

test('instructionCycles: known instructions match the published reference exactly', () => {
  // A spot check across every shape the table has to get right, not just
  // one mnemonic — immediate/zeropage/absolute (LDA), a store whose
  // indexed-absolute forms are already the higher, always-paid count
  // (STA), a read-modify-write (ASL, whose zeropage form costs two more
  // than a plain read at the same address), and the two-operand-byte
  // implied instructions (PHA/PLA, RTS/RTI/JSR/BRK).
  assert.equal(instructionCycles('LDA', 'immediate'), 2);
  assert.equal(instructionCycles('LDA', 'zeropage'), 3);
  assert.equal(instructionCycles('LDA', 'absolute'), 4);
  assert.equal(instructionCycles('STA', 'absolute,x'), 5, 'a store always pays the dummy-read cycle');
  assert.equal(instructionCycles('STA', 'absolute,y'), 5);
  assert.equal(instructionCycles('ASL', 'zeropage'), 5);
  assert.equal(instructionCycles('ASL', 'accumulator'), 2);
  assert.equal(instructionCycles('PHA', 'implied'), 3);
  assert.equal(instructionCycles('PLA', 'implied'), 4);
  assert.equal(instructionCycles('RTS', 'implied'), 6);
  assert.equal(instructionCycles('RTI', 'implied'), 6);
  assert.equal(instructionCycles('JSR', 'absolute'), 6);
  assert.equal(instructionCycles('BRK', 'implied'), 7);
  assert.equal(instructionCycles('JMP', 'absolute'), 3);
  assert.equal(instructionCycles('JMP', 'indirect'), 5, 'the page-wrap bug is a correctness quirk, not a cycle-count one');
});

test('instructionCycles: page-crossing only adds a cycle to a READ at an indexed/indirect-indexed mode, never a write or an RMW', () => {
  assert.equal(instructionCycles('LDA', 'absolute,x', false), 4);
  assert.equal(instructionCycles('LDA', 'absolute,x', true), 5, 'a page-crossing read pays one more');
  assert.equal(instructionCycles('LDA', '(indirect),y', false), 5);
  assert.equal(instructionCycles('LDA', '(indirect),y', true), 6);
  assert.equal(instructionCycles('LDX', 'absolute,y', true), 5);

  // A store's absolute,x/absolute,y is already the higher, flat count —
  // passing crossesPage=true must not add a second cycle on top of it.
  assert.equal(instructionCycles('STA', 'absolute,x', false), 5);
  assert.equal(instructionCycles('STA', 'absolute,x', true), 5, 'a store already pays this cycle unconditionally');

  // A read-modify-write is likewise already the flat, higher count.
  assert.equal(instructionCycles('ASL', 'absolute,x', false), 7);
  assert.equal(instructionCycles('ASL', 'absolute,x', true), 7);

  // A mode this project doesn't mark pageCrossable at all (zeropage) is
  // unaffected by the flag regardless of what's passed.
  assert.equal(instructionCycles('LDA', 'zeropage', true), 3);
});

test('instructionCycles refuses a branch mnemonic, an unknown mnemonic, and a mnemonic/mode pair that does not exist', () => {
  assert.throws(() => instructionCycles('BEQ', 'relative'), /branch.*branchCycles/);
  assert.throws(() => instructionCycles('XYZ', 'implied'), /unknown mnemonic 'XYZ'/);
  assert.throws(() => instructionCycles('LDA', 'implied'), /LDA does not take implied addressing/);
});
