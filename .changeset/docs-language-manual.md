---
"@8bitscript/cli": patch
---

docs: the language manual and the 8BX specification live in the repo.

`docs/language/` is the manual — the language by task, nine pages:
hello world both ways, the core `.8bs` language, `.8bx` composition
(elements, components, `<slot />`, conditional composition, state,
methods, the purity rule), the `.8bs` ↔ `.8bx` boundary, project config
and the CLI, the editor and every `8BS` diagnostic code, the standard
packages, two worked examples with their measured byte counts, and the
one list of what is not built yet. `docs/spec/8bx.md` is the 8BX
specification itself, all 142 sections, cited from the other pages as
`§N`. `docs/project/8bx.md` becomes the ledger between them: the spec's
PR sequence as it landed (#159–#177, 2048 #46), the rules code enforces,
and where the code and the spec still differ. The home page says what
0.11.0 is instead of what 0.2.0 was, and nothing on the site links out
to an artifact for its own documentation any more.

Two claims corrected against the code on the way in: there is no
"children required" diagnostic — the `.8bs` call form of a slotted
component is its body with the slot elided — and the CLI table now lists
`8bs boot`, `8bs setup` and `8bs controller`.
