---
"@8bitscript/compiler": patch
---

`cond ? a : b` lowers on the web backend too (an `if … else … end` that
leaves one value; only the taken arm runs), so both backends know the
whole core language the same way. A `?:` whose test is known at compile
time — `#fact(...) ? a : b` — is the taken arm, and the other is gone.
