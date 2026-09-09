// Hello, World: the 0.2.0 goal program, and the only example that ships
// today. One source file, built for both machines this release supports —
// @8bitscript/text resolves to the PET's own text package on a PET build
// and to the web's on a web build, so nothing here names either machine.
export default {
  entry: 'src/main.8bs',
  targets: { pet: {}, web: {} },
  systems: {
    'PET 3032': { target: 'pet' },
    'PET 8032': { target: 'pet', profile: '8032' },
    'The browser': { target: 'web' },
  },
};
