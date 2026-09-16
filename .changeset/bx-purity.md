---
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
---

`.8bs` is code, `.8bx` is composition. `asm6502` is refused in an `.8bx`
file (`8BS2020`): machine code lives in a `.8bs` function the component
imports. A top-level function that composes nothing, or a top-level
`let`, in an `.8bx` is a warning (`8BS2021`) that `bx: { strict: false }`
in `8bitscript.config.ts` switches off; component methods and state, and
anything inside `{…}`, are never linted.

A warning now reports and rides along: the linker and `8bs build` stop
for errors only, where before any diagnostic — an inexact `#frames()`
duration included — stopped a build.
