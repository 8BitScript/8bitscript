---
"@8bitscript/compiler": patch
---

An imported namespace const keeps the type it was declared with. `sprites.ORIGIN_X` is a `usmallint` holding 24 on the C64, and `sprites.ORIGIN_X + 236` used to be an 8-bit sum that wrapped to 4 — a sprite under the left border — because the linker inlined the member with the narrowest type that fits its value. The IR namespace now records each numeric const's declared type (`constTypes`) and the linker inlines with it, as a same-module const already was. Builds of the shipped examples are byte-identical; a program that wrote the sum with a `usmallint` variable or a literal as a workaround builds the same.
