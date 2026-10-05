// The VIC-20's wasm build against xvic. `8bs conform vic20` — docs/project/wasm-primary.md.
//
// KNOWN GAPS: reverse video (screen codes 128+ draw nothing sensible, so the
// corner cells, the reverse ramp and the colour row differ) and the character
// set — the wasm page draws the lower-case ROM set where the real machine
// boots in upper case with graphics (166 cells). Lower knownStructure as this closes.
import { conformMachineTest } from '../../cli/test/support/conformMachine.mjs';

conformMachineTest({
  machine: 'vic20',
  knownStructure: 166,
  why: 'reverse video is not drawn, and the wasm page uses the lower-case character set where the machine boots in upper case',
});
