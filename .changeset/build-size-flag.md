---
"@8bitscript/cli": minor
"@8bitscript/compiler": minor
---

`8bs build --target <t> --size` prints a per-function breakdown of the
built program under the existing memory line — every function that
survived reachability pruning, plus each backend's own fixed-cost
buckets (the wait-frame runtime, the BASIC stub, a wasm module's own
section framing), largest first, each with its own share of the total.
Opt-in: without the flag, `8bs build` prints exactly what it always
has.
