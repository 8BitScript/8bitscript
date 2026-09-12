// What a built program looks like as a FILE, per machine.
//
// Everything this backend has built so far shares one shape, because every
// machine it has built for so far was a Commodore: a `.prg` whose first two
// bytes are the load address, followed by a one-line BASIC program whose
// `SYS` jumps into the code that follows it. `RUN` after `LOAD` starts it,
// and `main()` falling off its end lands back in that `SYS`.
//
// That shape is not universal, and the two machines it does not fit are the
// two this file exists for. A NES program is a ROM, not a load: an iNES
// header, then PRG-ROM ending in the 6502's own reset/NMI/IRQ vectors,
// which are what start it — there is no loader to return to, and nothing
// resembling a BASIC. An Atari 8-bit program is a segmented executable: a
// `$FFFF` marker, then (start, end, bytes) segments, then a RUN segment
// that writes the entry address to `$02E0`/`$02E1` for the DOS loader to
// jump through.
//
// So a machine says three things here, and the rest of build() does not
// have to know which machine it is building for:
//
//   prelude   bytes that sit inside the image ahead of the lowered code,
//             and where the code therefore starts. A BASIC stub on a
//             Commodore; nothing at all where the hardware jumps straight
//             to an address.
//   file      the finished bytes on disk: the prelude and the code wrapped
//             in whatever header, padding or trailer the format wants.
//   entryIsVectored  whether starting the program is the machine's job
//             (a reset vector) rather than a loader's — which is also
//             exactly when `main()` returning has nowhere to return to.
//
// A machine with no entry here gets COMMODORE, which is what every machine
// that ships today wants and what the tests measure byte for byte.
import { basicStub } from './basic-stub.ts';
import { prgBytes } from './prg.ts';
import type { Machine } from './index.ts';

export interface MachineImage {
  /**
   * The bytes that precede the lowered code inside the image, and the
   * address the code itself begins at. `loadAddress` is the machine's own,
   * off the hardware sheet (`build.defsym.__load_address`).
   */
  prelude(loadAddress: number): { bytes: Uint8Array; codeStart: number };
  /**
   * The finished file. `body` is the prelude and the linked code already
   * joined; `codeStart` is where the code sits, which a format whose
   * hardware jumps to an address needs and a `.prg` ignores.
   */
  file(loadAddress: number, body: Uint8Array, codeStart: number): Uint8Array;
  /** True when the machine starts the program itself, so there is no loader to return to. */
  entryIsVectored: boolean;
}

/** Load address, BASIC stub, `SYS` — every Commodore this backend builds. */
export const COMMODORE: MachineImage = {
  prelude(loadAddress: number) {
    const { bytes, codeStart } = basicStub(loadAddress);
    return { bytes, codeStart };
  },
  file(loadAddress: number, body: Uint8Array) {
    return prgBytes(loadAddress, body);
  },
  entryIsVectored: false,
};

/**
 * Per machine, where it differs from COMMODORE. Empty until a machine that
 * is not a Commodore builds — the NES and the Atari 8-bit are what this is
 * for, and each is its own entry rather than a branch inside build().
 */
export const IMAGE: Partial<Record<Machine, MachineImage>> = {};

/** The image a machine is built as — COMMODORE unless it says otherwise. */
export function imageFor(machine: Machine): MachineImage {
  return IMAGE[machine] ?? COMMODORE;
}
