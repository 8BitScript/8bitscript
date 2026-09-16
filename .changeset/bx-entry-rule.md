---
"@8bitscript/cli": minor
"@8bitscript/examples": minor
---

A program starts from a `.8bs` file. `8bs build` refuses an `.8bx` entry
by name — an `.8bx` declares composition, and a program reaches its
components by importing them and calling them: `Hello();` is `<Hello />`
the way `.8bs` can spell it, and is checked as any call is. `hello-bx`
is split accordingly: `src/hello-bx.8bs` is the program, `src/Hello.8bx`
the component, and its PET build is still byte-identical to
`hello-world`'s.
