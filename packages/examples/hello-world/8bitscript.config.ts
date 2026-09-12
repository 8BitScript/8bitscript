// Hello, World: the 0.2.0 goal program, and the only example that ships
// today. One source file, built for both machines this release supports —
// @8bitscript/text resolves to the PET's own text package on a PET build
// and to the web's on a web build, so nothing here names either machine.
export default {
  entry: 'src/main.8bs',
  // The greeting is written `"Hello World!"` and reaches the screen as
  // exactly that: @8bitscript/pet/text draws in the PET's text character
  // set, the only one that holds both cases of the alphabet, and selects
  // it on the models that boot into the graphics set instead. Nothing
  // selects it back on the way out — that bit is retroactive, so putting
  // it back re-renders the greeting it was switched for. A 3032 therefore
  // ends at a lower-case `ready.`; a 2001 and an 8032 end exactly as they
  // started. See packages/pet/src/text.8bs.
  targets: { pet: {}, web: {} },
  systems: {
    'PET 3032': { target: 'pet', profile: '3032' },
    'PET 8032': { target: 'pet', profile: '8032' },
    'The browser': { target: 'web' },
  },
};
