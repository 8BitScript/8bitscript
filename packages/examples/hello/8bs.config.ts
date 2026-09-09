// Hello, PET: the 0.2.0 goal program. One source file, built for every
// machine this release supports; @8bitscript/text resolves to the PET's
// text package on a PET build and to the web's on a web build.
export default {
  entry: 'src/main.8bs',
  targets: { pet: {}, web: {} },
  systems: {
    'PET 3032': { target: 'pet' },
    'PET 8032': { target: 'pet', profile: '8032' },
    'The browser': { target: 'web' },
  },
};
