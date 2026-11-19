---
"@8bitscript/compiler": patch
---

Add an optional `dump` callback to the compiler's `link()` and both `build()` functions. It is called with each stage's value as the build reaches it, and a build without it is unchanged.
