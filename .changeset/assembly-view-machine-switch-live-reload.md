---
"8bitscript-lang": minor
---

"View Generated Assembly" now colors its listing with a real 6502 assembly grammar, shows the whole file rather than just the statement under the cursor (so the view stays put regardless of where you click in the source), and gains "View Generated Assembly For…" plus an open tab's own "Open For Another Machine…" button to open several machines' listings side by side. Saving any `.8bs`/`.8bx` file in the same project rebuilds every open tab in place, preserving scroll position and selection and never blanking a tab on a mid-edit build failure.
