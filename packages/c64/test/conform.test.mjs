// The C64's wasm build against x64sc: the text grid, the character ROM as the
// machine draws it, reverse video. `8bs conform c64` — docs/project/wasm-primary.md.
// Zero cells differ in structure; the colours do differ (the wasm page uses the
// Pepto palette, VICE's default is another), which is reported, not failed.
import { conformMachineTest } from '../../cli/test/support/conformMachine.mjs';

conformMachineTest({ machine: 'c64', knownStructure: 0 });
