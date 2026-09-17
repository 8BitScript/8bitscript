---
"@8bitscript/cli": minor
---

`#package("version")` and `#package("name")`: a program reads its own
package.json at compile time, as a string literal — the nearest package.json
above the file, resolved the same way by `8bs build`, `8bs check` and the
editor — so a title screen prints the version the package was published
as, and a build with it is byte-identical to one with the string written
by hand. Any other field is refused by name (`8BS1041`); a missing or
unparseable package.json, or one without the field, is `8BS1042` naming
the file.
