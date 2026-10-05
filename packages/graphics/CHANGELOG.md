# @8bitscript/graphics

## 0.25.0

### Minor Changes

- 718c857: The C64 twin's operations are verified under x64sc, and two position bugs they found are fixed. `graphics.place` handed the sprite chip any x it was given: the X register is nine bits, so a stage x of 500 (chip X 524) came out at X 268 in the middle of the picture, and a 16-bit stage y near 65535 plus the playfield's 50-line offset wraps to a small number, which draws in the top border when `sprites.extend(true)` opens it. A sprite that starts at stage x 320 or more, or y 205 or more, is now not drawn, as the contract says an off-playfield position is. Cost on `examples/media-walk` for the C64: 4637 → 4692 bytes of program, 46 of variables. New and C64 only: `graphics.step()`, which advances the animations and nothing else, so a program with raster entries of its own can build its frame (`raster.clear()`, `sprites.plan()`, its `raster.insert()`s, one `raster.commit()`) instead of letting `graphics.update()` clear and commit the list. Measured and documented, no change: eight sprites draw on one raster line (the first eight in slot order, the rest dropped every frame, no flicker); `graphics.update()` wipes raster entries built before it. `hide`, `setFrame`, `animate` and `color` are now verified on screen on the C64 — `color` on a sprite the multiplexer reuses too.
- 29fff5f: `@8bitscript/graphics` on the C64 now holds up to 24 sprites (it silently ignored everything past the eighth), colours each from its PNG, and says when an animation is too long. A `.8bg` sprite takes the VIC-II colour nearest its PNG's most common opaque colour instead of white; an animation longer than 4 frames is cut to 4 with `8BS2111` (it used to overrun the next sprite's shape blocks and truncate the byte index, corrupting the picture). The multiplexer counts only the highest slot a program declared. Past X = 255 a position must be a `usmallint` sum; the C64 notes say why.
- c287f25: `@8bitscript/graphics` on the Commander X16: every call of the portable contract is now real and read off x16emu screenshots — `hide`, `place` after `hide`, `setFrame` (clamped, and while hidden), `animate` pausing one object while another steps, and `color`. `color(slot, c)` now draws the object in machine colour `c` (0–15), and a value from 16 up gives the picture its own colours back; `graphics.RECOLORS` is true on the X16. A position at or past the screen (x ≥ 640 or y ≥ 480) now switches the sprite off instead of wrapping around to the left edge, as the contract says an object off the playfield must. Cost on `media-walk`: 4002 → 4114 bytes of program; a program that uses all four calls adds 481 bytes over one that only places and updates.
- 584b12c: `@8bitscript/graphics` now works on the Commander X16. A `.8bg` sprite becomes a VERA hardware sprite with its own 15-colour palette, any legal size up to 64×64, and real animation frames. The old driver wrote four attribute bytes per sprite where VERA reads eight and never set a depth, so nothing was ever drawn; the media lowering also packed the picture as four 8×8 tiles and used the default palette's colours 1–3 instead of the picture's. `graphics.place(0, 0)` lands on the same pixel as text cell (0, 0) after `screen.blank()`. The probe and the screenshot test are in `packages/cx16/test/graphics.test.mjs`.
- 40d5e91: `@8bitscript/graphics` is now one contract across machines. Every twin — the PET, VIC-20, C64, X16, web and NES ones, and the generic glyph path every other machine uses — answers the same ten constants (`graphics.MAX`, `FRAMES`, `WIDTH`, `HEIGHT`, `COLORS`, `RECOLORS`, `STEP_X`, `STEP_Y`, `RESTORES`, `TRANSPARENT`) with the value that machine honestly has, so a program can fold on what it can do, and exports the same calls: `place`, `update`, and new `hide`, `setFrame`, `animate` and `color`. A call a machine cannot honour is a documented no-op (`color` on the PET, the X16 and the NES, where `RECOLORS` is false); `docs/project/graphics.md` has the per-machine table, and `packages/compiler/test/graphics-contract.test.mjs` builds a probe that reads every constant and calls every operation on all thirty-two targets.
  
  The one behaviour change: `graphics.place` takes **playfield pixels** on every machine, so `place(slot, 0, 0)` lands on text cell (0, 0). The C64 twin now adds the sprite layer's origin (24, 50) itself, so a program no longer writes `sprites.ORIGIN_X +` in front of its positions (the bundled examples, Studio and the C64 probe did; they don't now). A program that already adds the origin by hand on the C64 draws 24 pixels right and 50 down of where it did.
  
  The generic glyph path now plays animations: the default lowering keeps up to four animation steps as one glyph each (it collapsed an animation to its first frame, with `8BS2111`), and `graphics.update()` steps through them at the animation's `every`, as the web twin already did.
- 88b2396: `@8bitscript/graphics` animates on the PET: every frame a `.8bg` animation names becomes its own quadrant-block shape, defined once before `main()`, and `graphics.update()` steps through them at the animation's `every`, as on the C64. The sprite layer's seven shapes are one budget for the whole program, counted across `.8bg` files; the build warns (`8BS2111`) when a picture is cut short or finds none left, and the program shows exactly that. A picture too faint to survive the downsample is now a small centre block rather than a stray solid block, and a picture with transparent pixels takes its shape from them (white pixel art on a clear background is a white shape, as on the C64) instead of losing every bright pixel.
  
  Two compiler fixes that were not PET-only: two `.8bg` files that each held one sprite both claimed slot 0, so one drew as the other (`graphics.place` of the second picture showed the first); slots are now numbered across the whole program. And the media bind functions run in declaration order, not reversed.
- 8d65b3a: Studio opens in the editor's WebAssembly tab, on our own backend, and it renders there.
  
  - **VS Code:** **Open Studio** (the Studio row, the 🚀, **Launch Studio**, **Open Studio in a Tab**) runs `8bs run cx16 --web` in an editor tab: our compiler to wasm and our own model of the X16, not a full-screen native window and not the vendored x16emu. The native emulator is its own labelled button beside the row (**Open Studio in the Native Emulator**, `8bitscript.openStudioNative`), and the vendored x16emu in a tab is **Open Studio in x16emu (in a Tab)** (`8bitscript.openStudioX16emu`). Every old command id still works. The WebAssembly build is the primary way to run a program, which is what `8bitscript.preferWebPreview` already defaulted to; the tab's Editor runtime is the default for a program with no history.
  - **cx16 wasm model:** the colours are VERA's own default palette (blue is `#0000aa`, as x16emu draws it; the C64's `#40318d` was wrong), and a `.8bg` picture is drawn at all — as one 8x8 glyph in the new redefinable glyph table, because the wasm model has no VERA sprites. Studio's mark now shows. `wasm.limits` for the X16 in `8bs targets --json` says what the model still leaves out (VERA layers and sprites, sound, the mouse, the raster list).
  - **Compiler:** a `--web` build of a machine whose package names `"wasmMedia"` lowers pictures with that module (the X16 names the web's).
- 9dfc8ce: `@8bitscript/graphics` on the VIC-20 now honours what a `.8bg` says. The picture is reduced to the ROM's quadrant-block screen codes while the program is built (`packages/vic20/media`), so the machine keeps one byte per cell per frame instead of a 256-byte table and a reduction of its own. An 8×8 sprite is one cell (it used to be four, three of them blank, which erased the text beside it); a larger one is 2×2 cells; an `animation` now steps through its frames (the first 8) every `every` updates (only the first was ever shown); and a picture with almost no ink is one glyph (it used to draw `$51` and three `@`).
  
  Moving an object blanks the cells it left, so there is no trail. Cells past the screen's edge are not drawn, where before an object at the right edge wrapped onto the next row and one at the bottom-right corner on an 8K machine reached `$1210`, inside the program. Text printed under an object is not restored when it moves (documented in `packages/vic20/AGENTS.md`).
  
  The compiler numbered a sprite from 0 within its own `.8bg` file, so two files shared slot 0 on every target — `mark` and `player` in `examples/media-walk` were one object. Sprites are numbered across the whole build now.
- af466c0: The web target has a redefinable character set, and `.8bg` pictures on the web are now real art. Before, a picture was reduced to one of the sixteen 2×2 quadrant blocks (a 16×16 source became four lit-or-dark quadrants). Now the runtime reserves a table of 80 glyphs of eight row bytes in the agreement page, right after the raster list, for the character codes 176–255 — the gap the font leaves, so no table glyph shadows a font glyph. Both the browser page and the headless `--screenshot` rasterizer draw a cell with a code in that range from the table once any of its eight rows is nonzero (bit 0 the leftmost pixel, the order every font here uses), and from the font as before when all are zero, so a program that never writes the table pays nothing and changes nothing. A real machine's own `--web` build (pet, vic20, c64) has no table and its agreement is unchanged; on the Modern host the agreement now ends at 9032 (was 8392) and the program's data starts at 9216 (was 8448). `@8bitscript/web/charset` writes it (`charset.define(code, r0…r7)`, `charset.setRow(code, row, bits)`), refusing a code outside the table or a row past 7. `@8bitscript/web`'s media module lowers each animation step to an 8×8 bitmap at build time (an 8×8 source pixel for pixel, a larger one by area), and `@8bitscript/graphics`' web twin writes those bytes straight into the table and draws the cell, still up to eight pictures of eight steps, with `graphics.color()` tinting the cell's one ink. The portable contract's numbers for the web are unchanged (`MAX` 8, `FRAMES` 8, 8×8, one ink, `STEP` 8, no restore); only the fidelity is. `#fact(video.glyphs)` is 80 on the web (the PET 2001 skin keeps the PET's 0). `examples/media-walk` built for web goes from 1820 to 1956 wasm bytes and from 267 to 203 bytes of RAM (the binder now carries eight bytes a step instead of one; the twin's 64-byte code table is gone). Verified by compiled programs' headless screenshots on the Modern host and the `pet-2001` skin — asymmetric 8×8 art pixel for pixel, a 16×16 picture reduced exactly, an eight-frame animation stepping in order, a paused one holding and resuming, a recoloured one, a hidden one gone and placed again, a moved one leaving no copy, the grid's last cell, a picture below or past the grid drawing nothing — and by the browser loader's compositor painting the same pixels as the rasterizer. Not checked: a real browser tab.
- cad9700: `.8bg` pictures now show, and animate, on the web target. Before, a picture built for the web went through the default glyph lowering, which picks the PETSCII codes 0xA0 and 0x51; the web's font draws only ASCII and the sixteen 2×2 block codes (128–143), so a mostly-filled picture was an empty cell and a mostly-clear one the letter Q, and an animation was collapsed to its first frame. `@8bitscript/web` now ships a media module that samples each animation step at build time into one quadrant-block code (a quadrant is lit at 30% opaque pixels or more; the inkiest one is lit if none reaches that, so a thin picture does not vanish), and `@8bitscript/graphics` has a web twin that plays up to eight steps per picture through the sprites glyph layer, moving on one step every `every` calls to `graphics.update()`. It is a deliberate glyph path rather than a sprite table (a true sprite layer is a later item for the web runtime, behind its redefinable character set); the limits are stated, not hidden: a picture is one cell (a 16×16 source becomes four quadrants), colour is dropped (`8BS2111` says so), at most eight pictures of eight steps, and a moved picture does not restore what it covered. `examples/media-walk` built for web grows from 1610 to 1797 wasm bytes (235 to 259 bytes of RAM). Verified by a compiled `.8bg` program's headless screenshots on the Modern host and the `pet-2001` skin: placement on the named cell, the grid's last cell, a position past the grid drawing and wrapping nothing, a four-frame walk stepping in order, and a `Slot.CHARSET` band leaving pictures alone.

### Patch Changes

- 2c79182: The VIC-20's graphics operations are now verified, and two faults they hid are fixed. `graphics.hide`, `setFrame`, `animate` and `color` had only been linked on the VIC-20; each is now run for real, cell by cell without an emulator (the twin imported into a web-target program whose wasm runs in node, reading the VIC-20's screen and color RAM back exactly, on the unexpanded and the 8K map; CI runs it, and each of ten deliberate breakages of the twin fails its check) and under xvic by pixel. The faults: `color(slot, c)` stored `c` unmasked, so `color(slot, 9)` set color RAM bit 3 — the multicolor switch — and drew the object's cells as multicolor garbage; it now masks to three bits (8–15 wrap to 0–7, as `text.putColor` does). And the cells an object left when it moved or hid were blanked but kept the object's ink in color RAM, so a character stored there later with `text.putChar` (which writes no color) came out in it; blanking now sets color RAM back to white. The two cost 22 bytes of program (`examples/media-walk` on the VIC-20: 2493 to 2515, the same 48 bytes of RAM). Also: each sprite's `8BS2111` note now says how many of the 64 pool bytes every object shares it takes ("taking 12 of the 64 pool bytes every object shares; one that does not fit is not drawn"), because the build cannot add the sprites up and an object that does not fit simply is not drawn; the pool's behaviour at its edge is pinned (32 + 32 bytes fit exactly, one more does not, every call on the dropped object does nothing, and no other object or table is touched). Not verified: PAL, the 3K and 16K/24K layouts, real hardware.
- Updated dependencies [179c3f6]
- Updated dependencies [a45bd03]
- Updated dependencies [0e0e928]
- Updated dependencies [29fff5f]
- Updated dependencies [4f425e1]
- Updated dependencies [ecb49c6]
- Updated dependencies [4f425e1]
- Updated dependencies [4a646ff]
- Updated dependencies [584b12c]
- Updated dependencies [b4bd7cd]
- Updated dependencies [8927961]
- Updated dependencies [40d5e91]
- Updated dependencies [7a866bc]
- Updated dependencies [88b2396]
- Updated dependencies [5065779]
- Updated dependencies [8d65b3a]
- Updated dependencies [52e8dee]
- Updated dependencies [17e8aac]
- Updated dependencies [2c79182]
- Updated dependencies [9dfc8ce]
- Updated dependencies [b591243]
- Updated dependencies [55bd004]
- Updated dependencies [b2cb568]
- Updated dependencies [6e1ca7a]
- Updated dependencies [af466c0]
- Updated dependencies [cad9700]
  - @8bitscript/cx16@0.25.0
  - @8bitscript/web@0.25.0
  - @8bitscript/c64@0.25.0
  - @8bitscript/pet@0.25.0
  - @8bitscript/nes@0.25.0
  - @8bitscript/vic20@0.25.0
  - @8bitscript/sprites@0.25.0
  - @8bitscript/system@0.25.0

## 0.23.2

### Patch Changes

- 5a21549: Fix VIC-20 programs destroying themselves when they carry a graphics object.
  
  `@8bitscript/graphics`'s VIC-20 implementation wrote its glyphs into a RAM character set at `$1400`. That address is inside the program: a `.prg` loads at `$1001` on the unexpanded machine and `$1201` on an expanded one, so anything big enough to reach `$1400` — hello-world is 1922 bytes, which reaches it either way — had its own code overwritten as the glyphs went down. Measured under xvic, the fourth glyph byte turned a `LDA $1451,Y` into `LDA $7E00,Y`; execution fell through the data that followed into a `BRK`, and the KERNAL warm-started, which is why the greeting vanished and a bare `READY.` came back on a cleared screen.
  
  `packages/vic20/AGENTS.md` had already written down the rule this broke: the linker owns memory from the load address upward and nothing checks for an overlap, so a RAM charset is a reservation the package must make, never a free choice of address.
  
  Two further things were wrong with the same code. Nothing ever pointed the VIC at that character set — `$9005` was only ever set to the ROM font at `$8000` — so the glyphs were written somewhere the video chip does not read; and `writeGlyph` ignored its own `slot`, so all eight objects shared one set of four characters.
  
  An object is now drawn with the ROM's sixteen quadrant-block characters, the way `@8bitscript/pet` draws one: each of its four cells becomes the block that describes that corner of its bitmap, so a 16×16 object renders at 4×4 pseudo-pixels. That costs no RAM, needs no character set and no reservation, and it is the first time the object has actually been visible on this machine. The block codes were measured against the VIC-20's own character ROM rather than inherited from the PET's table.
- Updated dependencies [e80d067]
- Updated dependencies [daac931]
- Updated dependencies [0ff97c3]
- Updated dependencies [3824070]
- Updated dependencies [e80d067]
- Updated dependencies [4376f27]
- Updated dependencies [8a309f5]
- Updated dependencies [5a21549]
- Updated dependencies [e80d067]
- Updated dependencies [a988417]
  - @8bitscript/c64@0.24.0
  - @8bitscript/pet@0.24.0
  - @8bitscript/vic20@0.24.0
  - @8bitscript/cx16@0.24.0
  - @8bitscript/sprites@0.24.0
  - @8bitscript/nes@0.24.0
  - @8bitscript/system@0.24.0

## 0.23.1

### Patch Changes

- @8bitscript/c64@0.23.1
  - @8bitscript/cx16@0.23.1
  - @8bitscript/nes@0.23.1
  - @8bitscript/pet@0.23.1
  - @8bitscript/sprites@0.23.1
  - @8bitscript/system@0.23.1
  - @8bitscript/vic20@0.23.1

## 0.23.0

### Minor Changes

- 499c62d: Add a portable graphics and audio slice: `.8bg` / `.8ba` front ends, PNG and WAV/FLAC host tools, machine-owned lowering on C64, NES, PET, and Atari 8-bit with a glyph/no-driver fallback everywhere else, and a dogfood example that builds for every machine.

### Patch Changes

- 7232d3f: Widen VIC-20 zero-page to the owned budget when a linked program calls `screen.blank()`, so title screens and media clears link without overrunning the polite KERNAL window.
- Updated dependencies [499c62d]
- Updated dependencies [499c62d]
- Updated dependencies [499c62d]
  - @8bitscript/pet@0.23.0
  - @8bitscript/c64@0.23.0
  - @8bitscript/vic20@0.23.0
  - @8bitscript/cx16@0.23.0
  - @8bitscript/nes@0.23.0
  - @8bitscript/system@0.23.0
  - @8bitscript/sprites@0.23.0
