// What a built Atari 8-bit program looks like as a FILE: a DOS `.xex`.
//
// mos/image.ts's own header sets out the contract and names this machine as
// one of the two it exists for. This is that machine's half. Nothing about
// the Atari's format resembles a Commodore `.prg`: there is no BASIC to
// stub into, no SYS, and the load address is not two bytes at the front of
// one flat blob. A `.xex` is a container of independently-addressed
// SEGMENTS, and the DOS loader walks them.
//
// ---- the format, byte for byte ------------------------------------------
//
// The file opens with the marker `$FFFF`, then repeats:
//
//     start   2 bytes, little-endian, where this segment loads
//     end     2 bytes, little-endian, the LAST byte's address — inclusive,
//             so a segment's length is `end - start + 1`
//     bytes   exactly that many bytes
//
// One of those segments carries the entry point rather than program code:
// two bytes loaded at `$02E0`/`$02E1`, which is RUNAD, the address the DOS
// loader jumps through once the file is loaded (packages/atari8/AGENTS.md's
// "OS locations" row records RUNAD at `$02E0`; `$02E2` is INITAD, the
// run-after-each-segment hook this deliberately does not use).
//
// ---- why the RUN segment comes FIRST ------------------------------------
//
// Both this project's prose and the obvious reading of the format say
// "segments, then a RUN segment at the end". The measurement says
// otherwise, and the measurement wins: packages/atari8/AGENTS.md quotes an
// `xxd` of a `.xex` this project actually built and ran, pre-0.2.0 —
//
//     ff ff  e0 02  e1 02  00 20  00 20  31 23  ...
//     |      |      |      |      |      |
//     |      |      |      |      |      end   $2331 (inclusive)
//     |      |      |      |      start $2000  <- the code segment
//     |      |      |      data: $2000, little-endian, written to $02E0/1
//     |      |      end   $02E1 (inclusive: two bytes, $02E0 and $02E1)
//     |      start $02E0                       <- the RUN segment
//     marker $FFFF
//
// — and the RUN segment is the file's first. It works either way under
// DOS 2 (RUNAD is read after the whole file has loaded, not as it is
// passed), so this is not a correctness argument; it is a "reproduce the
// artifact that was known to boot" argument. The alternative ordering is
// untested by this project and this one is not, so this one is what gets
// written, and mos/image-atari8.test.ts asserts those exact twelve leading
// bytes so the layout cannot drift back on a reading of the prose.
//
// ---- entryIsVectored: false, endsByHalting: true -------------------------
//
// These are two different questions and the Atari answers them differently,
// which is exactly why they are two fields.
//
// `entryIsVectored` asks who started the program. The NES answers "the
// machine did" — a ROM's reset vector IS the entry, and nothing was pushed
// — so an RTS there pops whatever two bytes the stack pointer happened to
// be sitting on at power-on. The Atari answers "a loader did": DOS finishes
// loading and enters through a `JSR` into a `JMP (RUNAD)` thunk, so a
// return address is genuinely on the stack when `main` begins, and
// `epilogue()`'s RTS is a safe instruction that lands somewhere real. False.
//
// `endsByHalting` asks what happens next, and here the Atari parts company
// with every Commodore. A `.prg`'s RTS lands back in the BASIC `SYS` that
// called it, BASIC prints `READY.` under the program's own drawing, and the
// picture stays up — which is the entire reason hello-world has no holding
// loop (packages/examples/hello-world/src/main.8bs says so). The Atari has
// no such caller. Measured under atari800 7.1.2, NTSC XL, on the stock
// hello-world `.xex`: the program runs, blanks the screen black and prints
// its greeting, and then — the instant it returns — the machine comes back
// with a blue screen, a `READY` of its own at the top left, and everything
// the program drew gone, because whatever regains control resets the OS
// color shadows (COLPF2 back to $94) and clears screen memory. Identical
// with `-basic`, with `-nobasic`, and with the stock config: byte-identical
// PNGs, so it is not Atari BASIC restarting on a zero page the program
// smashed, it is simply where a returning Atari program goes. Real DOS 2.5
// does the same thing for its own reason — RTS reloads DUP.SYS, which
// redraws the DOS menu over the screen.
//
// The same program with a `while (true) {}` at the end of `main` holds its
// greeting on screen indefinitely (same emulator, same flags), which is the
// measurement that isolates the return as the cause rather than a crash or
// a mis-drawn frame.
//
// So `endsByHalting: true`: three bytes of `JMP *` buy the only state in
// which what the program drew is still what the machine is showing. It is
// the same conclusion the NES reaches from the opposite premise, which is
// why build() takes either flag as a reason to halt.
//
// And no prelude at all — there is nothing to put in front of the code,
// because the entry address rides in its own segment rather than in a stub.
import type { MachineImage } from './image.ts';

/** The `$FFFF` word every `.xex` opens with, and which may legally repeat before any later segment. This writes it once. */
const XEX_MARKER = 0xffff;

/** RUNAD: the two bytes the DOS loader reads the entry address out of once the file is loaded (packages/atari8/AGENTS.md, "OS locations"). */
const RUNAD = 0x02e0;

/** A little-endian 16-bit word, pushed onto `out`. Every number in a `.xex` header is one of these. */
function pushWord(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff);
}

/**
 * One segment header: where it loads and the address of its LAST byte.
 * `end` is inclusive — the single most common way to get this format wrong
 * is an off-by-one here, which loads one byte too few and leaves the last
 * instruction of the program truncated.
 */
function pushSegmentHeader(out: number[], start: number, length: number): void {
  pushWord(out, start);
  pushWord(out, start + length - 1);
}

export const ATARI8: MachineImage = {
  // Nothing goes in front of the code. A Commodore spends a BASIC stub here
  // so that `RUN` has something to run; the Atari's loader is handed the
  // entry address as data in its own segment instead, so the first byte of
  // the code segment is the first byte the program executes.
  prelude(loadAddress: number) {
    return { bytes: new Uint8Array(0), codeStart: loadAddress };
  },

  file(loadAddress: number, body: Uint8Array, codeStart: number): Uint8Array {
    const out: number[] = [];
    pushWord(out, XEX_MARKER);

    // The RUN segment: two bytes at $02E0/$02E1 holding the entry address.
    // `codeStart`, not `loadAddress` — they are the same number today
    // (prelude() is empty), and writing the one that MEANS "where execution
    // begins" keeps them the same number if that ever stops being true.
    pushSegmentHeader(out, RUNAD, 2);
    pushWord(out, codeStart);

    // The program itself, one segment, loaded where the hardware sheet's
    // `__load_address` says ($2000 — see packages/atari8/package.json, and
    // AGENTS.md's MEMLO survey for why it is not lower: DOS 2.0S/2.5/XE 1.0
    // end at $1CFC and SpartaDOS X 4.49 at $1DBA, so $2000 clears every DOS
    // this target supports).
    pushSegmentHeader(out, loadAddress, body.length);

    const bytes = new Uint8Array(out.length + body.length);
    bytes.set(out, 0);
    bytes.set(body, out.length);
    return bytes;
  },

  entryIsVectored: false,
  endsByHalting: true,
};
