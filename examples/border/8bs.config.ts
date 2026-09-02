export default {
  // One entry for every machine: main.8bs imports its colour registers from
  // @8bitscript/machine, whose target-conditional entry resolves to
  // @8bitscript/vic20 or @8bitscript/c64 for the machine being built. NTSC vs
  // PAL is a --pal flag on `8bs build`/`8bs run`, not a separate target: both
  // regions build identically today (no region-specific codegen exists yet).
  entry: 'src/main.8bs',
  targets: ['vic20', 'c64'],
};
