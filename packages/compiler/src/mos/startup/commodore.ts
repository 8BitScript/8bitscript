// The startup prologue and epilogue every Commodore .prg's BASIC stub
// SYS's into, wrapped around the lowered program body.
//
// main() returning falls through to RTS, landing back in BASIC's SYS,
// which prints READY. the same as any BASIC program falling off its own
// end — true whether main() is empty (milestone 1) or a real lowered body
// (milestone 4 on).
//
// Milestone 6 is the first one that can emit ADC/SBC (8-bit +/-, and
// unary negate), and CPU.pet's own decimalMode:true means those obey
// whatever the D flag happens to be when SYS hands control over — not
// necessarily clear. BASIC's own arithmetic clears it before evaluating an
// expression, but nothing documents that it's still clear at the exact
// moment a SYS call lands, across every ROM this backend might run under;
// this is exactly the "verify it, don't assume it" case, and the fix costs
// one byte. CLD is emitted only when the lowered body actually contains an
// ADC or SBC — a program with neither (every milestone-4-shaped one,
// including its own 70-byte fixture) pays nothing for a flag it never
// reads. Expressed as Directives, not raw bytes, so build() can hand the
// whole program — this prologue, the lowered body, this epilogue — to the
// assembler in one piece. Shared by the C64 and VIC-20 once they're
// un-parked, the way this file's name says it will be.
import type { Directive } from '../asm/assemble.ts';

const CLD: Directive = { kind: 'instruction', mnemonic: 'CLD', mode: 'implied' };

/** True if `program` contains any instruction whose result depends on the D flag — the only thing that decides whether CLD is worth its byte. */
export function usesDecimalSensitiveMath(program: Directive[]): boolean {
  return program.some((d) => d.kind === 'instruction' && (d.mnemonic === 'ADC' || d.mnemonic === 'SBC'));
}

export function prologue(needsCld: boolean): Directive[] {
  return needsCld ? [CLD] : [];
}

export function epilogue(): Directive[] {
  return [{ kind: 'instruction', mnemonic: 'RTS', mode: 'implied' }];
}
