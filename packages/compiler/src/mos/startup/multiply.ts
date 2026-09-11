// The shared 16-bit multiply subroutine (`*` runtime support, 0.2.2).
//
// The 6502 has no multiply instruction, and this backend's own root rule
// (packages/compiler/src/mos/lower/index.ts refused `*` by name through
// 0.2.1) was to say so rather than guess. What settled the shape when a
// real program finally needed one — 2048's board arithmetic and
// @8bitscript/random's LCG step (`state * 25173 + 13849`) — is the same
// trade waitFrame() already made: one shared subroutine every `*` call
// site JSRs, not an unrolled sequence per site. An unrolled shift-add of
// a 7-set-bit constant like 25173 is ~150 bytes at one site; this routine
// is ~40 bytes once, and a multiply the compiler can do cheaper never
// gets here at all — linker/optimize.mjs strength-reduces `x * 0/1`, a
// power of two, and a two-set-bit constant into shifts before any
// backend runs (the root AGENTS.md "if the compiler can do it" rule).
//
// One routine serves both widths: an 8-bit multiply zero-extends its
// operands (lower/index.ts's own exprTo16) and reads only the low result
// byte — the product's low 8 bits are the same whichever width computed
// them, which is also why signedness needs no second routine at 16 bits.
//
// The classic shift-and-add: 16 passes, multiplier B shifting right one
// bit per pass (its low bit deciding whether A is added into the result),
// multiplicand A shifting left in step. A and B are destroyed — every
// call site stores both operands fresh (they're call-scratch like a
// callee's own parameter slots, never live across a call), and the result
// pair is copied out immediately, before any enclosing expression can
// multiply again. X counts the passes; nothing in this backend holds X
// live across a JSR (the same register discipline mos/AGENTS.md already
// states for Y).
import type { Directive } from '../asm/assemble.ts';
import type { AddressingMode } from '../asm/encode.ts';
import type { IrFunction } from '../lower/index.ts';

export const MULTIPLY_LABEL = '__8bs_mul16';

/** Zero page the routine owns: operand A (2 bytes), operand B (2 bytes), and the result (2 bytes), contiguous from the base the caller placed. */
export const MULTIPLY_ZP_BYTES = 6;

/** The three zero-page cell pairs, from the routine's placed base address. */
export interface MultiplyCells {
  a: number;
  b: number;
  result: number;
}

export function multiplyCells(base: number): MultiplyCells {
  return { a: base, b: base + 2, result: base + 4 };
}

/**
 * True if any function still multiplies at run time after the optimizer's
 * own strength reduction (linker/optimize.mjs) — the same whole-program,
 * structural walk usesWaitFrame() does, run on the same optimized IR the
 * lowerer will see, so the routine and its zero page are only ever paid
 * for by a program that actually JSRs it.
 */
export function usesMultiply(functions: IrFunction[]): boolean {
  function walk(node: unknown): boolean {
    if (Array.isArray(node)) return node.some(walk);
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (obj.kind === 'binop' && obj.operator === '*') return true;
      return Object.values(obj).some(walk);
    }
    return false;
  }
  return functions.some((fn) => walk(fn.body));
}

function instr(mnemonic: string, mode: AddressingMode, value?: number, labelName?: string): Directive {
  if (labelName !== undefined) return { kind: 'instruction', mnemonic, mode, operand: { kind: 'label', name: labelName } };
  if (value !== undefined) return { kind: 'instruction', mnemonic, mode, operand: { kind: 'value', value } };
  return { kind: 'instruction', mnemonic, mode };
}
const label = (name: string): Directive => ({ kind: 'label', name });
const branch = (mnemonic: string, target: string): Directive => instr(mnemonic, 'relative', undefined, target);

/** The subroutine itself: result = A * B (low 16 bits — the same wrap `usmallint` arithmetic always has), destroying A and B. */
export function multiplyRoutine(cells: MultiplyCells): Directive[] {
  const LOOP = `${MULTIPLY_LABEL}_loop`;
  const SKIP = `${MULTIPLY_LABEL}_skip`;
  return [
    label(MULTIPLY_LABEL),
    instr('LDA', 'immediate', 0),
    instr('STA', 'zeropage', cells.result),
    instr('STA', 'zeropage', cells.result + 1),
    instr('LDX', 'immediate', 16),
    label(LOOP),
    instr('LSR', 'zeropage', cells.b + 1),
    instr('ROR', 'zeropage', cells.b),
    branch('BCC', SKIP),
    instr('CLC', 'implied'),
    instr('LDA', 'zeropage', cells.result),
    instr('ADC', 'zeropage', cells.a),
    instr('STA', 'zeropage', cells.result),
    instr('LDA', 'zeropage', cells.result + 1),
    instr('ADC', 'zeropage', cells.a + 1),
    instr('STA', 'zeropage', cells.result + 1),
    label(SKIP),
    instr('ASL', 'zeropage', cells.a),
    instr('ROL', 'zeropage', cells.a + 1),
    instr('DEX', 'implied'),
    branch('BNE', LOOP),
    instr('RTS', 'implied'),
  ];
}
