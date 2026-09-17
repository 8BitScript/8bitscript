---
"@8bitscript/compiler": patch
---

An imported integer `const` now carries its declared type into IR. A
reference to a module's own const is inlined by lowering with the type it
was declared with; a reference to an *imported* one survives to the linker,
which inlined it as `{ kind: 'const', value }` with no type — so the MOS
backend refused it wherever a type is needed to widen or size a value:
`text.fill(R, 4, 32)` with `export const R: usmallint = 5;` in another
module failed with "'const': no type on this IR node", and
`let n: usmallint = R + a;` with "'binop'". Only a `bool` const, or an
integer one that happened to fold before the backend looked, got through;
the same const declared in the using module always built. The linker now
keeps the declared type beside every const value it may inline, its own and
its imports', and the PET image for the cross-module spelling is
byte-identical to the same-module one.
