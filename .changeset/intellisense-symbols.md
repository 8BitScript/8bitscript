---
"@8bitscript/compiler": minor
"@8bitscript/language-server": minor
"8bitscript-lang": minor
---

IntelliSense for a program's own names, from the binder (8BX spec PR 15).
Hover on a component, function, variable, const, parameter or `state`
field shows its declaration and the doc comment above it, following an
import to the file it comes from — a component called from `.8bs`
(`MenuBar();`) is the same component as `<MenuBar />`. Completion offers
the names visible from the cursor; in `.8bx`, `<` offers the components
in scope and `slot`, a component's tag offers the props it still needs
(as snippets), and `</` closes the innermost open element. New
`getDefinition` in the compiler and `textDocument/definition` in the
language server: Go to Definition lands on the declaration, in this file
or another. Hover and completion now lex an `.8bx` buffer as one.
