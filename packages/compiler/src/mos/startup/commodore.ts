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

// ---- the character set a program was launched in --------------------------
//
// $E84C is the PET's VIA PCR, whose bit 1 selects the character set: $0C
// graphics/upper-case, $0E text (upper+lower). See packages/pet/AGENTS.md's
// memory map and packages/pet/src/index.8bs, which exports it.
//
// A program that prints anything selects the text set itself
// (@8bitscript/pet/text's `prepare()`), because that is the set its
// character encoding is written against. Nothing put the machine back, so a
// program that ran on a 3032 — which boots in graphics/upper-case — dropped
// back to a BASIC prompt in lower case, a mode its owner never chose.
//
// Save the whole register, not the one bit. The other bits are CA2 and CB2
// (the charset line and the cassette/sound line); a program returning the
// register to exactly what it was handed is both cheaper than masking one
// bit and the more honest thing to give back.
//
// The saved byte lives on the CPU stack, not in a RAM cell. It costs
// nothing that a zero-page byte would have to be allocated for, and it
// means the decision can be made *after* the body is lowered — a store to
// $E84C is a fact about the finished instruction stream, the same way CLD's
// own trigger is — instead of ahead of zero-page layout. The push and the
// pull are balanced across the program body by construction: a function
// call is a JSR/RTS pair, a `return` is a JMP to the entry's own exit label
// (never an RTS that would unbalance the stack), and expression temporaries
// live in zero page rather than on the stack.
const VIA_PCR = 0xe84c;

const PHA: Directive = { kind: 'instruction', mnemonic: 'PHA', mode: 'implied' };
const PLA: Directive = { kind: 'instruction', mnemonic: 'PLA', mode: 'implied' };
const ldaPcr: Directive = { kind: 'instruction', mnemonic: 'LDA', mode: 'absolute', operand: { kind: 'value', value: VIA_PCR } };
const staPcr: Directive = { kind: 'instruction', mnemonic: 'STA', mode: 'absolute', operand: { kind: 'value', value: VIA_PCR } };

/**
 * True if `program` ever writes the character-set register — the only thing
 * that decides whether saving and restoring it is worth its bytes. A
 * program that never selects a character set leaves the machine in the one
 * it booted already, and pays nothing.
 *
 * Scans the finished instruction stream rather than the IR: a pinned
 * `@address(0xE84C)` global lowers to a plain absolute store with a literal
 * operand (`staAddr` in mos/lower/index.ts), so this sees every route to
 * the register — the exported `viaPeripheralControl`, a `memory.write()` of
 * the same address, or anything else that lands on it — without knowing
 * which name the program reached it by.
 */
export function usesCharacterSet(program: Directive[]): boolean {
  return program.some((d) =>
    d.kind === 'instruction'
    && (d.mnemonic === 'STA' || d.mnemonic === 'STX' || d.mnemonic === 'STY')
    && d.operand?.kind === 'value'
    && d.operand.value === VIA_PCR);
}

/**
 * The program's opening: clear decimal mode when it does D-flag-sensitive
 * arithmetic, and take a copy of the character-set register when it is
 * going to change it.
 */
export function prologue(needsCld: boolean, savesCharacterSet = false): Directive[] {
  const out: Directive[] = [];
  if (needsCld) out.push(CLD);
  if (savesCharacterSet) out.push(ldaPcr, PHA);
  return out;
}

/**
 * The program's close: put the character set back the way it was found
 * (when the prologue saved it), then RTS to the BASIC SYS that called us.
 */
export function epilogue(restoresCharacterSet = false): Directive[] {
  const out: Directive[] = [];
  if (restoresCharacterSet) out.push(PLA, staPcr);
  out.push({ kind: 'instruction', mnemonic: 'RTS', mode: 'implied' });
  return out;
}
