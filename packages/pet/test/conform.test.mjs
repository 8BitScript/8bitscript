// The PET's wasm build against xpet: the text grid, the character ROM as the
// machine draws it, and reverse video. `8bs conform pet` — docs/project/wasm-primary.md.
// Zero cells differ in structure. Reverse video is a screen code's bit 7 (the
// video circuit inverts the glyph; packages/cli/src/font8x8.mjs), and which ROM
// set draws is the VIA control register ($E84C bit 1), which the page reads
// each frame.
//
//   grid          the printable ASCII ramp, normal and reverse, the colour row
//   charset       every screen code 0..255, raw, in the set the machine boots in (graphics)
//   charset-text  the same 256 codes after POKE 59468,14 (the lower/upper-case set)
import { conformMachineTest } from '../../cli/test/support/conformMachine.mjs';

for (const program of ['grid', 'charset', 'charset-text']) {
  conformMachineTest({ machine: 'pet', knownStructure: 0, program });
}
