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

// ---- borrowing the PET's zero page ---------------------------------------
//
// The PET keeps its KERNAL vectors in page zero, which no other machine this
// backend targets does: `$90/$91` is the IRQ vector, `$92/$93` BRK, `$94/$95`
// NMI (the C64 and VIC-20 put the same three at `$0314-$0319`, a page out of
// harm's way). So on the PET there is no window above BASIC a program can
// quietly take: measured under xpet with a monitor trace over `$8E-$FF` while
// the machine merely sat at `READY.`, the KERNAL reads `$8E $8F $90 $91 $97
// $99 $9A $9E $A6-$A8 $AA $C4-$C6` and writes `$8E $8F $98-$9B $A6-$AA $F9
// $FA` — the top of that page is live, not spare, and `$90/$91` is read by
// every single retrace interrupt.
//
// That is what these two routines exist for. A PET program that returns to
// BASIC switches interrupts off, copies the zero page it is about to use into
// a buffer in its own image, and copies it back on the way out — so it may
// take the whole page while it runs, and hand back the one BASIC left. It is
// what a returning PET machine-language program has always had to do, and it
// is cheaper than it looks: two bytes of image per byte borrowed, and about
// twenty cycles each way.
//
// Interrupts stay off for the whole run rather than just the two copies,
// because between them the vectors are the program's variables — a retrace
// interrupt landing there is a `JMP` through whatever the program last stored
// (measured: the greeting's own screen-code table, and then a slide through
// RAM). Nothing on this machine's path needs them on: @8bitscript/pet's text
// and screen write `$8000` directly, its keyboard scans the matrix itself and
// documents needing the KERNAL IRQ quiet anyway, and its audio drives the VIA.
// The jiffy clock loses the time the program takes, which is the one visible
// cost and is why this is not done on machines that do not need it.
//
// `SEI` does not mask NMI and `$94/$95` is borrowed along with the rest — no
// mitigation, because the PET has no NMI source to speak of: there is no
// RESTORE key on its keyboard and nothing on the board pulls the line.
const ZP_SAVE_LABEL = '__8bs_zp_save';

function copyLoop(tag: string, from: Directive, to: Directive, bytes: number): Directive[] {
  return [
    { kind: 'instruction', mnemonic: 'LDX', mode: 'immediate', operand: { kind: 'value', value: 0 } },
    { kind: 'label', name: tag },
    from,
    to,
    { kind: 'instruction', mnemonic: 'INX', mode: 'implied' },
    { kind: 'instruction', mnemonic: 'CPX', mode: 'immediate', operand: { kind: 'value', value: bytes } },
    { kind: 'instruction', mnemonic: 'BNE', mode: 'relative', operand: { kind: 'label', name: tag } },
  ];
}

/**
 * Interrupts off, then `bytes` of zero page from `origin` into the image's own
 * buffer — emitted after the RAM clear and before the first global
 * initializer, which is the first thing that would overwrite any of it.
 */
export function borrowZeroPage(origin: number, bytes: number): Directive[] {
  if (bytes <= 0) return [];
  return [
    { kind: 'instruction', mnemonic: 'SEI', mode: 'implied' },
    ...copyLoop(
      '__8bs_zp_borrow',
      { kind: 'instruction', mnemonic: 'LDA', mode: 'absolute,x', operand: { kind: 'value', value: origin } },
      { kind: 'instruction', mnemonic: 'STA', mode: 'absolute,x', operand: { kind: 'label', name: ZP_SAVE_LABEL } },
      bytes,
    ),
  ];
}

/** The same bytes back where BASIC left them, and interrupts on again, immediately before the epilogue's RTS. */
export function returnZeroPage(origin: number, bytes: number): Directive[] {
  if (bytes <= 0) return [];
  return [
    ...copyLoop(
      '__8bs_zp_return',
      { kind: 'instruction', mnemonic: 'LDA', mode: 'absolute,x', operand: { kind: 'label', name: ZP_SAVE_LABEL } },
      { kind: 'instruction', mnemonic: 'STA', mode: 'absolute,x', operand: { kind: 'value', value: origin } },
      bytes,
    ),
    { kind: 'instruction', mnemonic: 'CLI', mode: 'implied' },
  ];
}

/** The buffer itself, appended to the image beside the other data. */
export function zeroPageSaveData(bytes: number): Directive[] {
  if (bytes <= 0) return [];
  return [{ kind: 'label', name: ZP_SAVE_LABEL }, { kind: 'byte', values: new Array(bytes).fill(0) }];
}
