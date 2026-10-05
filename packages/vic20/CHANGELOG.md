# @8bitscript/vic20

## 0.25.0

### Minor Changes

- 5065779: `raster.frame()` and `raster.FRAME_COUNTER`: a count of video frames since `enable()`, wrapping at 256, so a raster effect can step once per frame however long the game loop takes. It counts on the C64 (the handler's line-0 pass) and the X16 (the end of each pass over the planned lines): 6 and 8 more bytes in a program that uses the raster list. Every other rasterline file answers `FRAME_COUNTER` false and `frame()` 0 — the VIC-20 and the PET run no interrupt, and the web host runs one logical frame per `waitFrame()` and never skips one — at no cost to a program that does not call it.
- 52e8dee: A program is now a unit an editor can run on its own, with its own settings. Three pieces make the contract:
  
  **`#define("NAME", default)`** is a value the build is handed — a seed, a flag, a starting amount — with the default written where it is read, so a plain build, `8bs check` and the editor never lack one. `8bs run c64 --program slot5x5 --define SEED=42 --define FORCE_BONUS=true` (repeatable) replaces it for one build, and a `define: { SEED: 42 }` under a program in `8bitscript.config.8bs` does so on every build of it; the command line wins over the config, the config over the default. It folds to a literal, so a different value is a different build and a program that reads none is byte-identical (15 example builds on pet, c64, vic20, cx16 and web measured the same). The name is in capitals; the default is a whole number, `true`/`false`, or a string (`8BS1047`); a value of the wrong kind is `8BS1048`; one name with two defaults in one program is `8BS1049`. A `--define` for a name the program never reads is an error naming the nearest name it does read, and a config `define` nothing reads is a warning. `8bs check` takes `--define` too, and a build records what its defines came to in `dist/.8bs-last-<target>.json`. Hover, completion, a `#define` snippet and the docs are updated.
  
  **`8bs project [--json]`** describes the project with the CLI's own loader instead of a regular expression over the config: its programs — with the new display keys `title`, `description` and `group`, the machines each builds for, and the `#define` names each reads with the defaults found in its source by the compiler — its targets, locales and named systems, and anything wrong with them as `problems` rather than a failure. Exit 0 when described, 1 when a config exists and will not load. The shape is in `docs/project/units.md`.
  
  **`8bs targets --json` says how each machine can be run**: a `runtime` object with `native` (the emulator and whether it is installed), `wasm` (the machine's own package through the wasm backend, in a page), `wasmEmulator` (cx16's real x16emu as WebAssembly) and `boot` (the bare machine), each with `available` and, when not, a `reason`. The wasm claim is declared by each machine package (`emulator.wasm`) and held to the truth by a test that builds every one: the PET, VIC-20, X16 and web build through the wasm backend; the C64 does not yet (the wasm backend does not lower an array pinned at a fixed address, `screenRam`). An editor no longer needs a hand-kept list of which machines can preview in a page.
  
  `8bs run`'s usage now documents `--web`, `--x16emu`, `--locale` and `--define`.
- 17e8aac: `@8bitscript/raster` on the VIC-20 now answers `Slot.CHARSET`: `raster.CHARSET` is true, and an entry switches `$9005` between the upper-case/graphics ROM set (0) and the mixed-case set (1) at any picture line, mid-row included, keeping the build's own screen base. The store lands in the border between the two lines on both regions (measured windows in `packages/vic20/AGENTS.md`), the colour splits' timing is unchanged, and a list without CHARSET entries never changes `$9005`.
- 9dfc8ce: `@8bitscript/graphics` on the VIC-20 now honours what a `.8bg` says. The picture is reduced to the ROM's quadrant-block screen codes while the program is built (`packages/vic20/media`), so the machine keeps one byte per cell per frame instead of a 256-byte table and a reduction of its own. An 8×8 sprite is one cell (it used to be four, three of them blank, which erased the text beside it); a larger one is 2×2 cells; an `animation` now steps through its frames (the first 8) every `every` updates (only the first was ever shown); and a picture with almost no ink is one glyph (it used to draw `$51` and three `@`).
  
  Moving an object blanks the cells it left, so there is no trail. Cells past the screen's edge are not drawn, where before an object at the right edge wrapped onto the next row and one at the bottom-right corner on an 8K machine reached `$1210`, inside the program. Text printed under an object is not restored when it moves (documented in `packages/vic20/AGENTS.md`).
  
  The compiler numbered a sprite from 0 within its own `.8bg` file, so two files shared slot 0 on every target — `mark` and `player` in `examples/media-walk` were one object. Sprites are numbered across the whole build now.
- b591243: The VIC-20's portable raster list now builds and runs on its wasm build. `examples/fancy`
  and any program that imports `@8bitscript/raster` build with `8bs build --target vic20
  --web` (they failed on the frame hook's machine code), and the page applies each
  `BORDER`, `BACKGROUND` and `CHARSET` entry at its picture line. The page also reads the
  VIC-20's border and background from `$900F`, as the chip does. New: `8bs conform vic20
  --program bands` compares where each band starts against xvic (every band starts on the
  same line).

### Patch Changes

- 2c79182: The VIC-20's graphics operations are now verified, and two faults they hid are fixed. `graphics.hide`, `setFrame`, `animate` and `color` had only been linked on the VIC-20; each is now run for real, cell by cell without an emulator (the twin imported into a web-target program whose wasm runs in node, reading the VIC-20's screen and color RAM back exactly, on the unexpanded and the 8K map; CI runs it, and each of ten deliberate breakages of the twin fails its check) and under xvic by pixel. The faults: `color(slot, c)` stored `c` unmasked, so `color(slot, 9)` set color RAM bit 3 — the multicolor switch — and drew the object's cells as multicolor garbage; it now masks to three bits (8–15 wrap to 0–7, as `text.putColor` does). And the cells an object left when it moved or hid were blanked but kept the object's ink in color RAM, so a character stored there later with `text.putChar` (which writes no color) came out in it; blanking now sets color RAM back to white. The two cost 22 bytes of program (`examples/media-walk` on the VIC-20: 2493 to 2515, the same 48 bytes of RAM). Also: each sprite's `8BS2111` note now says how many of the 64 pool bytes every object shares it takes ("taking 12 of the 64 pool bytes every object shares; one that does not fit is not drawn"), because the build cannot add the sprites up and an object that does not fit simply is not drawn; the pool's behaviour at its edge is pinned (32 + 32 bytes fit exactly, one more does not, every call on the dropped object does nothing, and no other object or table is touched). Not verified: PAL, the 3K and 16K/24K layouts, real hardware.
- 55bd004: WASM is the primary runtime, and now there is a way to measure whether it is telling the truth.
  
  **`8bs conform` compares a machine's wasm build with the real machine.** For `pet`, `vic20`, `c64` and `cx16` it builds a probe program through the native emulator and through the wasm backend, captures one frame of each and compares them cell by cell: a wrong glyph is a *structure* difference and fails (exit 1), a different ink colour is a *colour* difference and warns (`--strict-colour` fails it). The probe's four solid corner cells locate the picture in each capture, so there is no table of where each emulator keeps its border. It writes the two captures and a diff image (native, wasm, and the differing cells in red and amber) and a JSON report. The first run found: the C64 matches x64sc in all 1000 cells (its palette differs); the PET is missing reverse video (114 cells); the VIC-20 the same plus the wrong boot character set (166 cells); the X16 draws the ASCII ramp in the host font, not its ISO character ROM (186 cells). Each machine package's `test/conform.test.mjs` pins its number, which can only go down. `docs/project/wasm-primary.md` has the policy, the audit of every example, Studio and the Vegas Nights slots on the five release machines, the parity matrix and the backlog.
  
  **A web bundle for tagged hardware could not load itself.** `8bs build --target vic20 --web` (the VIC-20 with 8K, the release hardware, tag `expanded`) wrote `program-expanded.wasm` and `program-expanded.json`, and `index.html` and `embed.html` still asked for `program.wasm`: on a clean directory the only file the page needs was a 404. The pages now name the file the bundle wrote.
  
  **The wasm capability rows no longer claim nothing is missing.** `8bs targets --json` reported `limits: []` for the PET, VIC-20 and X16, while the audit found reverse video undrawn on the PET and VIC-20, the portable `@8bitscript/raster` and `@8bitscript/input` failing to build for the wasm backend on the VIC-20 and X16 (`raster_probeRegion`, `raster_commit`, `input_poll` are machine code), `@8bitscript/graphics` objects compiling and drawing nothing on the PET, VIC-20 and X16, and no sound on any of them. They are limits now (the X16 already listed most of its own after the Studio change; this adds the input gap and the x16emu fallback), and the editor shows them.
  
  The VS Code launcher says what the three buttons are: **Editor** is the primary way to run a program, **Browser** is the page you can share, **Native** is the real emulator, the second opinion on what the WASM build shows.
- b2cb568: The PET and VIC-20 wasm builds draw reverse video and the character set the machine is really in, and `8bs conform` now agrees with the real emulators on every glyph.
  
  **Reverse video.** A screen code with bit 7 set is the same glyph with every pixel inverted on a real PET (the video circuit does it) and on a real VIC-20 (the ROM's reversed copies are exactly that). The wasm page's PET and VIC-20 fonts only had codes 0–127, so codes 128 and up drew as blanks, the corner cells, the reverse ramp and the colour row of `8bs conform` were wrong, and the quadrant-block objects `@8bitscript/graphics` places never appeared. All the named fonts are now 256 codes wide. `examples/media-walk` draws its two objects on the PET and VIC-20 wasm builds, as it does on the real machines.
  
  **Both character sets, and the register that chooses.** The page drew the lower-case set on the VIC-20 where the machine boots in upper case and graphics. It now has each machine's graphics half (generated from VICE's ROM images by `packages/cli/scripts/font-roms.mjs`, pinned by SHA-256) and follows the machine's own register each frame: the PET's VIA control register (`$E84C` bit 1: 12 graphics, 14 text), the VIC-20's memory pointer (`$9005` low nybble: 0 upper case and graphics, 2 lower and upper case). A program that selects a set is drawn in that set, as the video chip would; a raster list's `Slot.CHARSET` still overrides it on the lines it names.
  
  **Measured with `8bs conform`.** The `grid` probe: PET 114 → 0 differing cells, VIC-20 166 → 0 (its colour row still differs in 6 cells in colour only: the page's palette is not xvic's). Two new probes, `charset` and `charset-text`, write every screen code 0–255 raw in each set and match `xpet` and `xvic` in all 1000 and 506 cells, structure and colour. The PET and VIC-20 `limits` lines about reverse video, the character set and graphics objects are gone from `8bs targets --json`.

## 0.24.0

### Minor Changes

- a988417: The VIC-20 answers `#fact(video.raster)`: `@8bitscript/raster`'s `Slot.BORDER` and `Slot.BACKGROUND` split at any picture line, on NTSC and PAL, each split landing on its exact line and whole — the line above entirely in the old colors, the target entirely in the new — and still from frame to frame. The VIC raises no interrupt, so the frame runtime applies the list: `FRAME_SYNC.vic20.frameHook` names `vic20RasterFrame`, which `waitFrame()` calls after every frame edge. It re-syncs on `$9004` and the `$9003` bit-7 edge before every planned line and writes `$900F` twice — the border half inside the picture of the line above, the background half in the border after it — with per-region delays measured under xvic and no taken branch between the edge and either store. `commit()` works everything else out ahead of time (picture line to raster line through `$9001`, the pair to poll, the parity, same-line merging, both stores' bytes), and the list and plan live in the cassette buffer. A list built once and `enable()`d shows every frame; `setValue` is live without a commit. Entries closer than two lines are planned two lines apart; `Slot.SCROLL_X` is refused. What it costs is written down in `packages/vic20/AGENTS.md` ("Raster splits"): the frame belongs to the hook until the last planned line, and the layer is about 850 bytes (`examples/fancy` on the 8K build, 2803 → 3654).
  
  The pruner keeps a machine's frame hook — which no program calls — when, and only when, a reachable function shares a global with it (`pruneUnreachable(ir, { frameHook })`, `frameHookWanted`), so a program that imports `@8bitscript/raster` and never commits a list, or whose raster branch a `#fact` folds away, is byte-identical to one without it. Frame hooks now work on level-kind machines as well as edge-kind ones.
  
  Every rasterline layer gains `raster.FINE_SCROLL` — whether `Slot.SCROLL_X` entries are taken (true on the C64 and the web, false on the VIC-20 and in every stub) — so a wobble can fold away where only splits exist. `examples/fancy` uses it: the VIC-20 shows the colour bands without the wobble. `packages/vic20/AGENTS.md` also corrects a stale claim: a VIC-20 program that calls `waitFrame()` runs with interrupts off from start-up.

### Patch Changes

- daac931: A new portable package, `@8bitscript/color`, for the C64 demoscene's "more than 16 colours" trick: `color.blend(slot, a, b)` alternates a border or background color between two palette indices once a frame, riding on `@8bitscript/raster`'s own list, so a CRT's phosphor persistence blends them into a shade neither shows alone. Real on the C64; an honest, documented no-op on the PET (no color chip), the VIC-20 (the technique is unconfirmed on real hardware, not disproven — left unimplemented rather than assumed), the CX16 (VERA's 256-entry software palette makes the trick unnecessary — define the color directly instead), and the web (no CRT persistence to exploit, so alternating a color there would be visible flicker, not a blend). Gated by a new build-time fact, `#fact(video.colorBlend)`, filled in across every machine catalog (true only for the C64).
- 5a21549: Fix VIC-20 programs destroying themselves when they carry a graphics object.
  
  `@8bitscript/graphics`'s VIC-20 implementation wrote its glyphs into a RAM character set at `$1400`. That address is inside the program: a `.prg` loads at `$1001` on the unexpanded machine and `$1201` on an expanded one, so anything big enough to reach `$1400` — hello-world is 1922 bytes, which reaches it either way — had its own code overwritten as the glyphs went down. Measured under xvic, the fourth glyph byte turned a `LDA $1451,Y` into `LDA $7E00,Y`; execution fell through the data that followed into a `BRK`, and the KERNAL warm-started, which is why the greeting vanished and a bare `READY.` came back on a cleared screen.
  
  `packages/vic20/AGENTS.md` had already written down the rule this broke: the linker owns memory from the load address upward and nothing checks for an overlap, so a RAM charset is a reservation the package must make, never a free choice of address.
  
  Two further things were wrong with the same code. Nothing ever pointed the VIC at that character set — `$9005` was only ever set to the ROM font at `$8000` — so the glyphs were written somewhere the video chip does not read; and `writeGlyph` ignored its own `slot`, so all eight objects shared one set of four characters.
  
  An object is now drawn with the ROM's sixteen quadrant-block characters, the way `@8bitscript/pet` draws one: each of its four cells becomes the block that describes that corner of its bitmap, so a 16×16 object renders at 4×4 pseudo-pixels. That costs no RAM, needs no character set and no reservation, and it is the first time the object has actually been visible on this machine. The block codes were measured against the VIC-20's own character ROM rather than inherited from the PET's table.
- e80d067: The VIC-20's catalog offers only hardware something in this repository can actually drive: its `mouse1351` and its `drive` are gone.
  
  Both were the C64 drive's case over again — an option VICE accepts, a fact it moved, and no code anywhere that could act on the result.
  
  `port1: mouse1351` set `input.mouse: true`, and `packages/vic20/src/pointer.8bs` had already written down why that was empty: "this repository has no 1351 driver for the VIC-20... there is nothing to draw and nowhere to draw it from, in that order." It is not a driver waiting to be ported, either. A 1351 on a C64 is read by the SID's pot lines; the VIC-20 has no SID, so one here would have to be read through the VIC's own analogue inputs at `$9008`/`$9009` — a different driver nobody has written or measured, and `packages/vic20/AGENTS.md` still marks the 1351 on this machine *to verify* on real hardware. The port now offers nothing, a joystick, or paddles, which is what the machine does.
  
  `drive` moved `storage.save` and `storage.kib` and passed `xvic` nothing, exactly as the C64's did. Nothing in this repository saves anything yet — no package calls a KERNAL save, no `.8bs` surface offers one — so it graded builds against a medium that was never attached.
  
  The stock sheet keeps `storage.save: true` and `storage.kib: 164`: a VIC-20 with a 1541 is a fair assumption for a program to make. What is gone is the choice, and the two facts that were set by nothing.
  
  Both come back with their drivers. The comments in `input.8bs`, `pointer.8bs` and `AGENTS.md` that described the removed options now describe their absence and the reason for it.

## 0.23.1

No changes in this release.

## 0.23.0

### Minor Changes

- 499c62d: Narrow `RELEASE_MACHINES` to five targets — `pet`, `vic20`, `c64`, `cx16`, and `web` — so `8bs build` and `8bs run`, examples, Studio, and the editor launcher focus on a polished slice. Every other id stays in `MACHINES` for twins, facts, and `8bs check`; hello-world still compiles. Restoring the original nine and the remaining roadmap machines to `RELEASE_MACHINES` is planned in a follow-up (see `.changeset/remaining-systems.md` for the wider emulator and package work).

## 0.22.1

No changes in this release.

## 0.22.0

No changes in this release.

## 0.21.0

No changes in this release.

## 0.20.0

No changes in this release.

## 0.19.1

No changes in this release.

## 0.19.0

No changes in this release.

## 0.18.0

### Minor Changes

- 63b1906: The frame, across nine machines (docs/project/frame.md): `@8bitscript/sprites` — moving objects on every target, hardware sprites reused down the frame on the C64 (up to twenty-four, and through the opened border with `extend(true)`), quadrant-block objects on the PET (eight, at 4-pixel steps, merging with block graphics and restoring what they cover from the screen — `defineShape` in the PET twin), a glyph per sprite on the character grid elsewhere; positions are sixteen bits both ways, and the consts a program folds on are `MAX`, `PER_LINE`, `WIDTH`, `HEIGHT`, `STEP_X`, `STEP_Y`, `RESTORES`, `EXTENDS` (docs/project/sprites.md); `@8bitscript/timeline` — frame-counted cues, pure; `@8bitscript/raster` grows `commit()`, `insert()` and `STRIDE` on all nine twins. `examples/swarm` shows them as one program with a `.8bx` scene. The C64's raster handler now writes the frame table at line 0 rather than 255 (a sprite reused into the opened lower border drew its last rows with the next frame's X); `@8bitscript/c64/raster` gains `setFrameSprite`, `setFrameHeader`, `spriteEntries`, `lastEntryLine` and `shareBuild`/`takeBuild`; and `@8bitscript/c64/multiplex`'s `update()` is native assembly (`native/6502/multiplex.s`, its tables in page $06) — ~9,500 cycles a frame for sixteen sprites where the compiled body was ~16,000, so the swarm runs at one hardware frame an iteration on the C64.

## 0.17.0

No changes in this release.

## 0.16.0

No changes in this release.

## 0.15.0

### Patch Changes

- 758765d: Add project message catalogs (`src/i18n/<locale>.8bs`, imported as `@8bitscript/i18n/catalog`), compile-time `i18n.format`, Latin transliteration into the portable set, and `Input.CONFIRM_LABEL` on each machine's input layer. One locale still means one binary; projects without catalogs are unchanged.

## 0.14.0

No changes in this release.

## 0.13.1

No changes in this release.

## 0.13.0

No changes in this release.

## 0.12.0

No changes in this release.

## 0.11.0

No changes in this release.

## 0.10.2

### Patch Changes

- 2288987: `@8bitscript/text`'s portable surface gets a new `releaseCursor()`:
  `text.print()`/`screen.blank()` write straight into screen memory on
  every Commodore target, which the KERNAL's own cursor tracking never
  sees, so `READY.` used to print wherever the boot/LOAD/RUN echo had left
  the cursor — a different number of blank lines on every machine, with no
  relation to what the program actually drew.
  
  VIC-20, C128 and MEGA65 now call KERNAL PLOT ($FFF0) to park the cursor
  explicitly, giving a consistent, deterministic one blank line between a
  program's last output and `READY.` (measured under xvic/x128/xmega65).
  PET, C64 and CX16 stay honest no-ops for now — PET's ROM predates PLOT
  and a direct zero-page poke didn't move `READY.` in testing; C64 banks
  the KERNAL out permanently so main() never really returns to it; CX16's
  text grid is inset from the KERNAL's own screen coordinates and is
  already correct by accident, which a naive PLOT call risked breaking.
  Atari 8-bit, NES and the web target were already honest no-ops, since
  none of them return to a BASIC prompt.
  
  `packages/examples/hello-world`'s entry file is renamed from `main.8bs`
  to `hello-world.8bs` (and calls `text.releaseCursor()` after printing),
  matching the project's own name rather than the generic default.

## 0.10.1

No changes in this release.

## 0.10.0

No changes in this release.

## 0.9.1

No changes in this release.

## 0.9.0

No changes in this release.

## 0.8.0

No changes in this release.

## 0.7.1

No changes in this release.

## 0.7.0

### Minor Changes

- ea88a5d: A grid that follows the window, on the web target's Modern host only.
  
  Modern is 8BitScript's own invention — no chip to be faithful to, so the grid
  was always a decision — and it now changes shape while a program runs: 48×27
  in a landscape window, 27×48 in a portrait one, 42×31 at 4:3, from one .wasm
  and without restarting the program. Every machine skin is untouched: a C64 is
  40×25 because a C64 is 40×25.
  
  Two new pieces of portable API, both of which fold to constants on a machine
  whose grid cannot change — a PET 2001 image built against them is byte-for-byte
  identical to one written the old way:
  
    - `text.columns()` / `text.rows()` — the live grid
    - `screen.RESIZABLE` / `screen.resized()` — whether it can change, and
      whether it just did
  
  (`text.fill()`, which a derived layout also needs, ships separately.)
  
  Two bugs found while building it, both in the web target:
  
    - `screen.blank()` left the color bytes alone. Reverse video rides in bit 7
      of the color byte here, and the host paints a reverse cell as a solid
      block whatever the character is — so a "blank" screen kept every reverse
      block that had been on it.
    - `Video.cells()` multiplied two `utinyint`s. On a 27×48 grid that product
      is 1296, which does not fit, so `blank()` cleared 16 cells instead of all
      of them.
- e6c4938: `text.fill(cell, count, code)` — the run `print()` cannot write.
  
  `print()` takes a string, and a string is a constant: its width is decided
  when the program is compiled. That is fine for every layout whose shape is
  known at build time, which until now was all of them.
  
  A layout that responds to the screen it is on does not know its widths until
  it runs, and "a row of N blanks" stops being expressible — you would need one
  string constant per width the thing might ever have.
  
  `fill()` is what `print()` would be if a string of that width could be built
  at run time: same current colour, same reverse bit, same cells. Each machine's
  copy follows that machine's own `print()` — `place()` where there is one, and
  the VERA/PPU address walk on the X16 and NES, where the next row is not the
  next address.

## 0.6.2

No changes in this release.

## 0.6.1

No changes in this release.

## 0.6.0

### Patch Changes

- cc04ede: Hello World runs on the C64 and the VIC-20, and reads as `Hello World` on both.
  
  **A constant added to an index folds into the address.** `screenRam[i + 250] = 32` — the second quarter of the C64 and VIC-20 screen-clearing loops — was computing `i + 250` in an 8-bit register and indexing with the result. The sum wraps at 255, so from `i = 6` on every iteration wrote back over the first quarter and the rest of the screen was never cleared: a real miscompile, visible as a screen full of uncleared garbage. The 6502's answer is the other association, `STA base+250,Y`, which is exact for every index Y can hold and is what those loops were written in terms of all along ("four constant offsets off one 8-bit index is the shape a 6502 wants"). It is also smaller and faster: C64 hello-world went from 481 bytes to 424.
  
  **The C64 and VIC-20 text packages draw in the mixed-case character set.** They selected the upper-case/graphics set and mapped only 64-95, leaving lower case at 97-122 — which in that set are graphics symbols, so `"Hello World"` drew as `H`, a graphic, three graphics, a space, `W`… Both ROMs were measured directly (`chargen-901225-01.bin`, `chargen-901460-03.bin`): the mixed-case set holds lower case at 1-26 and upper case at its own 65-90, exactly as the PET's does, and in the 96-127 block the two sets differ only at 105 and 122, which no block-graphics code uses. This is the same decision `@8bitscript/pet` took, for the same reason: it is the only set holding both cases, so it is the only one that can draw a string as it was written.
  
  **The VIC-20's hardware sheet carries its load address and RAM ceiling**, because a RAM expansion moves both: `$1001` unexpanded, `$0401` with the 3K (which fills `$0400-$0FFF`), `$1201` with 8K and up (the screen drops to `$1000`). Each is checked against the catalog's own `memory.ram` fact. `__ram_ceiling` joins `__ram_size` as a spelling of the linker's ceiling, for machines whose usable RAM does not end on a whole number of KiB — unexpanded, the VIC-20's ends at `$1E00`, which is 7.5.
  
  **Zero-page budgets for both.** The VIC-20 keeps a real polite shape and uses it: hello-world is 232 bytes and 4 zero-page bytes, and returns to a working BASIC. The C64 has no polite shape to keep — `setupVideo()` banks the KERNAL out and keeps it out, because the screen it sets up lives at `$E000` under the KERNAL ROM, so a C64 program that draws has already taken the machine — and takes the whole page.
  
  Measured under x64sc and xvic: both show `Hello World!`. The PET is unchanged at 108/108/127 bytes.
- 188cd63: Each machine's hardware catalog now says what a controller **carries**, not just how many ports it has — and a controller's *kind* is derived from that list rather than written down beside it.
  
  `input.joysticks: 2` and `input.pads: 2` count ports. They cannot be projected onto a real control list, because two machines with two pad ports each can take entirely different pads: the NES's eight bits and the X16's twelve are both "2". So the editor's Controller Setup panel kept two tables of its own — what each kind of device carries, and which pad each machine takes — and its own comment said it should not have to. Those tables are gone.
  
  **The new fact is `input.controls`**: the logical controls, in 8BitScript's own names, that the controller on this machine's ports actually carries.
  
  | machine | declares | derived kind |
  |---|---|---|
  | PET | — | none |
  | VIC-20 | `up down left right a` | `atari-stick` |
  | C64 | `up down left right a` | `atari-stick` |
  | C128 | `up down left right a` | `atari-stick` |
  | Atari 8-bit | `up down left right a` | `atari-stick` |
  | MEGA65 | `up down left right a` | `atari-stick` |
  | NES | `a b select start up down left right` | `nes-pad` |
  | Commander X16 | `up down left right a b x y l r start select` | `snes-pad` |
  | web | — | none |
  
  Every row is the repository's own research, not recall. `packages/c64/src/joystick.8bs` declares `Joystick.UP`/`DOWN`/`LEFT`/`RIGHT`/`FIRE` — five switches shorting to ground, the whole of the nine-pin Atari standard; `packages/vic20/AGENTS.md` traces the VIC-20's same five lines across two VIAs (right is VIA2 port B bit 7, a keyboard-column line); `packages/atari8/AGENTS.md` records that the Atari's own masks are bit for bit the C64's with `JOY_BTN_1_MASK` the only button, which is why `@8bitscript/atari8/joystick` can export the same values without either machine being fudged; `packages/c128/AGENTS.md` and `packages/mega65/AGENTS.md` both say CIA1 as the C64's. `packages/nes/src/pad.8bs` names the shift register's fixed order — A, B, SELECT, START, UP, DOWN, LEFT, RIGHT — and the catalog lists them in that order for that reason. The one button on a stick is `a` rather than `b`: it is the only button the machine has, and `a` is the one control every wider shape has in common.
  
  **The X16 is the machine this branch could not fully establish.** `packages/cx16/AGENTS.md` settles that it has two SNES pad ports (and that the KERNAL's reader for them is confusingly called `joystick_get`, `$FF56`). The twelve controls are the SNES pad's own set. What this repository does *not* carry is the bit layout `joystick_get` returns, and nothing here invents one — `packages/cx16/src/input.8bs` is still an honest stub that reads neither the pads nor the keyboard. The catalog says what the ports hold; it does not yet say what order the bits arrive in.
  
  **A kind is derived, never declared.** Nothing in a catalog spells `nes-pad`. `CONTROLLER_KINDS` in `packages/compiler/src/fold/facts.mjs` names four shapes and the exact set of controls each one is — `atari-stick` (5), `nes-pad` (8), `snes-pad` (12), `xbox-style` (all 18) — and `controllerKind(controls)` matches a machine's list against them. A name stored beside the shape it names is two statements that can disagree, and the one that can be checked would lose to the one that cannot. It also means a machine added tomorrow whose controller happens to be an Atari stick is recognised as one without a line of code changing at either end, which is the point. Matching is exact set equality rather than a subset ladder: a two-button stick clears the bar for `a` and `b` and is still not an NES pad, and a shape that matches nothing is `null` rather than the nearest guess.
  
  `xbox-style` is in the table and no machine carries it. It is the shape of the *host* pad this project develops against — the 8BitDo SN30 Pro in X-input mode that `docs/project/input.md` names as the development standard — and it is the superset the other three are projected out of, so naming it costs nothing and leaves the ladder complete.
  
  **Where it lives in a catalog matters.** The Commodores declare it on the `joystick` *value* of `port1`/`port2`, because on those machines what is in the port is a choice: `--hardware port1=none,port2=none` really does resolve to no controls, and the panel says so instead of drawing five controls onto an empty port. It is deliberately *absent* from `none`, `paddles` and `mouse1351` rather than empty on them — option values merge in catalog order, so a `[]` on port 2's `none` would erase the stick port 1 really has. Paddles and a 1351 already have their own facts. The machines whose pads have no option behind them — the Atari, the MEGA65, the NES, the X16 — declare it at machine level, and the PET and the web target declare nothing, out loud.
  
  **`input.controls` is the first fact that is a list**, which needed two things of the compiler. `factProblems` now checks that a catalog's list is an array of real control names and says which one is wrong, because a typo there is a control that silently never projects. And `#fact(input.controls)` is refused by name: there is no literal to fold a list into, and folding one would have handed the IR an array where an integer goes — a miscompile rather than an error. It is `program: false` for the same reason, so it is off `@8bitscript/system` and off a program's sheet; the editor and `8bs targets --json` read it, a program asks its input layer.
  
  The eighteen control names now have an owner. They were spelled out in three places — the compiler had none, the CLI's `controllers.mjs` and the editor's panel had one each. `LOGICAL_CONTROLS` in the compiler is the list a catalog is validated against, and the other two copies are held equal to it by tests: the CLI's directly, the editor's through the same import its own test makes, because the extension has no dependencies at all and can only ever see this as JSON.
  
  **What the editor deleted.** `DEVICE_CONTROLS` and `PAD_KINDS` in `editors/vscode/src/controllerProfile.cjs`. `project()` reads `input.controls` off the resolved fact sheet it was already being handed, and derives the kind from the shapes the toolchain publishes on the `input.controls` fact's own description — which is where a table that is the *vocabulary* belongs, rather than on any one machine's sheet. A toolchain too old to publish the shapes still gets the right controls, only without a name for them; a machine with ports and nothing said about what is in them gets a sentence rather than an invented pad.
- 188cd63: `input.begin()` primes the edge detector, so a control already held when a program starts is no longer reported as a fresh press.
  
  Every machine's input layer keeps `before` (what was held at the previous poll) and reports an edge as "held now, not held before". `before` started at zero, so on the very first `poll()` anything already down looked like it had just been pressed — on all nine machines, since they all share the shape.
  
  Found by the new `joystick` example, which counts every press it is handed: on the MEGA65 it read `SEEN 00001` at start-up with nothing touched, at every frame count from 300 to 2400, while the C64, C128 and VIC-20 read `00000`. A scratch probe reading CIA1 directly on the first frame showed why — RETURN down (`$02`), stick clear — so it was a real key, really held, really reported as a press nobody made. `begin()` now takes one poll, so the program's first poll compares against reality.
  
  It costs about 210 bytes per program, because `poll()` gains a second call site and stops being inlined into the loop. 2048 on a stock 4K PET goes from 2413 to 2624 bytes against ~3071 available, and the joystick example fits every machine including the unexpanded VIC-20. Measured after the fix on the MEGA65: `SEEN 00000`, with the frame counter still running.

## 0.5.0

No changes in this release.

## 0.4.1

No changes in this release.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.6

No changes in this release.

## 0.2.5

No changes in this release.

## 0.2.4

No changes in this release.

## 0.2.3

No changes in this release.

## 0.2.2

No changes in this release.

## 0.2.1

No changes in this release.

## 0.2.0

### Minor Changes

- 7e4c24e: Bare Metal: external code-generation toolchains are removed. 8BitScript now carries its own 6502 and WebAssembly backends in `@8bitscript/compiler` (`mos` and `wasm`), which do not yet build any target. The catalog key `build.driver` is renamed `build.startup`. `examples/` is removed.
- d7c558f: 0.2.0 is scoped to the Commodore PET and the web. `8bs build` and `8bs
  run` now refuse the other seven machines (vic20, c64, c128, atari8,
  nes, cx16, mega65) by name; their packages are unchanged and stay in
  the workspace, parked until their native backends land after 0.2.0.
  
  `@8bitscript/examples` is new: `hello-world`, the program both
  backends are built against, shipped with the CLI the way Studio is.
  The VS Code extension lists it by default and reads it from the
  package's own manifest rather than a fixed directory; it also now
  recognizes bun's lockfile alongside pnpm, npm, and yarn.
- 16e92f4: The `mos` and `wasm` backends in `@8bitscript/compiler` now emit for
  real. `8bs build` and `8bs run` work end to end for both 0.2.0 targets:
  `packages/examples/hello-world`, unmodified, builds, runs, and renders
  its own mixed-case "Hello World!" correctly on a real Commodore PET
  (checked against the `xpet` emulator) and in a real browser (checked
  against a real `--screenshot` run and the browser runtime's own
  generated page script). The `wasm` backend gained `&`, `|`, `^`, `<<`,
  and unsigned `>>` as real lowered operators (wasm's native
  `i32.and`/`i32.or`/`i32.xor`/`i32.shl`/`i32.shr_u`), needed once
  `@8bitscript/web/screen`'s own color masking (`value & 15`) became the
  first real caller. The web target's own text rendering (both the real
  browser canvas and the `--screenshot` bitmap font) now covers lower
  case too, matching what the checker's portable character set and the
  PET's own `asciiToScreenCode` have allowed all along — it previously
  covered upper case only, silently drawing every lower-case letter as a
  blank cell.
- a4aa759: Both native backends (`mos` and `wasm`) now compile only what a
  program's entry can actually reach, instead of every function and
  global an import brings along whether it's called or not. Measured on
  the real, unmodified `hello-world` example: the PET build shrank from
  1132 to 835 bytes of program (26% smaller, plus 101 to 49 bytes of
  RAM), and the web build's `.wasm` shrank from 614 to 408 bytes (34%
  smaller) — one `@8bitscript/text` import used to pull in `putChar`,
  `putColor`, `setColor`, `setReverse`, and `printNumber`'s whole
  decimal-digit loop alongside the `print()` a program actually calls.
  No language, API, or output behavior changed — only what nothing ever
  uses is gone.

### Patch Changes

- 57c262f: Normalized spelling in comments, docs, and user-facing strings
  (package descriptions, editor hover/grammar text, diagnostic prose) to
  match the spelling the code's own identifiers already use — `color`
  not `colour`, `behavior` not `behaviour`, `initialize`/`optimize`/
  `recognize` rather than `-ise`, and a handful of one-off words. No
  behavior, API, or identifier changed; this is text only. The `GREY`
  constant (`BorderColor.GREY`, `BackgroundColor.GREY`) and its prose
  mentions are left alone — that one's a real public API surface, a
  separate decision from a text-only pass like this.

## 0.1.3

### Patch Changes

- 7547105: The VS Code extension now ships a Marketplace icon (the pixel-8 mark from
  the favicon, on the same purple/cream palette) instead of using the
  Marketplace's generic default.
- 47eaff5: Pin the workspace's `packageManager` to pnpm 12.3.4 (up from 12.1.0) and
  recommend the `8bitscript.8bitscript-lang` VS Code extension in this
  repo's `.vscode/extensions.json`. The VS Code extension also gains a
  Marketplace icon (the pixel-8 mark, on the same purple/cream palette as
  `docs/assets/favicon.svg`) instead of falling back to the generic default.

## 0.1.2

### Patch Changes

- b9aea09: The editor talks to `8bs lsp` with a thin stdio client instead of
  `vscode-languageclient`, so the VSIX is tens of kilobytes. Marketplace
  publish no longer uses vsce's 180-second gallery timeout.

## 0.1.1

### Patch Changes

- d56d494: Added a "How it compares" section to the root README, docs/about, and
  the VS Code extension's README, positioning 8BitScript against BASIC,
  hand-written assembly, and C with measured compiled-size numbers.
