// One main.8bs for every target: the arrow is drawn through
// @8bitscript/pointer and moved from @8bitscript/input, so nothing here
// knows which machine it is on. See README.md for what each machine makes
// of it — today the C64, the C128 and the X16 are the ones that draw.
//
// `targets` is the object form because this example, like Studio, fits its
// own hardware: a pointer program with no pointer fitted is a program that
// demonstrates nothing, so the C64 and the C128 ask for a 1351 in control
// port 1 and `8bs run c64` needs no flags. The X16 needs none either: a
// mouse is stock. It is the project's stock, so `--hardware port1=none`
// still takes the 1351 out.
export default {
  entry: 'src/main.8bs',
  targets: {
    vic20: {},
    c64: { hardware: { port1: 'mouse1351' } },
    pet: {},
    c128: { hardware: { port1: 'mouse1351' } },
    atari8: {},
    nes: {},
    cx16: {},
    mega65: {},
    web: {},
  },
};
