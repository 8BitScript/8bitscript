---
"@8bitscript/cli": minor
---

A locale is a build input. `strings.de.8bs` beside `strings.8bs` is the
German version, `strings.pet.de.8bs` the German version of the PET's twin,
`strings.pet.8032.de.8bs` of the 8032's — the locale is the innermost twin
dimension, always the last word before the extension, for `.8bx` files
too. It refines the machine choice and never changes it: whichever level a
build would take without a locale, it takes that level's `.<locale>` file
when one exists; a machine twin with no version in the locale is used and
said (`8BS3005`, a warning) when the plain file has one. A build that names
no locale reads no locale's file, so every existing project builds and
names exactly as before.

`locale` in `8bitscript.config.ts` (project-wide, per target, or in a
`release` entry — `release: [{}, { locale: 'de' }]` builds both), and
`8bs build --locale de` / `8bs run --locale de` over all of them. A name is
two to eight lower-case letters with an optional `-region` (`de`, `pt-br`),
never a machine's name or one of its hardware tags. The artifact carries it
— `2048-pet-de.prg`, `program-de.wasm` beside `program.wasm` in `dist/web`
— only when one is set. `#locale("de")` folds to `true` in that build and
`false` in every other, and in one that names none (`8BS1040` for anything
but one name in quotes).

Not in this release: a compile-time conversion of a string literal to a
machine's screen codes, so a machine whose strings are pre-converted by
hand (the size-fitted PET) still wants a `strings.pet.<locale>.8bs` per
locale.
