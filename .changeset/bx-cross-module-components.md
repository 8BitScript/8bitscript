---
"@8bitscript/compiler": minor
"@8bitscript/ui": minor
---

8BX components cross module boundaries, and cost nothing when their
props are compile-time.

A `component` is now elaborated to a function of the same name in the
module that declares it, and an element to a call to it — so a body
resolves names where it was written, an attribute expression runs once
however often the body reads the prop, and `export component` is an
ordinary exported function that `import { MenuBar } from "./menubar.8bx"`
binds like any other. `link()` reads the whole module graph before
elaborating any module, so an imported component's signature is known
where it is used; `analyze()` does the same one import deep. The linker's
inliner inlines a component call whose arguments are all compile-time
values, so `hello-bx` still builds byte-identical to `hello-world` on
the PET (tested), and a component fed a run-time value stays a call.

`export component` parses. `component` is a keyword in `.8bx` only:
`let component: u8` in a `.8bs` file compiles as it always did.
`@8bitscript/ui`'s `menubar.8bx` exports its three components.
