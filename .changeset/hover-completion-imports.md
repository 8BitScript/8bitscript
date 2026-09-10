---
"@8bitscript/compiler": patch
"@8bitscript/language-server": patch
"8bitscript-lang": patch
---

Hover and completion now cover a named import's own namespace, not just
built-in syntax: hovering `screen.blank(...)` shows its signature and doc
comment, and typing `screen.bl` after `import { screen } from
"@8bitscript/screen"` offers `blank` in the completion list. This reads the
module the import actually resolves to — for a machine-conditional package
such as `@8bitscript/screen`, one release target's version (noted in the
hover text), since no single machine is known while editing.
