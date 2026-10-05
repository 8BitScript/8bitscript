// The PET's wasm build against xpet. `8bs conform pet` — docs/project/wasm-primary.md.
//
// KNOWN GAP: reverse video. A screen code of 128 or more is the same glyph
// inverted on a real PET; the wasm page draws nothing sensible for it, so the
// probe's four solid corner cells, its reverse ramp and its colour row all
// differ (114 cells). Lower knownStructure as this closes.
import { conformMachineTest } from '../../cli/test/support/conformMachine.mjs';

conformMachineTest({ machine: 'pet', knownStructure: 114, why: 'reverse video (screen codes 128+) is not drawn' });
