export default {
  // vic20, c64, and web all build from the same main.8bs: it exports
  // main()+frame() (see main.8bs's header for why), and the 6502 backend
  // and the web host each drive that convention their own way. NTSC vs PAL
  // is a --pal flag on `8bs build`/`8bs run` for vic20 and c64 (both
  // regions build identically today); it is ignored for web, which has no
  // fixed refresh rate to pick between in the first place.
  entry: 'src/main.8bs',
  targets: ['vic20', 'c64', 'web'],
};
