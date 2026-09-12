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
import { ATARI8 } from './image-atari8.ts';
import { NES } from './image-nes.ts';
import type { Machine } from './index.ts';

/**
 * Everything a format may need that is neither the code nor an address.
 * One field so far: the `"8bitscript".native` files the linked program's
 * own packages contributed (linker/index.mjs's `nativeSources`), which a
 * `.prg` ignores and a `.nes` cannot be built without — the NES has no
 * character ROM, so the tile patterns @8bitscript/nes ships as
 * `native/6502/font.s` are part of the FILE rather than part of the code.
 */
export interface ImageExtras {
  nativeSources: string[];
}

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
  file(loadAddress: number, body: Uint8Array, codeStart: number, extras: ImageExtras): Uint8Array;
  /** True when the machine starts the program itself, so there is no loader to return to. */
  entryIsVectored: boolean;
  /**
   * Whether the image's own bytes ARE the program's RAM once it is
   * running. True (the default, and every loaded format's answer) means a
   * mutable array can ride inside the image and be initialized by the load
   * itself — mos/zp/index.ts's own note on why no array reaches the
   * zero-page allocator. False means the image is a ROM: writing an array
   * that lives in it does nothing at all, silently, so build() places
   * mutable arrays in the RAM window the sheet names with
   * `__bss_origin`/`__bss_ceiling` instead, and clears them at start-up.
   */
  writableImage?: boolean;
  /**
   * Whether `main()` ending must STOP the 6502 rather than RTS. Implied by
   * `entryIsVectored` — a machine that vectored into the entry pushed no
   * return address, so there is nothing to RTS to — but not the same
   * question, which is why it is its own field: the Atari 8-bit's DOS loader
   * really does JSR through RUNAD, so its RTS is safe and lands somewhere
   * real. It is where it lands that is the problem (see image-atari8.ts),
   * and that is a fact about the machine's software, not about how it was
   * entered. Default (undefined) is "no": every Commodore here returns to
   * BASIC's `READY.` with its picture still on the screen.
   */
  endsByHalting?: boolean;
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
 * Per machine, where it differs from COMMODORE. One entry per machine that
 * is not a Commodore — the NES and the Atari 8-bit are what this is for,
 * and each is its own entry rather than a branch inside build().
 */
export const IMAGE: Partial<Record<Machine, MachineImage>> = {
  atari8: ATARI8,
  nes: NES,
};

/** The image a machine is built as — COMMODORE unless it says otherwise. */
export function imageFor(machine: Machine): MachineImage {
  return IMAGE[machine] ?? COMMODORE;
}
