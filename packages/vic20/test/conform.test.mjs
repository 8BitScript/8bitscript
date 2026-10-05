// The VIC-20's wasm build against xvic: the text grid, the character ROM as the
// machine draws it, and reverse video. `8bs conform vic20` — docs/project/wasm-primary.md.
// Zero cells differ in structure. The page boots in the upper case and graphics
// set and follows the low nybble of $9005 (the chargen base) to the lower/upper
// set; a screen code's bit 7 is the glyph inverted (packages/cli/src/font8x8.mjs).
// The 'grid' probe's colour row differs in six cells in colour only — the page
// paints a palette that is not xvic's — which is reported, not failed
// (docs/project/wasm-primary.md, backlog item 5).
//
//   grid          the printable ASCII ramp, normal and reverse, the colour row
//   charset       every screen code 0..255, raw, in the upper-case and graphics set ($9005 nybble 0)
//   charset-text  the same 256 codes in the lower/upper-case set (nybble 2)
import { conformMachineTest } from '../../cli/test/support/conformMachine.mjs';

for (const program of ['grid', 'charset', 'charset-text']) {
  conformMachineTest({ machine: 'vic20', knownStructure: 0, program });
}
