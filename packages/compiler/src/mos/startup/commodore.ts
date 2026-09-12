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

/**
 * The program's opening: clear decimal mode when it does D-flag-sensitive
 * arithmetic. Nothing else — a program is handed the machine as its owner
 * left it and hands back whatever it made of it, the same as a BASIC
 * program does.
 *
 * There was briefly more here. A program that prints selects the PET's
 * text character set (@8bitscript/pet/text), and this saved `$E84C` on the
 * way in to put it back on the way out, so a 3032 that booted in
 * graphics/upper case would return to an upper-case `READY.` rather than
 * the lower-case `ready.` its owner never chose. It could not work: the
 * character-set bit is screen-wide and *retroactive* — it selects the ROM
 * the video hardware reads *now*, for every cell already drawn — so
 * writing the old value back re-rendered the text the program had just
 * drawn, through the very set it had switched away from to draw it. The
 * restore undid the reason for the switch. Measured on a 3032: `Hello
 * World!` came back as `|ELLO OORLD!` above a correct prompt. A program
 * now exits in whatever set it selected, which is the only state in which
 * what it drew still reads as what it wrote. (packages/pet/AGENTS.md.)
 */
export function prologue(needsCld: boolean): Directive[] {
  return needsCld ? [CLD] : [];
}

/** The program's close: RTS to the BASIC SYS that called us. */
export function epilogue(): Directive[] {
  return [{ kind: 'instruction', mnemonic: 'RTS', mode: 'implied' }];
}
