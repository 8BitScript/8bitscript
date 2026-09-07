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
// Studio is a pointer-driven program, so on the machines where the
// toolchain can drive a mouse it asks for one — a 1351 in control port 1
// on the C64 and the C128, the arrangement `@8bitscript/c64/input` reads
// (a stick in port 2, a pointer in port 1, which is what C64 software
// settled on). The X16 needs no flag: `input.mouse` is true on the stock
// sheet, because the hardware has a mouse. This is the project's *stock*
// for those machines: it goes under any named profile and any
// `--hardware` on the command line, so `8bs run c64` starts Studio with
// a mouse plugged in and `--hardware port1=joystick` still takes it out.
// It is what makes `#fact(input.mouse)` true for the Commodore builds,
// which is what compiles the pointer half of the input layer in at all.
//
// It costs what a mouse costs and nothing on the machines that do not ask:
// a C64 Studio is 1553 bytes stock and 2637 with the mouse; a C128 Studio
// is 1455 bytes stock and 2577 with the mouse; an X16 Studio is 1253
// bytes without the pointer layer and 1571 with it. The other six
// machines are listed with no hardware of their own — their input
// layers have no pointer to fit (see packages/input/AGENTS.md), so asking
// for one would buy nothing.
//
// **`systems` is the machines it has been set up for.** Studio runs on all
// nine — that is what `targets` says, and the tier it picks comes from the
// build's facts, not from a name. But a machine is not one thing: a VIC-20
// with 8K is an editor and a stock one is a viewer, a C64 with a 1351 is
// pointer-driven and one without is not. Each entry below is a whole
// arrangement, ready to pick in the editor's side bar without assembling
// `--profile` and `--hardware` by hand. The first is the one to reach for:
// the X16 is Studio's reference machine. The C64 and C128 each have a
// mouse arrangement and a joystick one, matching the two ways the bar
// moves on those machines.
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
  systems: {
    'Commander X16': { target: 'cx16' },
    'C64 with a mouse': { target: 'c64' },
    'C64 with a joystick': { target: 'c64', hardware: { port1: 'joystick' } },
    'C128 with a mouse': { target: 'c128' },
    'C128 with a joystick': { target: 'c128', hardware: { port1: 'joystick' } },
    'VIC-20, expanded to 8K': { target: 'vic20', profile: '8k' },
    'VIC-20, stock': { target: 'vic20' },
    'PET 8032': { target: 'pet', profile: '8032' },
    'MEGA65': { target: 'mega65' },
    'Atari 130XE': { target: 'atari8', profile: '130xe' },
    'NES': { target: 'nes' },
    'The browser': { target: 'web' },
  },
};
