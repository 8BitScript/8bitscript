---
"@8bitscript/compiler": minor
"@8bitscript/ui": minor
---

8BX components place their children with `<slot />`. A slotted component
is elaborated into two functions around the slot, and
`<Window x={1}><A /><B /></Window>` into `Window__open(1); A(); B();
Window__close(1);` — the children run once, in place; an argument both
halves read is hoisted into a local when it could do anything, so it
runs once; and the halves cross modules like any other exported
function. The slot must be one, at the top level of the body, with no
local read across it (`8BS2019` otherwise). A `children` parameter still
means the component accepts text children.

`@8bitscript/ui/menubar-bx` is the wrapper as it was meant to be:
`<MenuBar row={0} width={40}><MenuItem label="FILE" /></MenuBar>`, with
`MenuBarEnd` gone. Written as elements, a bar builds byte-identical to
the hand-written begin/item/end calls on the PET and the C64 — measured
in `packages/cli/test/menubar-bx.test.mjs`.
