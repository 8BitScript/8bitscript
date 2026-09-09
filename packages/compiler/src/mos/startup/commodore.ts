// The startup epilogue every Commodore .prg's BASIC stub SYS's into, run
// after the lowered program body.
//
// main() returning falls through to RTS, landing back in BASIC's SYS,
// which prints READY. the same as any BASIC program falling off its own
// end — true whether main() is empty (milestone 1) or a real lowered body
// (milestone 4 on). No prologue exists yet: nothing needs setting up
// before the lowered body runs, so this is only ever an epilogue today: it
// grows a prologue the day some construct needs one. Expressed as a
// Directive, not a raw byte, so build() can hand the whole program — the
// lowered body plus this — to the assembler in one piece. Shared by the
// C64 and VIC-20 once they're un-parked, the way this file's name says it
// will be.
import type { Directive } from '../asm/assemble.ts';

export function epilogue(): Directive[] {
  return [{ kind: 'instruction', mnemonic: 'RTS', mode: 'implied' }];
}
