// Cycle counts for the stock NMOS 6502's encoding table — mnemonic +
// addressing mode → base cycles, cross-checked against the same published
// reference encode.ts's own OPCODES table already cites
// (masswerk.at/6502/6502_instruction_set.html), for the same reason: a
// wrong number here is a silent, hard-to-catch bug in anything built on top
// of it (a cost-driven unroll decision, a compile-time budget diagnostic).
//
// A base count is only ever "cycles for this addressing mode assuming
// nothing extra happens." Two real 6502 behaviors add to it, and neither is
// baked into the base number because neither is knowable from the mnemonic
// and mode alone — both need the actual computed address, known only once
// labels resolve and operands are real numbers:
//
//   - A handful of READ instructions in an indexed or indirect-indexed mode
//     (absolute,X / absolute,Y / (indirect),Y) cost one cycle more when the
//     effective address crosses a page boundary — the 6502 always computes
//     the address low-byte-first and only re-reads high if it carried.
//     `pageCrossable` marks exactly these entries. A STORE at the same
//     addressing modes, or a read-modify-write instruction (ASL/LSR/ROL/
//     ROR/INC/DEC), never gets this treatment: the CPU cannot know in
//     advance whether the page will cross, so it always pays the extra
//     cycle for the dummy read — which is why STA absolute,X is a flat 5,
//     never 4-or-5, and this table lists it that way already.
//   - A branch's cost depends on whether it's taken at all, and if so
//     whether the target is on the same page — see branchCycles() below,
//     never this table (a branch mnemonic has no entry here on purpose).
//
// Deliberately absent, same rule encode.ts's own header states: the 65C02's
// extra opcodes and cycle differences, and the NMOS chip's undocumented
// opcodes. Both are `CpuVariant` concerns for whichever machine's backend
// needs them first (not the PET, VIC-20, or C64 — all plain NMOS 6502
// family; the CX16's 65C02 is the one release target this will eventually
// matter for). Also absent: `ST0`/`ST1`/`ST2`, the HuC6280's own VDC-port
// store instructions that encode.ts's OPCODES table already carries — no
// release target (`docs/roadmap.md`'s pet/vic20/c64/cx16/web) is a PC
// Engine, so there is nothing yet to verify a cycle count against.
//
// JMP (indirect)'s famous page-wrap bug — `JMP ($xxFF)` fetches its high
// byte from `$xx00` instead of `$(xx+1)00` — is a CORRECTNESS quirk, not a
// cycle-count one: the instruction is a flat 5 cycles regardless of where
// the indirect pointer lands. Nothing here models the bug itself; a
// program that cares is `mos/lower`'s problem, not this table's.
import type { AddressingMode } from './encode.ts';

interface CycleEntry {
  /** Cycles when nothing extra happens — see the file header for what "extra" covers. */
  cycles: number;
  /** True only for a read that pays one more cycle when its effective address crosses a page boundary. Never set for a store or a read-modify-write: those already list their always-paid higher count as `cycles` itself. */
  pageCrossable?: true;
}

/** mnemonic → the cycle cost for each addressing mode it supports — the same shape and coverage as encode.ts's OPCODES, minus the eight branch mnemonics (see branchCycles). */
export const CYCLES: Readonly<Record<string, Readonly<Partial<Record<AddressingMode, CycleEntry>>>>> = {
  ADC: {
    immediate: { cycles: 2 }, zeropage: { cycles: 3 }, 'zeropage,x': { cycles: 4 }, absolute: { cycles: 4 },
    'absolute,x': { cycles: 4, pageCrossable: true }, 'absolute,y': { cycles: 4, pageCrossable: true },
    '(indirect,x)': { cycles: 6 }, '(indirect),y': { cycles: 5, pageCrossable: true },
  },
  AND: {
    immediate: { cycles: 2 }, zeropage: { cycles: 3 }, 'zeropage,x': { cycles: 4 }, absolute: { cycles: 4 },
    'absolute,x': { cycles: 4, pageCrossable: true }, 'absolute,y': { cycles: 4, pageCrossable: true },
    '(indirect,x)': { cycles: 6 }, '(indirect),y': { cycles: 5, pageCrossable: true },
  },
  ASL: {
    accumulator: { cycles: 2 }, zeropage: { cycles: 5 }, 'zeropage,x': { cycles: 6 }, absolute: { cycles: 6 }, 'absolute,x': { cycles: 7 },
  },
  BIT: { zeropage: { cycles: 3 }, absolute: { cycles: 4 } },
  BRK: { implied: { cycles: 7 } },
  CLC: { implied: { cycles: 2 } },
  CLD: { implied: { cycles: 2 } },
  CLI: { implied: { cycles: 2 } },
  CLV: { implied: { cycles: 2 } },
  CMP: {
    immediate: { cycles: 2 }, zeropage: { cycles: 3 }, 'zeropage,x': { cycles: 4 }, absolute: { cycles: 4 },
    'absolute,x': { cycles: 4, pageCrossable: true }, 'absolute,y': { cycles: 4, pageCrossable: true },
    '(indirect,x)': { cycles: 6 }, '(indirect),y': { cycles: 5, pageCrossable: true },
  },
  CPX: { immediate: { cycles: 2 }, zeropage: { cycles: 3 }, absolute: { cycles: 4 } },
  CPY: { immediate: { cycles: 2 }, zeropage: { cycles: 3 }, absolute: { cycles: 4 } },
  DEC: { zeropage: { cycles: 5 }, 'zeropage,x': { cycles: 6 }, absolute: { cycles: 6 }, 'absolute,x': { cycles: 7 } },
  DEX: { implied: { cycles: 2 } },
  DEY: { implied: { cycles: 2 } },
  EOR: {
    immediate: { cycles: 2 }, zeropage: { cycles: 3 }, 'zeropage,x': { cycles: 4 }, absolute: { cycles: 4 },
    'absolute,x': { cycles: 4, pageCrossable: true }, 'absolute,y': { cycles: 4, pageCrossable: true },
    '(indirect,x)': { cycles: 6 }, '(indirect),y': { cycles: 5, pageCrossable: true },
  },
  INC: { zeropage: { cycles: 5 }, 'zeropage,x': { cycles: 6 }, absolute: { cycles: 6 }, 'absolute,x': { cycles: 7 } },
  INX: { implied: { cycles: 2 } },
  INY: { implied: { cycles: 2 } },
  // JMP (indirect): a flat 5 regardless of the page-wrap bug — see the file header.
  JMP: { absolute: { cycles: 3 }, indirect: { cycles: 5 } },
  JSR: { absolute: { cycles: 6 } },
  LDA: {
    immediate: { cycles: 2 }, zeropage: { cycles: 3 }, 'zeropage,x': { cycles: 4 }, absolute: { cycles: 4 },
    'absolute,x': { cycles: 4, pageCrossable: true }, 'absolute,y': { cycles: 4, pageCrossable: true },
    '(indirect,x)': { cycles: 6 }, '(indirect),y': { cycles: 5, pageCrossable: true },
  },
  LDX: {
    immediate: { cycles: 2 }, zeropage: { cycles: 3 }, 'zeropage,y': { cycles: 4 }, absolute: { cycles: 4 },
    'absolute,y': { cycles: 4, pageCrossable: true },
  },
  LDY: {
    immediate: { cycles: 2 }, zeropage: { cycles: 3 }, 'zeropage,x': { cycles: 4 }, absolute: { cycles: 4 },
    'absolute,x': { cycles: 4, pageCrossable: true },
  },
  LSR: {
    accumulator: { cycles: 2 }, zeropage: { cycles: 5 }, 'zeropage,x': { cycles: 6 }, absolute: { cycles: 6 }, 'absolute,x': { cycles: 7 },
  },
  NOP: { implied: { cycles: 2 } },
  ORA: {
    immediate: { cycles: 2 }, zeropage: { cycles: 3 }, 'zeropage,x': { cycles: 4 }, absolute: { cycles: 4 },
    'absolute,x': { cycles: 4, pageCrossable: true }, 'absolute,y': { cycles: 4, pageCrossable: true },
    '(indirect,x)': { cycles: 6 }, '(indirect),y': { cycles: 5, pageCrossable: true },
  },
  PHA: { implied: { cycles: 3 } },
  PHP: { implied: { cycles: 3 } },
  PLA: { implied: { cycles: 4 } },
  PLP: { implied: { cycles: 4 } },
  ROL: {
    accumulator: { cycles: 2 }, zeropage: { cycles: 5 }, 'zeropage,x': { cycles: 6 }, absolute: { cycles: 6 }, 'absolute,x': { cycles: 7 },
  },
  ROR: {
    accumulator: { cycles: 2 }, zeropage: { cycles: 5 }, 'zeropage,x': { cycles: 6 }, absolute: { cycles: 6 }, 'absolute,x': { cycles: 7 },
  },
  RTI: { implied: { cycles: 6 } },
  RTS: { implied: { cycles: 6 } },
  SBC: {
    immediate: { cycles: 2 }, zeropage: { cycles: 3 }, 'zeropage,x': { cycles: 4 }, absolute: { cycles: 4 },
    'absolute,x': { cycles: 4, pageCrossable: true }, 'absolute,y': { cycles: 4, pageCrossable: true },
    '(indirect,x)': { cycles: 6 }, '(indirect),y': { cycles: 5, pageCrossable: true },
  },
  SEC: { implied: { cycles: 2 } },
  SED: { implied: { cycles: 2 } },
  SEI: { implied: { cycles: 2 } },
  STA: {
    zeropage: { cycles: 3 }, 'zeropage,x': { cycles: 4 }, absolute: { cycles: 4 },
    'absolute,x': { cycles: 5 }, 'absolute,y': { cycles: 5 }, '(indirect,x)': { cycles: 6 }, '(indirect),y': { cycles: 6 },
  },
  STX: { zeropage: { cycles: 3 }, 'zeropage,y': { cycles: 4 }, absolute: { cycles: 4 } },
  STY: { zeropage: { cycles: 3 }, 'zeropage,x': { cycles: 4 }, absolute: { cycles: 4 } },
  TAX: { implied: { cycles: 2 } },
  TAY: { implied: { cycles: 2 } },
  TSX: { implied: { cycles: 2 } },
  TXA: { implied: { cycles: 2 } },
  TXS: { implied: { cycles: 2 } },
  TYA: { implied: { cycles: 2 } },
};

/** The eight relative-addressing branch mnemonics — never in CYCLES; see branchCycles(). */
export const BRANCH_MNEMONICS: ReadonlySet<string> = new Set(['BCC', 'BCS', 'BEQ', 'BMI', 'BNE', 'BPL', 'BVC', 'BVS']);

/**
 * A branch's real cost: 2 cycles untaken, 3 taken to the same page, 4 taken
 * across a page boundary — the one instruction class whose cycle count
 * depends on the *branch's own outcome*, not just its addressing mode
 * (which is always `relative`, always 2 operand bytes, for every one of
 * the eight).
 */
export function branchCycles(taken: boolean, crossesPage: boolean): number {
  if (!taken) return 2;
  return crossesPage ? 4 : 3;
}

/**
 * Total cycles for one non-branch instruction. `crossesPage` matters only
 * when the entry is `pageCrossable` (an indexed/indirect READ) — passed
 * for anything else, it is silently ignored, the same way a store's own
 * always-paid extra cycle is already folded into its listed `cycles`
 * rather than asking the caller to add it.
 *
 * @throws if `mnemonic` is unknown, is one of the eight branch mnemonics
 *   (use branchCycles instead — a branch's cost cannot be answered without
 *   knowing whether it was taken), or does not support `mode`.
 */
export function instructionCycles(mnemonic: string, mode: AddressingMode, crossesPage = false): number {
  if (BRANCH_MNEMONICS.has(mnemonic)) {
    throw new Error(`${mnemonic} is a branch — its cost depends on whether it's taken; use branchCycles()`);
  }
  const modes = CYCLES[mnemonic];
  if (!modes) throw new Error(`unknown mnemonic '${mnemonic}'`);
  const entry = modes[mode];
  if (!entry) {
    const supported = Object.keys(modes).join(', ');
    throw new Error(`${mnemonic} does not take ${mode} addressing (it takes: ${supported})`);
  }
  return entry.pageCrossable && crossesPage ? entry.cycles + 1 : entry.cycles;
}
