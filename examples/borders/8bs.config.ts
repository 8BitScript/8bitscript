export default {
  // One main.8bs for every target; see README.md for how each machine
  // package fills in the surface it uses, and for the NTSC/PAL flag.
  entry: 'src/main.8bs',
  targets: ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'],
  // frameRate: 50,  // the logical Hz frame() is called at, on every target — default 60.
  //                 // Independent of --pal (which only picks a real hardware/emulator
  //                 // region). See README.md#how-the-frame-loop-is-driven.
};
