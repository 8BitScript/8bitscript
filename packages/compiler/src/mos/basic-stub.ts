// The one-line BASIC program every Commodore .prg boots through: `0 SYS
// <codeStart>`, tokenized. Its own length depends on how many decimal
// digits `codeStart` has, and `codeStart` is `loadAddress` plus that same
// length — a fixed point, not a constant. Solved by iterating on the digit
// count rather than assuming four digits the way a PET-only version could
// get away with: the C64 and VIC-20 (milestone 1's own roadmap entry) reuse
// this unchanged, from higher load addresses.

// Bytes before the digits: the 2-byte link to the next BASIC line, the
// 2-byte line number (always 0), the SYS token, the line's terminating
// null, and the 2-byte null link that ends the (one-line) program.
const STUB_OVERHEAD_BYTES = 8;

const SYS_TOKEN = 0x9e;

function decimalDigits(n: number): number {
  return String(n).length;
}

export interface BasicStub {
  /** The stub's bytes, starting at `loadAddress` (not including it). */
  bytes: Uint8Array;
  /** Where the SYS line sends control — right after these bytes. */
  codeStart: number;
}

/**
 * The BASIC stub for a program loaded at `loadAddress`: `0 SYS <codeStart>`,
 * where `codeStart` is where the stub's own bytes end.
 *
 * The fixed point (stub length depends on `codeStart`'s digit count, which
 * depends on the stub length) is found by iterating a handful of times:
 * each guess's resulting `codeStart` either confirms the guessed digit
 * count or grows it, and digit count only ever grows by one as an address
 * crosses a power of ten, so this always settles in at most a few steps.
 * Bounded rather than trusted, in case a future caller's `loadAddress` ever
 * sits so close to a power-of-ten boundary that it doesn't.
 */
export function basicStub(loadAddress: number): BasicStub {
  let digits = decimalDigits(loadAddress + STUB_OVERHEAD_BYTES);
  let codeStart = loadAddress + STUB_OVERHEAD_BYTES + digits;
  for (let guard = 0; decimalDigits(codeStart) !== digits; guard++) {
    if (guard >= 5) {
      throw new Error(`basicStub: SYS-line digit count did not converge for load address ${loadAddress}`);
    }
    digits = decimalDigits(codeStart);
    codeStart = loadAddress + STUB_OVERHEAD_BYTES + digits;
  }

  const bytes = new Uint8Array(STUB_OVERHEAD_BYTES + digits);
  let i = 0;
  // The link to the next BASIC line: the address right after this line's
  // own bytes, where the terminating "00 00" end-of-program link lives.
  const nextLine = loadAddress + STUB_OVERHEAD_BYTES - 2 + digits;
  bytes[i++] = nextLine & 0xff;
  bytes[i++] = (nextLine >> 8) & 0xff;
  bytes[i++] = 0x00; // line number 0, low byte
  bytes[i++] = 0x00; // line number 0, high byte
  bytes[i++] = SYS_TOKEN;
  for (const ch of String(codeStart)) bytes[i++] = ch.charCodeAt(0);
  bytes[i++] = 0x00; // end of line
  bytes[i++] = 0x00; // end of program, low byte
  bytes[i++] = 0x00; // end of program, high byte

  return { bytes, codeStart };
}
