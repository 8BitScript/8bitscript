// Hello, raw: the first program the native backend builds. PET only, on
// purpose — it writes the PET's screen RAM by address, which no other
// machine shares. The portable version is ../hello.
export default {
  entry: 'src/main.8bs',
  targets: { pet: {} },
  systems: {
    'PET 3032': { target: 'pet' },
    'PET 8032': { target: 'pet', profile: '8032' },
  },
};
