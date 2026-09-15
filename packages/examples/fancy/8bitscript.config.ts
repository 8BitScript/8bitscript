// Fancy: the raster showpiece. One source file, built for every machine
// this release supports — @8bitscript/raster resolves to the C64's
// rasterline translation on a C64 build, the web's direct list on a web
// build, and an honest zero-cost stub on the seven machines with no
// per-scanline hook, so nothing here names any of them. The wobble and
// the colour bands live behind #fact(video.raster); the other seven get
// the same static title and frame counter, and pay nothing for the code
// they cannot run.
export default {
  entry: 'src/main.8bs',
  // Every target, and each one stock, the same way joystick is: the
  // program has to fit the smallest machine it claims to run on, so the
  // default 4K PET 2001 budget and the unexpanded VIC-20's are the two it
  // is held to. Both are measured in src/main.8bs's header.
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
    'The browser (C64 skin)': { target: 'web', hardware: { machine: 'c64' } },
  },
};
