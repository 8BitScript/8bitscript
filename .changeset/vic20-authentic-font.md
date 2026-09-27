---
"@8bitscript/cli": patch
---

Fixed the VIC-20's wasm preview drawing the wrong glyph for every lower-case letter — "Hello World!" showed only `H`, `W` and `!` correctly, since `text.8bs` writes real screen codes (lower case at 1-26) but the preview was falling back to the shared ASCII-indexed font, where those same codes are control characters.

Fixed by reading the VIC-20's own character ROM (`chargen-901460-03.bin`) directly — VICE ships it as a plain binary, so unlike the PET's captures this needed no screenshot or pixel alignment at all, just the right offset and byte count.
