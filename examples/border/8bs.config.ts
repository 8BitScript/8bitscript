export default {
  // One entry for every machine: main.8bs imports its colour registers from
  // @8bitscript/machine, whose target-conditional entry resolves to
  // @8bitscript/vic20 or @8bitscript/c64 for the machine being built. Both
  // regions build identically (no region-specific codegen exists yet), but
  // the target is named per-region because the emulator model isn't.
  entry: 'src/main.8bs',
  targets: ['vic20-ntsc', 'vic20-pal', 'c64-ntsc', 'c64-pal'],
};
