// The Commander X16's wasm build against x16emu. `8bs conform cx16` —
// docs/project/wasm-primary.md.
//
// KNOWN GAPS: the wasm page draws the ASCII ramp in its own font, not the ISO
// character ROM x16emu uses (186 cells differ), and its text colours come from
// the C64's palette, not VERA's default (reported as colour, not failed).
// Lower knownStructure as this closes.
import { conformMachineTest } from '../../cli/test/support/conformMachine.mjs';

conformMachineTest({ machine: 'cx16', knownStructure: 186, why: 'the wasm page uses the host font, not the X16 ISO character ROM' });
