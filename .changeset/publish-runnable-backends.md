---
"@8bitscript/compiler": patch
---

The published package now ships runnable JavaScript for the 6502 and
WebAssembly backends. `./mos` and `./wasm` used to export raw TypeScript,
which Node refuses to type-strip under node_modules
(ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — so every npm consumer of a
0.2.x compiler crashed on `8bs build` for any target. prepack now emits the
stripped backends (`tsc -p tsconfig.publish.json`, `.ts` specifiers rewritten
to `.js`) and the published manifest's exports point at them; the workspace
keeps running the TypeScript directly.
