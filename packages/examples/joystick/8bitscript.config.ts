// Joystick: the controller test app. One source file, built for every
// machine this release supports — @8bitscript/input resolves to the PET's
// own input layer on a PET build, the NES's pad on an NES build, so
// nothing here names any of them. Point it at a machine, press things,
// and watch which lamps flash.
export default {
  entry: 'src/main.8bs',
  // Every target, and each one stock. The PET is deliberately left at its
  // default rather than given `hardware: { model: '4032', ram: '32' }` the
  // way 2048's config does: a test app has to fit the *smallest* machine
  // it claims to run on, so the default 4K 2001 budget (3071 bytes) is the
  // one this program is held to, and the unexpanded VIC-20's 3583 is the
  // other. Both are measured in src/main.8bs's header. Fitting a stock 4K
  // PET means it also fits every PET above it.
  targets: { pet: {}, c64: {}, vic20: {}, c128: {}, cx16: {}, mega65: {}, atari8: {}, nes: {}, web: {} },
  systems: {
    'PET 2001 (4K)': { target: 'pet' },
    'PET 8032': { target: 'pet', profile: '8032' },
    'Commodore 64': { target: 'c64' },
    'VIC-20': { target: 'vic20' },
    'Commodore 128': { target: 'c128' },
    'Commander X16': { target: 'cx16' },
    'MEGA65': { target: 'mega65' },
    'Atari 8-bit': { target: 'atari8' },
    'NES': { target: 'nes' },
    'The browser': { target: 'web' },
  },
};
