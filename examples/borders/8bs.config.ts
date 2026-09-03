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
  // atari8, cx16, and nes get their own trimmed entry instead: none of the
  // three has a `screen` namespace yet (see each package's own file
  // comment for why — none of them has a fixed, directly-addressable screen
  // memory location the way the Commodore/MEGA65 targets do), so main.8bs
  // as written would not compile for them. Each variant cycles whichever
  // one of `border`/`background` is real on that target and drops the
  // on-screen TICK/OPTION digit readout, at the same 2Hz tick — see each
  // file's own header for exactly what's real and what's inert there.
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
