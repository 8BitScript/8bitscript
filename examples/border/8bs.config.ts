export default {
  entry: 'src/main.8bs',
  // $900F is VIC-20 hardware; this program has no meaning anywhere else.
  // Both regions build identically (no region-specific codegen exists yet),
  // but the target is named per-region because the emulator model isn't.
  targets: ['vic20-ntsc', 'vic20-pal'],
};
