---
"8bitscript-lang": patch
---

`.8bx` highlighting knows an element as a whole: from `<Name` through its
props to the `/>` or the matching `</Name>`, with the children between —
nested elements, text left plain, `{ … }` expressions with `?:` and `&&`
composing elements — and a fragment `<>` … `</>`. The grammar is now run
through Oniguruma in the extension's tests, not just compiled.
