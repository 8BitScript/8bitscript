---
"@8bitscript/compiler": patch
"8bitscript-lang": patch
---

Resolved SonarQube findings in `editors/vscode/src/projects.cjs` (an
explicit sort compare function, a `.map()` callback no longer passed
a function with its own second parameter directly, two regexes with
quadratic worst-case behavior replaced with plain string methods, and
a hand-rolled scanner's loop rewritten so its own cursor isn't a
reassigned `for` variable) and `packages/compiler/src/mos/asm/relax.ts`
(`Number.parseInt` instead of the global). No behavior change.
