export default {
  // vic20, c64, pet, c128, mega65, and web all build from the same
  // main.8bs: it exports main()+frame() (see main.8bs's header for why),
  // and the 6502 backend and the web host each drive that convention their
  // own way. Every one of those six targets' machine package (@8bitscript/
  // vic20 etc., resolved through @8bitscript/machine) already implements
  // the full `border`/`background`/`applyColors()`/`screen` surface
  // main.8bs uses — pet and (for `border`) atari8 too, but with some of it
  // deliberately inert on hardware that has no such register (see each
  // package's own file comment).
  //
  // atari8, cx16, and nes get their own entry instead of main.8bs. All
  // three have `screen`, but none can share main.8bs's Commodore screen
  // codes or its 40x25 CellCount: GR.0 is ATASCII on a 40x24 grid; the
  // NES is ASCII (its font is laid out that way) on a 32x30 grid whose
  // outer rows a drawn frame and NTSC overscan claim, and whose screen
  // memory is only writable at setup or in vertical blank; the X16 is
  // ASCII too (LLVM-MOS's start-up puts the KERNAL in ISO mode) on an
  // 80x60 grid whose last 4 columns and rows a VERA active-area inset
  // hides. main-atari8.8bs, main-nes.8bs, and main-cx16.8bs keep the same
  // TICK/OPTION readout with their own codes and cell positions.
  //
  // NTSC vs PAL is a --pal flag on `8bs build`/`8bs run`, not a separate
  // entry or target, for every target with a real region split (vic20,
  // c64, c128, mega65, atari8); it is ignored for pet, nes, cx16, and web,
  // none of which have one (see docs/setup and packages/backend-6502's
  // FRAME_SYNC for why per target).
  entry: {
    atari8: 'src/main-atari8.8bs',
    cx16: 'src/main-cx16.8bs',
    nes: 'src/main-nes.8bs',
    default: 'src/main.8bs',
  },
  targets: ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'],
};
