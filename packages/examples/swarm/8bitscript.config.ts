// Swarm — the moving-objects showpiece: sixteen sprites bouncing round the
// picture, cued by a frame timeline, through @8bitscript/sprites and
// @8bitscript/timeline — see this directory's entry in ../README.md and
// docs/project/frame.md. One program, nine targets: hardware sprites on
// the C64 (sixteen from eight, and through the opened border), quadrant
// block objects at 4-pixel steps on the PET — whose shape patterns and
// save-under need more than a 2001's 4K leaves, so the PET here is the
// 32K 3032 — a glyph per sprite on the character grid everywhere else.
export default {
  entry: 'src/swarm.8bs',
  targets: { pet: {}, c64: {}, vic20: {}, c128: {}, cx16: {}, mega65: {}, atari8: {}, nes: {}, web: {} },
  systems: {
    'PET 3032': { target: 'pet', profile: '3032' },
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
