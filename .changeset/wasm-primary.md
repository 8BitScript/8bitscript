---
"@8bitscript/cli": minor
"@8bitscript/pet": patch
"@8bitscript/vic20": patch
"@8bitscript/c64": patch
"@8bitscript/cx16": patch
"8bitscript-lang": patch
---

WASM is the primary runtime, and now there is a way to measure whether it is telling the truth.

**`8bs conform` compares a machine's wasm build with the real machine.** For `pet`, `vic20`, `c64` and `cx16` it builds a probe program through the native emulator and through the wasm backend, captures one frame of each and compares them cell by cell: a wrong glyph is a *structure* difference and fails (exit 1), a different ink colour is a *colour* difference and warns (`--strict-colour` fails it). The probe's four solid corner cells locate the picture in each capture, so there is no table of where each emulator keeps its border. It writes the two captures and a diff image (native, wasm, and the differing cells in red and amber) and a JSON report. The first run found: the C64 matches x64sc in all 1000 cells (its palette differs); the PET is missing reverse video (114 cells); the VIC-20 the same plus the wrong boot character set (166 cells); the X16 draws the ASCII ramp in the host font, not its ISO character ROM (186 cells). Each machine package's `test/conform.test.mjs` pins its number, which can only go down. `docs/project/wasm-primary.md` has the policy, the audit of every example, Studio and the Vegas Nights slots on the five release machines, the parity matrix and the backlog.

**A web bundle for tagged hardware could not load itself.** `8bs build --target vic20 --web` (the VIC-20 with 8K, the release hardware, tag `expanded`) wrote `program-expanded.wasm` and `program-expanded.json`, and `index.html` and `embed.html` still asked for `program.wasm`: on a clean directory the only file the page needs was a 404. The pages now name the file the bundle wrote.

**The wasm capability rows no longer claim nothing is missing.** `8bs targets --json` reported `limits: []` for the PET, VIC-20 and X16, while the audit found reverse video undrawn on the PET and VIC-20, the portable `@8bitscript/raster` and `@8bitscript/input` failing to build for the wasm backend on the VIC-20 and X16 (`raster_probeRegion`, `raster_commit`, `input_poll` are machine code), `@8bitscript/graphics` objects compiling and drawing nothing on the PET, VIC-20 and X16, and no sound on any of them. They are limits now (the X16 already listed most of its own after the Studio change; this adds the input gap and the x16emu fallback), and the editor shows them.

The VS Code launcher says what the three buttons are: **Editor** is the primary way to run a program, **Browser** is the page you can share, **Native** is the real emulator, the second opinion on what the WASM build shows.
