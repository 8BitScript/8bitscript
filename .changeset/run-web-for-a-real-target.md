---
"@8bitscript/compiler": patch
"@8bitscript/cli": minor
---

`8bs run <machine> --web` works for pet/vic20/c64, not just cx16 — and the synthetic web/hifi target still refuses an `@address` pin, which a real machine's own package is now allowed to declare.

`--web` used to mean one specific thing: "launch cx16's vendored x16emu as WebAssembly, in a browser tab." Any other target was refused before `compile()` ever ran. It now means the same thing for every release target, with a different mechanism underneath depending on what exists: cx16 keeps the real vendored emulator; `web` keeps building the synthetic target it always has; pet, vic20 and c64 build through the wasm backend from their own package source — the same widening the previous change made possible, now reachable from the actual `8bs` command rather than only from a script calling `compile()` directly. Verified live: `8bs run pet --web` serves a real page and a real `.wasm`, both HTTP 200, and writes `.8bs-last-pet.json` with the run's own URL — the same file a framing page (the extension's Studio tab) already reads for cx16.

The one thing that needed correcting on the way: the previous change let an `@address`-pinned scalar lower for *any* wasm build, including the synthetic `web` target — which was wrong. A pin only means something for a real machine's own hardware; the synthetic target owns none, and a test already said so. `BuildOptions.allowPinnedScalars` makes that an explicit choice `compile()` makes per target (`true` for a real machine, `false` for `web`) rather than something the backend decides on its own.
