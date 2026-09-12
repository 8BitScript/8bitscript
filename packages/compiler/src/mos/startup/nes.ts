// The NES's reset handler: the instructions that run before anything the
// program wrote.
//
// Every other machine this backend builds for hands a program a machine
// that is already awake. A .prg is loaded by a KERNAL that has been running
// for a second and a half; BASIC's SYS arrives with the stack set up, the
// interrupt sources configured, and the video chip long since stable. A
// cartridge arrives 30,000 cycles earlier than that, at a machine that has
// done nothing at all, and the difference is not cosmetic — a program that
// skips this draws to a PPU that is still ignoring it.
//
// What the 6502's reset itself does is narrow and documented: it sets the
// I flag and loads PC from $FFFC. It does NOT set the stack pointer, clear
// the decimal flag, or initialize a single peripheral. Everything below is
// therefore something a program on this machine has to do for itself, and
// each line is here for a reason that was checked rather than copied:
//
//   SEI            Reset already set I, but a warm reset (the console's own
//                  RESET button) re-enters here with the program's flags
//                  as they were. One byte to make "interrupts are off" true
//                  by this code rather than by inheritance.
//   $4017 = $40    The APU's frame counter, in 4-step mode, raises an IRQ
//                  at the end of every sequence unless bit 6 says not to.
//                  Its state at power-on is not specified, so a program
//                  that never touches the APU can still be interrupted by
//                  it. Bit 6 set = frame IRQ inhibited.
//   $4010 = $00    The DMC's own IRQ, off for the same reason.
//   LDX #$FF / TXS The stack pointer is genuinely undefined at reset, and
//                  this backend's calling convention is JSR/RTS all the way
//                  down. $01FF is where a 6502's stack conventionally
//                  starts and there is nothing above page 1 to protect.
//   $2000 = $00    PPUCTRL: NMI off. This target polls PPUSTATUS rather
//                  than taking the vertical-blank interrupt
//                  (packages/nes/src/index.8bs says so, and mos/image-nes.ts
//                  points the NMI vector at an RTI on the strength of it),
//                  so the bit that would fire it is cleared before the PPU
//                  is warm enough to act on anything.
//   $2001 = $00    PPUMASK: rendering off, which is the state
//                  @8bitscript/nes/screen's own `renderingEnabled = 0`
//                  already believes it is in.
//
// ---- the two vertical blanks ---------------------------------------------
//
// Then the part that is genuinely a hardware fact rather than tidiness, and
// the one whose absence is invisible in the code and total on screen: the
// 2C02 is not ready after reset. Writes to PPUCTRL, PPUMASK and the scroll
// and address registers are IGNORED for roughly the first 29,658 CPU
// cycles, and the documented way to wait out that interval is to wait for
// the PPU to report two vertical blanks (nesdev.org/wiki/PPU_power_up_state,
// and packages/nes/AGENTS.md's own start-up row, which records that this
// project's pre-0.2.0 toolchain did exactly this in __early_init and
// __late_init and warns against adding a third wait in the package).
//
// Measured here, on the very first .nes this backend produced: without it,
// @8bitscript/screen's `blank()` ran to completion and its final write of
// $0A to PPUMASK — the one that switches the picture on — landed inside
// that window and was dropped. The program was correct, the emulator was
// correct, and the screenshot was 256x240 pixels of black (FCEUX,
// 2026-09-12). That is precisely the failure packages/nes/AGENTS.md says
// only a screenshot catches.
//
// The wait is spelled `BIT $2002` / `BPL` rather than `LDA`: BIT copies
// bit 7 of the operand into N without disturbing A, and reading PPUSTATUS
// clears the flag as a side effect either way, so the loop below sees a
// real vertical-blank edge each time round rather than one stale flag
// twice. The unconditional `BIT` ahead of the first loop is what discards
// that stale flag, which may be set from before the CPU was even running.
import type { Directive } from '../asm/assemble.ts';
import type { AddressingMode } from '../asm/encode.ts';

const PPU_CTRL = 0x2000;
const PPU_MASK = 0x2001;
const PPU_STATUS = 0x2002;
const APU_DMC_FREQ = 0x4010; // bit 7: DMC IRQ enable
const APU_FRAME_COUNTER = 0x4017; // bit 6: frame IRQ inhibit

function instr(mnemonic: string, mode: AddressingMode, value?: number, labelName?: string): Directive {
  if (labelName !== undefined) return { kind: 'instruction', mnemonic, mode, operand: { kind: 'label', name: labelName } };
  if (value !== undefined) return { kind: 'instruction', mnemonic, mode, operand: { kind: 'value', value } };
  return { kind: 'instruction', mnemonic, mode };
}

/** `BIT PPUSTATUS` / `BPL` — blocks until the PPU reports the start of a vertical blank, clearing the flag on the way past. */
function waitVerticalBlank(tag: string): Directive[] {
  return [
    { kind: 'label', name: tag },
    instr('BIT', 'absolute', PPU_STATUS),
    instr('BPL', 'relative', undefined, tag),
  ];
}

/**
 * The reset-handler preamble every NES build begins with: interrupts and
 * the two IRQ sources off, a stack pointer, a quiet PPU, and the two
 * vertical blanks the chip needs before it will accept a write. About two
 * dozen bytes, paid once, on the one machine here that boots from nothing.
 */
export function nesResetInit(): Directive[] {
  return [
    instr('SEI', 'implied'),
    instr('LDX', 'immediate', 0x40),
    instr('STX', 'absolute', APU_FRAME_COUNTER),
    instr('LDX', 'immediate', 0xff),
    instr('TXS', 'implied'),
    // X = 0 by wrapping the $FF that is already in it: one byte instead of
    // a second LDX, and the stack pointer it was loaded for is already set.
    instr('INX', 'implied'),
    instr('STX', 'absolute', PPU_CTRL),
    instr('STX', 'absolute', PPU_MASK),
    instr('STX', 'absolute', APU_DMC_FREQ),
    // Discard whatever the vertical-blank flag reads as before the program
    // was running, so the first wait below measures a real edge.
    instr('BIT', 'absolute', PPU_STATUS),
    ...waitVerticalBlank('__8bs_nes_warmup_1'),
    ...waitVerticalBlank('__8bs_nes_warmup_2'),
  ];
}
