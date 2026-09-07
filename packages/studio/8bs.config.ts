// Studio is an ordinary 8BitScript program: this is the same manifest every
// project has, and `8bs run <target>` in this directory starts it.
//
// One entry for every machine: `src/main.8bs` reads the build's facts from
// @8bitscript/system and picks the tier there — never from the machine's
// name, so a VIC-20 with a RAM expansion gets a different answer from a
// stock one. See AGENTS.md for the tiers and what each one is meant to
// hold; `8bs run vic20 --profile 8k` is the expanded machine.
//
// **`targets` is the object form because Studio fits its own hardware.**
// Studio is a pointer-driven program, so on the two machines where the
// toolchain can drive a mouse it asks for one — a 1351 in control port 1,
// the arrangement `@8bitscript/c64/input` reads (a stick in port 2, a
// pointer in port 1, which is what C64 software settled on). This is the
// project's *stock* for that machine: it goes under any named profile and
// any `--hardware` on the command line, so `8bs run c64` starts Studio
// with a mouse plugged in and `--hardware port1=joystick` still takes it
// out. It is what makes `#fact(input.mouse)` true for these builds, which
// is what compiles the pointer half of the input layer in at all.
//
// It costs what a mouse costs and nothing on the machines that do not ask:
// a C64 Studio is 1523 bytes stock and 1824 with the mouse. The other
// seven machines are listed with no hardware of their own — their input
// layers have no pointer to fit (see packages/input/AGENTS.md), so asking
// for one would buy nothing.
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
