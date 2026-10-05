# @8bitscript/pet

## 0.25.0

### Minor Changes

- 88b2396: `@8bitscript/graphics` animates on the PET: every frame a `.8bg` animation names becomes its own quadrant-block shape, defined once before `main()`, and `graphics.update()` steps through them at the animation's `every`, as on the C64. The sprite layer's seven shapes are one budget for the whole program, counted across `.8bg` files; the build warns (`8BS2111`) when a picture is cut short or finds none left, and the program shows exactly that. A picture too faint to survive the downsample is now a small centre block rather than a stray solid block, and a picture with transparent pixels takes its shape from them (white pixel art on a clear background is a white shape, as on the C64) instead of losing every bright pixel.
  
  Two compiler fixes that were not PET-only: two `.8bg` files that each held one sprite both claimed slot 0, so one drew as the other (`graphics.place` of the second picture showed the first); slots are now numbered across the whole program. And the media bind functions run in declaration order, not reversed.
- 5065779: `raster.frame()` and `raster.FRAME_COUNTER`: a count of video frames since `enable()`, wrapping at 256, so a raster effect can step once per frame however long the game loop takes. It counts on the C64 (the handler's line-0 pass) and the X16 (the end of each pass over the planned lines): 6 and 8 more bytes in a program that uses the raster list. Every other rasterline file answers `FRAME_COUNTER` false and `frame()` 0 — the VIC-20 and the PET run no interrupt, and the web host runs one logical frame per `waitFrame()` and never skips one — at no cost to a program that does not call it.
- 52e8dee: A program is now a unit an editor can run on its own, with its own settings. Three pieces make the contract:
  
  **`#define("NAME", default)`** is a value the build is handed — a seed, a flag, a starting amount — with the default written where it is read, so a plain build, `8bs check` and the editor never lack one. `8bs run c64 --program slot5x5 --define SEED=42 --define FORCE_BONUS=true` (repeatable) replaces it for one build, and a `define: { SEED: 42 }` under a program in `8bitscript.config.8bs` does so on every build of it; the command line wins over the config, the config over the default. It folds to a literal, so a different value is a different build and a program that reads none is byte-identical (15 example builds on pet, c64, vic20, cx16 and web measured the same). The name is in capitals; the default is a whole number, `true`/`false`, or a string (`8BS1047`); a value of the wrong kind is `8BS1048`; one name with two defaults in one program is `8BS1049`. A `--define` for a name the program never reads is an error naming the nearest name it does read, and a config `define` nothing reads is a warning. `8bs check` takes `--define` too, and a build records what its defines came to in `dist/.8bs-last-<target>.json`. Hover, completion, a `#define` snippet and the docs are updated.
  
  **`8bs project [--json]`** describes the project with the CLI's own loader instead of a regular expression over the config: its programs — with the new display keys `title`, `description` and `group`, the machines each builds for, and the `#define` names each reads with the defaults found in its source by the compiler — its targets, locales and named systems, and anything wrong with them as `problems` rather than a failure. Exit 0 when described, 1 when a config exists and will not load. The shape is in `docs/project/units.md`.
  
  **`8bs targets --json` says how each machine can be run**: a `runtime` object with `native` (the emulator and whether it is installed), `wasm` (the machine's own package through the wasm backend, in a page), `wasmEmulator` (cx16's real x16emu as WebAssembly) and `boot` (the bare machine), each with `available` and, when not, a `reason`. The wasm claim is declared by each machine package (`emulator.wasm`) and held to the truth by a test that builds every one: the PET, VIC-20, X16 and web build through the wasm backend; the C64 does not yet (the wasm backend does not lower an array pinned at a fixed address, `screenRam`). An editor no longer needs a hand-kept list of which machines can preview in a page.
  
  `8bs run`'s usage now documents `--web`, `--x16emu`, `--locale` and `--define`.

### Patch Changes

- 7a866bc: The PET's `graphics.hide`, `setFrame` (and its clamp), `animate` and
  placement at the screen's edges are now shown under xpet on the 2001, 3032,
  4032 and 8032 and pinned where CI runs them; no behaviour changed.
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

- 0ff97c3: The PET's `3032` model tag (`--hardware model=3032`) now answers `#fact(video.raster)`: `@8bitscript/raster`'s `Slot.CHARSET` splits the picture between the character ROM's graphics and text halves at a chosen picture line, verified under VICE at true cycle-scanline accuracy and stable frame to frame. The PET has no raster interrupt and no readable scanline counter, so every entry is cycle-counted from the single vertical-retrace edge `waitFrame()` already waits on, applied by a new frame hook (`FRAME_SYNC.pet.frameHook`, `EdgeSyncCalibrated` gains the field the level-kind machines already had) that `commit()` precomputes a division-free delay plan for — the 6502 backend has no hardware divide, so the cycle-to-loop-count decomposition is repeated subtraction, computed once, never in the per-frame hook. Every other PET model, including the default (2001) and the release target (4032), still answers false; extending this to the CRTC boards (4032, 8032) is follow-on work with its own timing to measure. See `packages/pet/AGENTS.md`, "Raster: character-set switching," for the mechanism and the numbers.
  
  `examples/fancy` — the raster *colour* showpiece — now distinguishes "no raster" from "raster, but not the colour kind this demo draws with": a machine that answers `video.raster` without answering `raster.COLORS` (the PET) shows a third caption rather than silently linking dead `BORDER`/`BACKGROUND` calls that always return false.
- 3824070: The PET's `4032` model tag (`--hardware model=4032`, this package's release target) now answers `#fact(video.raster)`: `@8bitscript/raster`'s `Slot.CHARSET` splits the picture between the character ROM's graphics and text halves at a chosen picture line, the same mechanism the `3032` model tag already shipped, with this CRTC board's own measured timing (`LINE_CYCLES` 50, `ORIGIN_CYCLES` 5209 — not simply carried over from the 3032's non-CRTC numbers). Verified under VICE with an eight-entry list spread across the whole picture, stable across two different `--frames` counts; `packages/pet/AGENTS.md`'s "Raster: character-set switching" section has the mechanism, the numbers, and two wrong turns this model's own calibration took before landing on them (a single-mechanism sweep whose row-reading was wrong by exactly half, and an `ORIGIN_CYCLES` fit that silently credited the wrong list entry for a visible transition) worth reading before extending this to another CRTC board. Every other PET model, including the default (2001), still answers false; the 8032 is the remaining follow-on work.

### Patch Changes

- daac931: A new portable package, `@8bitscript/color`, for the C64 demoscene's "more than 16 colours" trick: `color.blend(slot, a, b)` alternates a border or background color between two palette indices once a frame, riding on `@8bitscript/raster`'s own list, so a CRT's phosphor persistence blends them into a shade neither shows alone. Real on the C64; an honest, documented no-op on the PET (no color chip), the VIC-20 (the technique is unconfirmed on real hardware, not disproven — left unimplemented rather than assumed), the CX16 (VERA's 256-entry software palette makes the trick unnecessary — define the color directly instead), and the web (no CRT persistence to exploit, so alternating a color there would be visible flicker, not a blend). Gated by a new build-time fact, `#fact(video.colorBlend)`, filled in across every machine catalog (true only for the C64).
- e80d067: The PET's keyboard is its own hardware option, and the 3032B and 4032B are profiles you can build for.
  
  Those two machines are a business keyboard on a 40-column board, and that combination is exactly what the old arrangement could not express. A model's tag chooses *every* twin carrying it, and `8032` carried two: `keys.pet.8032.8bs`, the business key matrix, and `geometry.pet.8032.8bs`, eighty columns. A 4032B needs the first and must not have the second, so it could not simply borrow the 8032's tag — and giving it a tag of its own would have meant a second copy of a hundred-line key table, which is the one thing a table like that must never have.
  
  So the keyboard is the fourth axis, beside `model`, `ram` and `speaker`, the way `packages/pet/AGENTS.md` already describes those three: `keyboard: graphics | business`. `keys.pet.8032.8bs` becomes `keys.pet.business.8bs`, named for the thing it is rather than for one machine that has it, and `video.bootsInTextMode` moves onto the business value, where it belongs — it is the business *editor ROM* that boots in lower-case text, which is why the 8032, 4032B and 3032B all do and the 4032 does not.
  
  The keyboard value carries no `build`. That is deliberate and load-bearing: a build value becomes a word in the artifact's filename, and `main-pet-8032-32` is already sixteen bytes — CBM DOS's entire directory entry. A fourth word would have made the 8032 unbuildable under any ordinary program name. A tag without a build chooses the twin and stays out of the name.
  
  `--profile 8032` means what it always did: the preset now pins `keyboard: business` alongside its model, RAM and speaker. Three profiles are new — `3032B`, `4032B`, and the `business` keyboard on its own — and `xpet` is told with `-model 3032B` / `-model 4032B`, which are VICE's own names for them. `--hardware model=8032` without the profile now gets the graphics matrix and `video.bootsInTextMode: false`, since the keyboard is a separate choice and the fact belongs to it. That is the honest consequence of decoupling two things that were welded together, and the presets are, as ever, how a whole real machine is named: `--profile 8032` sets both.
  
  One property this shares with every other catalog and does not introduce: an option that carries a tag but no `build` changes what is compiled without changing the artifact's name. Every C64 option is already of that kind — a build with a 512K REU and one without are the same filename and different bytes, because `memory.bankedKib` folds into the program. `checkArtifactCollisions` only refuses two *different* names that truncate together, so this case is not new and is not caught; it is what naming artifacts after build values alone means.
  
  Resolved: `--profile 4032B` is 40 columns, business keyboard, boots in text mode, `-model 4032B -ramsize 32`. `--profile 8032` is 80 columns and business, unchanged.
- 4376f27: Fix PET programs crashing on the first interrupt after they start.
  
  The PET's zero-page budget began at `$8E`, on the reasoning that BASIC owns `$0002-$008D` and everything above it is free. It is not: the KERNAL owns the top of that page, and unlike the C64 and VIC-20 — which keep theirs at `$0314-$0319` — the PET keeps its interrupt vectors in it, `$90/$91` IRQ, `$92/$93` BRK, `$94/$95` NMI.
  
  So a program with three bytes of globals overwrote the IRQ vector, and the next vertical retrace — within a frame of its first store — jumped through whatever it had put there. Every PET program carrying a graphics or sprite component died this way, `hello-world` and `hello-bx` included; how much of the screen it had drawn first depended only on where in the frame the interrupt landed, which is why it looked like a black screen one run and a half-drawn one the next.
  
  A PET program that returns to BASIC now borrows the zero page it uses and gives it back: interrupts off, the bytes it will touch copied into its own image, copied back before the `rts`. That makes the whole page available to it — and the page it hands back the one BASIC left. It costs 28 bytes of code plus one image byte per byte borrowed, and a program with no variables at all pays nothing. A `waitFrame()` program is unchanged: it has already taken the machine and keeps the page.
- 8a309f5: `@8bitscript/raster` names a fourth per-line intent, `Slot.CHARSET` (a machine's alternate character set), alongside two new compile-time constants every rasterline layer answers: `raster.COLORS` (whether `Slot.BORDER`/`Slot.BACKGROUND` do anything — true on the C64, VIC-20 and web, false elsewhere including the PET, which has no border or background register) and `raster.CHARSET` (whether the new slot does — false everywhere for now). No machine implements `Slot.CHARSET` yet; every rasterline layer answers it as an honest, zero-cost `false`, the same pattern `raster.FINE_SCROLL` already established.
  
  This clears the way for a real PET implementation: `packages/pet/AGENTS.md` records verified research (under VICE, both the non-CRTC 3032 and the release-target 4032) showing the PET's character-ROM-select register splits the picture mid-frame at true cycle-scanline precision, with the line lengths and picture-start offsets measured for both boards — but the driver itself isn't built yet (it needs a division-free way to turn a cycle count into a delay loop, since the 6502 backend has no hardware divide). See that file's new "Raster: character-set switching" section for the numbers and the next steps.

## 0.23.1

No changes in this release.

## 0.23.0

### Minor Changes

- 499c62d: Narrow `RELEASE_MACHINES` to five targets — `pet`, `vic20`, `c64`, `cx16`, and `web` — so `8bs build` and `8bs run`, examples, Studio, and the editor launcher focus on a polished slice. Every other id stays in `MACHINES` for twins, facts, and `8bs check`; hello-world still compiles. Restoring the original nine and the remaining roadmap machines to `RELEASE_MACHINES` is planned in a follow-up (see `.changeset/remaining-systems.md` for the wider emulator and package work).
- 499c62d: Add a portable graphics and audio slice: `.8bg` / `.8ba` front ends, PNG and WAV/FLAC host tools, machine-owned lowering on C64, NES, PET, and Atari 8-bit with a glyph/no-driver fallback everywhere else, and a dogfood example that builds for every machine.

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
- 6e1056b: Groundwork for the second 6502 machine: the backend stops assuming it is building for the PET.
  
  Three things that were the PET's are now the hardware sheet's or the machine's:
  
  - **The load address comes off the sheet.** It was a per-machine table in `mos/index.ts`, which the VIC-20 disproves — a RAM expansion moves BASIC's program area from `$1001` to `$1201`, so one machine has two. It is `build.defsym.__load_address` now, alongside `__ram_size`, and a catalog can carry machine-level build symbols (`"8bitscript".hardware.build`) rather than only per-option ones. A machine whose sheet lacks one is refused by name.
  - **Zero-page budgets are per machine.** `ZP_BUDGETS` pairs the polite budget (a program that returns to BASIC) with the owned one (a program that never does). The C64's polite range is nothing like the PET's: BASIC owns `$02-$8F` and the KERNAL `$90-$FF`, leaving `$FB-$FE` — four bytes, enough to print and return and nothing like enough for real state, which is the same trade the PET's own two budgets make.
  - **`@address` arrays lower.** They were refused by name; they now bind their label to the pinned address through a new `equate` directive in the assembler, so an `@address` array reaches hardware by exactly the path a data-section array reaches the program image by, and emits no bytes. This is what the C64 and VIC-20 packages are written against — `screenRam[cell] = 32` over the VIC's screen — 65 uses across the two.
  
  The PET is byte-for-byte unchanged by all of it (hello-world 108/108/127 across the 2001, 3032 and 8032; 2048 2440 bytes on a stock 4K 2001).
  
  The C64 is deliberately **not** added to `RELEASE_MACHINES` yet: a package's own emulator tests switch on from that list, so listing a machine before it can build a program runs them against one that cannot boot what they load. It joins when it builds. The next blocker is `asm6502` blocks, which reach the backend as raw text and need a 6502 assembly parser; `setupVideo()` in `@8bitscript/c64` uses them to bank the KERNAL out.
- b390ef3: PET text is now drawn in the machine's text character set, so a string reaches the screen as it was written — and nothing puts the old set back on the way out.
  
  `"Hello World"` is `Hello World`, not `HELLO WORLD`. The PET's graphics set holds exactly one case of the alphabet, so a text package that encodes for it silently flattens mixed-case text to capitals — answering a different question than the one the caller asked. The text set holds both cases, so `@8bitscript/pet/text` draws in that one and selects it first on the models that boot elsewhere. The 8032's editor ROM already boots into it, so `#fact(video.bootsInTextMode)` folds the write away there and no `$E84C` store reaches the binary at all.
  
  `video.characterSetSwapped` matters again as a result: the original 2001's 901447-08 ROM arranges the text set's two cases the other way round from every later model's (upper case stays at 1-26, lower case moves to 65-90 — verified glyph by glyph against the ROM, where code 8 is `H` and not `h`). A build for the 2001 gets that mapping; a build for anything else gets the other.
  
  **`restoreOnExit` is removed**, along with the `usesCharacterSet` scan and the `LDA $E84C`/`PHA` … `PLA`/`STA $E84C` pair it drove. Restoring the character set could never work: the bit is retroactive — it selects the ROM the video hardware reads for every cell already on screen — so writing the old value back re-rendered the text the program had just drawn, through the very set it switched away from in order to draw it. Measured on a 3032, `Hello World!` came back as `|ELLO OORLD!` above a correct prompt. A program now exits in the set it selected, which is the only state where what it drew still reads as what it wrote. A project that still sets `restoreOnExit` is told the option is retired rather than having it quietly ignored.
  
  Measured under xpet on all three models: the 8032 shows `Hello World!` over its own `ready.` and spends nothing; the 2001 shows `Hello World!` over an upper-case `READY.`, because its ROM's two sets agree on codes 1-26 where BASIC's prompt is drawn; a 3032 shows `Hello World!` over a lower-case `ready.`, which is the whole of what this costs. hello-world is 108 bytes on a 3032, against 116 when the restore was still being paid for.

## 0.5.0

### Patch Changes

- 5754df7: PET text is drawn for the character set the machine booted into, and nothing changes that set.
  
  The PET's character-set bit is one register for the whole screen, and it is retroactive: it chooses the ROM the video hardware reads *now*, so flipping it re-renders every cell already on screen, BASIC's included. `text.8bs` used to select the mixed-case text set before each run of text, which meant a program left the machine in a mode its owner never chose — the 3032 and 4032 boot into upper-case/graphics and came back to a lower-case `ready.` prompt.
  
  Which set a model boots into is a fixed fact about it, so it is one now: `video.bootsInTextMode`, true for the business-keyboard editor ROMs (the 8032) and false for the 2001, 3032 and 4032. `asciiToScreenCode` folds on it and addresses whichever set is already live, so nothing writes `$E84C` and there is nothing to restore. Verified on all three models: each shows readable text above a BASIC prompt still in its own boot mode.
  
  What this means for a program: on a machine that boots into the graphics set — every model here but the 8032 — that set holds one case of the alphabet, so `text.print("Hello")` draws `HELLO`. That is what a PET in its power-on set has always looked like. An 8032 boots into the text set and keeps real mixed case.
  
  Programs also get slightly smaller, since no character-set write means no save/restore around them: the `hello-world` example is 103 bytes, against 116 with one.

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

### Patch Changes

- 7e28950: The PET input layer no longer turns a release of SHIFT into a phantom
  RIGHT/DOWN press. Edges are now detected on the physical cursor keys,
  with SHIFT sampled only to decide what a cursor key's own edge means —
  before this, the edge was detected on the shift-composed direction bit,
  and since nobody releases SHIFT and the cursor key on the same frame,
  every left/up release left a frame of bare cursor key that read as a
  brand-new right/down press (measured in 2048 under xpet: each LEFT move
  was chased by a phantom RIGHT that slid the board straight back, which
  players experienced as "my keypress did nothing").

## 0.2.3

### Patch Changes

- d58bf12: `text.setColor` on a machine with no per-cell color is now an empty
  function, and the compiler deletes the call — so a program that colors
  its text pays the PET, Atari 8-bit, and NES nothing, without wrapping the
  call in `Video.COLOR_PER_CELL`.

## 0.2.2

No changes in this release.

## 0.2.1

### Patch Changes

- b48b19b: Hello-world on the PET was 835 bytes of program and 49 of zero page because
  the compiler still emitted both `#fact` branches of asciiToScreenCode, a
  runtime ASCII conversion and string loop for `text.print(0, "Hello World!")`,
  JSRs into PET `blank`'s empty color stubs, a 16-bit STA (zp),Y screen fill,
  a 12-byte waitFrame scratch window, an unrolled 32-bit frameRate multiply
  (211 bytes of setup), and zp for helpers the program never reaches. Fold
  constant `if`s and never-assigned globals after pruning dead writers, turn a
  literal print into stores of already-converted screen codes, skip the string
  table entry those stores no longer need, inline a single-site void call
  whose parameters are unused, lower a constant fill loop to STA abs,X, and
  multiply waitFrame's measured elapsed with a Russian-peasant loop that
  reuses the accumulator — measured on the same example: 331 program bytes /
  8 zp. The per-frame waitFrame routine is unchanged; the print and fill are
  fewer cycles as well as fewer bytes. `--size` still names the inlined
  `text_print` / `screen_blank` bodies and splits wait-frame setup from the
  per-frame routine, so the report does not collapse into one `main` bucket.

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
