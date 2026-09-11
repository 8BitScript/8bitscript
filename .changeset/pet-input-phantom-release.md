---
"@8bitscript/pet": patch
---

The PET input layer no longer turns a release of SHIFT into a phantom
RIGHT/DOWN press. Edges are now detected on the physical cursor keys,
with SHIFT sampled only to decide what a cursor key's own edge means —
before this, the edge was detected on the shift-composed direction bit,
and since nobody releases SHIFT and the cursor key on the same frame,
every left/up release left a frame of bare cursor key that read as a
brand-new right/down press (measured in 2048 under xpet: each LEFT move
was chased by a phantom RIGHT that slid the board straight back, which
players experienced as "my keypress did nothing").
