// Hello, World: the goal program, and the only example that ships today.
// One source file, built for every machine this release supports —
// @8bitscript/text resolves to the PET's own text package on a PET build,
// the C64's on a C64 build, the web's on a web build, so nothing here names
// any of them.
export default {
  entry: 'src/main.8bs',
  // The greeting is written `"Hello World!"` and reaches the screen as
  // exactly that on every one of these. Each Commodore's text package draws
  // in the machine's mixed-case character set — the only set that holds
  // both cases of the alphabet, so the only one that can — and selects it
  // where the machine did not boot into it. Nothing selects it back on the
  // way out: that bit is retroactive, so putting it back would re-render
  // the greeting it was switched for. A PET 3032 and a VIC-20 therefore end
  // at a lower-case `ready.`; a PET 2001 and an 8032 end exactly as they
  // started. See packages/pet/src/text.8bs for the long version.
  targets: { pet: {}, c64: {}, vic20: {}, c128: {}, web: {} },
  systems: {
    'PET 3032': { target: 'pet', profile: '3032' },
    'PET 8032': { target: 'pet', profile: '8032' },
    'Commodore 64': { target: 'c64' },
    'VIC-20': { target: 'vic20' },
    'Commodore 128': { target: 'c128' },
    'The browser': { target: 'web' },
  },
};
