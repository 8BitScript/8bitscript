---
"@8bitscript/cli": minor
"@8bitscript/pet": patch
"@8bitscript/vic20": patch
---

The PET and VIC-20 wasm builds draw reverse video and the character set the machine is really in, and `8bs conform` now agrees with the real emulators on every glyph.

**Reverse video.** A screen code with bit 7 set is the same glyph with every pixel inverted on a real PET (the video circuit does it) and on a real VIC-20 (the ROM's reversed copies are exactly that). The wasm page's PET and VIC-20 fonts only had codes 0–127, so codes 128 and up drew as blanks, the corner cells, the reverse ramp and the colour row of `8bs conform` were wrong, and the quadrant-block objects `@8bitscript/graphics` places never appeared. All the named fonts are now 256 codes wide. `examples/media-walk` draws its two objects on the PET and VIC-20 wasm builds, as it does on the real machines.

**Both character sets, and the register that chooses.** The page drew the lower-case set on the VIC-20 where the machine boots in upper case and graphics. It now has each machine's graphics half (generated from VICE's ROM images by `packages/cli/scripts/font-roms.mjs`, pinned by SHA-256) and follows the machine's own register each frame: the PET's VIA control register (`$E84C` bit 1: 12 graphics, 14 text), the VIC-20's memory pointer (`$9005` low nybble: 0 upper case and graphics, 2 lower and upper case). A program that selects a set is drawn in that set, as the video chip would; a raster list's `Slot.CHARSET` still overrides it on the lines it names.

**Measured with `8bs conform`.** The `grid` probe: PET 114 → 0 differing cells, VIC-20 166 → 0 (its colour row still differs in 6 cells in colour only: the page's palette is not xvic's). Two new probes, `charset` and `charset-text`, write every screen code 0–255 raw in each set and match `xpet` and `xvic` in all 1000 and 506 cells, structure and colour. The PET and VIC-20 `limits` lines about reverse video, the character set and graphics objects are gone from `8bs targets --json`.
