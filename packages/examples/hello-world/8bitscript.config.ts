// Hello, World: the 0.2.0 goal program, and the only example that ships
// today. One source file, built for both machines this release supports —
// @8bitscript/text resolves to the PET's own text package on a PET build
// and to the web's on a web build, so nothing here names either machine.
export default {
  entry: 'src/main.8bs',
  // `restoreOnExit` is left at its default, true: main() prints and
  // returns, and the machine goes back to BASIC in the character set it
  // was launched in rather than the text set printing selected. Setting it
  // false buys back eight bytes on the PET (and no RAM — the saved byte
  // rides the CPU stack) for a program that would rather keep them.
  //
  // Worth knowing before turning it on for a program of your own: the
  // PET's charset bit is one global switch for the whole screen, so
  // putting it back also re-renders text still on screen through the other
  // ROM. On a machine that boots in graphics/upper-case — the 3032 and
  // 4032 do — a greeting left up at exit comes back as graphics glyphs. A
  // program that wants both the machine back and a readable screen blanks
  // the screen before it returns.
  targets: { pet: {}, web: {} },
  systems: {
    'PET 3032': { target: 'pet', profile: '3032' },
    'PET 8032': { target: 'pet', profile: '8032' },
    'The browser': { target: 'web' },
  },
};
