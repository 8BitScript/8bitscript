// Hello, World: the 0.2.0 goal program, and the only example that ships
// today. One source file, built for both machines this release supports —
// @8bitscript/text resolves to the PET's own text package on a PET build
// and to the web's on a web build, so nothing here names either machine.
export default {
  entry: 'src/main.8bs',
  // Nothing here turns `restoreOnExit` off, and nothing needs to: this
  // program never changes the machine's character set, so there is nothing
  // to put back. @8bitscript/pet/text draws for whichever set the model
  // booted into, which is why the greeting is readable and the BASIC
  // prompt underneath it is still in the mode its owner started in — caps
  // on a 3032, mixed case on an 8032.
  targets: { pet: {}, web: {} },
  systems: {
    'PET 3032': { target: 'pet', profile: '3032' },
    'PET 8032': { target: 'pet', profile: '8032' },
    'The browser': { target: 'web' },
  },
};
