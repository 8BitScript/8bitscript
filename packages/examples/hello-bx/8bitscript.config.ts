// The hello-world greeting, drawn through one 8BitX component instead of a
// direct call — see this directory's entry in ../README.md. Targets every
// machine this release supports, the same as hello-world itself: elaboration
// runs in the front end, before any backend-specific lowering, so nothing
// here is PET- or web-only.
export default {
  entry: 'src/hello-bx.8bx',
  targets: { pet: {}, c64: {}, vic20: {}, c128: {}, cx16: {}, mega65: {}, atari8: {}, nes: {}, web: {} },
  systems: {
    'PET 2001': { target: 'pet', profile: '2001' },
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
