---
"@8bitscript/cli": patch
---

Fixed the VIC-20 character ROM table added moments earlier: every asymmetric letter (e, l, r, d, ...) rendered as its own horizontal mirror image — reported live as "Hello World!" reading "H \<backward e\>\<backward l\>...", a backward 'd' looking like a 'b'. Symmetric letters (H, o, W, !) happened to look right regardless, which is why the earlier fix's own visual check missed it.

The real VIC chip reads a chargen byte MSB-first (bit 7 = leftmost pixel), but this file's own font table convention is bit 0 = leftmost — the table now bit-reverses each byte to match. Cross-checked against the PET's own (already correct) character table once reversed: the two ROMs agree on all but 7 of 1024 bytes, all seven at one symbol with no letter shape to compare — real, independent confirmation the bit order is right this time.
