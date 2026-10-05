# @8bitscript/c64

## 0.25.0

### Minor Changes

- 0e0e928: The C64 answers the portable raster surface's `Slot.CHARSET`: `raster.at(line, Slot.CHARSET, 1)` switches the picture to the lower/upper-case character set from that line, and `0` switches it back to the upper-case/graphics set. This is `$D018` bit 1; the screen pointer is kept. `raster.CHARSET` is now `true` on the C64, and the slot is refused over a bitmap.
- 29fff5f: `@8bitscript/graphics` on the C64 now holds up to 24 sprites (it silently ignored everything past the eighth), colours each from its PNG, and says when an animation is too long. A `.8bg` sprite takes the VIC-II colour nearest its PNG's most common opaque colour instead of white; an animation longer than 4 frames is cut to 4 with `8BS2111` (it used to overrun the next sprite's shape blocks and truncate the byte index, corrupting the picture). The multiplexer counts only the highest slot a program declared. Past X = 255 a position must be a `usmallint` sum; the C64 notes say why.
- 4f425e1: The portable `@8bitscript/raster` works on the C64's wasm build: colour splits (border and background), a per-line fine scroll and a per-line character-set switch, applied by the page at the line they name (the machine's handler lands an entry one line later, and the sprite multiplexer and `@8bitscript/c64/raster`'s address-form list are still machine code and not built — `runtime.wasm.limits` says so). A new `rasterline.c64.web.8bs` writes the page's raster list instead of the interrupt list, keeping the C64 contract unchanged (`line` a byte, 63 entries, `at` refusing a line below the last, `insert`, `setValue`, `commit`, `enable`, `disable`); `raster.STRIDE` is 3 there, not the native list's 4, so a program that computes `index * raster.STRIDE` is unaffected. Checked pixel for pixel by `packages/cli/test/web-c64.test.mjs` (a band's border and background change on exactly the named lines, `SCROLL_X` 3 moves a row three pixels, a `CHARSET` entry draws the same screen codes from the other set), with the twin's list offsets held to the layout's by a test.
  
  The portable `@8bitscript/input` works there too: the page writes the arrow keys, Enter and Escape at one byte of the program's memory and a new `input.c64.web.8bs` reads it once a frame, so a key already down at start-up is not a press and a held key is one (`@8bitscript/c64/keyboard` and `/joystick` still read the CIA and see nothing; `runtime.wasm.limits` says so). The character RAM the page draws from moved to `$A000`, and the backend now refuses a program's own `@address` array that overlaps a range the wasm build keeps for itself, not only program data.
- ecb49c6: The C64's wasm build draws sprites. `8bs build --target c64 --web` now builds `fancy`, `joystick`, `media-walk`, `swarm` and Studio (they stopped at the sprite multiplexer's machine code): the page paints the eight VIC-II hardware sprites (hires and multicolour, X/Y expansion, priority, the ninth X bit, shape blocks read from the VIC bank) and applies the address-form raster list (`@8bitscript/c64/raster`) line by line, so a sprite is reused down the frame by the multiplexer's own list entries. `raster.c64.web.8bs` keeps the native list layout byte for byte and `multiplex.c64.web.8bs` is the multiplexer's routine in plain 8BitScript; `web-vic.mjs` is the one source both the screenshot renderer and the generated browser loader run. Not modelled, and listed in the C64's `wasm.limits`: sprite collision registers, the handler's cycle timing, a register an entry changed staying changed into the next frame, and an opened border.
- 4f425e1: The C64 now builds and runs through the wasm backend: `8bs build --target c64 --web`, `8bs run c64 --web` (an editor tab or an external browser), and `8bs run c64 --web --screenshot out.png` for a headless capture of what the page will draw. It is a model of the machine, not the machine, and `8bs targets --json` says so in `runtime.wasm.limits`: text mode only (no sprites, bitmap, multicolour or sound), no keyboard or joystick yet, NTSC 60 Hz. What it does model is checked pixel for pixel against the character ROM's own bytes: the screen matrix at `$E000` and colour RAM at `$D800`, the border and background from `$D020` and `$D021`, the fine scroll from `$D016`, which of the two character sets is live from `$D018` bit 1, reverse video, and every glyph read out of the program's own character RAM — so a glyph `@8bitscript/c64/charset` redefines or `restore()`s is simply the bytes there. The page reads the character RAM at `$A000`, not the machine's `$D000` (under the I/O area on the machine, the chips' own registers in flat memory).
  
  The wasm backend lowers an `@address` array — a fixed run of linear memory at its pin, bounded to the 64 KiB address space and refused where program data would sit under it — and folds a constant added to an 8-bit array index into the address instead of wrapping at 255, as the 6502 backend always has (`screen.blank()` on the C64 writes `screenRam[i + 250]`; before this a wasm build left every row after the first with screen code 0). `--screenshot` with `--web` now captures the wasm build through the page's own compositor; without `--web` it is still the native emulator's. Native builds are unchanged: three `.web` twins of the C64 package's `index`, `text` and `geometry` files (held to the native files' exports by a test) and a generated character-ROM data file are linked only by the wasm build.
- 5065779: `raster.frame()` and `raster.FRAME_COUNTER`: a count of video frames since `enable()`, wrapping at 256, so a raster effect can step once per frame however long the game loop takes. It counts on the C64 (the handler's line-0 pass) and the X16 (the end of each pass over the planned lines): 6 and 8 more bytes in a program that uses the raster list. Every other rasterline file answers `FRAME_COUNTER` false and `frame()` 0 — the VIC-20 and the PET run no interrupt, and the web host runs one logical frame per `waitFrame()` and never skips one — at no cost to a program that does not call it.
- 52e8dee: A program is now a unit an editor can run on its own, with its own settings. Three pieces make the contract:
  
  **`#define("NAME", default)`** is a value the build is handed — a seed, a flag, a starting amount — with the default written where it is read, so a plain build, `8bs check` and the editor never lack one. `8bs run c64 --program slot5x5 --define SEED=42 --define FORCE_BONUS=true` (repeatable) replaces it for one build, and a `define: { SEED: 42 }` under a program in `8bitscript.config.8bs` does so on every build of it; the command line wins over the config, the config over the default. It folds to a literal, so a different value is a different build and a program that reads none is byte-identical (15 example builds on pet, c64, vic20, cx16 and web measured the same). The name is in capitals; the default is a whole number, `true`/`false`, or a string (`8BS1047`); a value of the wrong kind is `8BS1048`; one name with two defaults in one program is `8BS1049`. A `--define` for a name the program never reads is an error naming the nearest name it does read, and a config `define` nothing reads is a warning. `8bs check` takes `--define` too, and a build records what its defines came to in `dist/.8bs-last-<target>.json`. Hover, completion, a `#define` snippet and the docs are updated.
  
  **`8bs project [--json]`** describes the project with the CLI's own loader instead of a regular expression over the config: its programs — with the new display keys `title`, `description` and `group`, the machines each builds for, and the `#define` names each reads with the defaults found in its source by the compiler — its targets, locales and named systems, and anything wrong with them as `problems` rather than a failure. Exit 0 when described, 1 when a config exists and will not load. The shape is in `docs/project/units.md`.
  
  **`8bs targets --json` says how each machine can be run**: a `runtime` object with `native` (the emulator and whether it is installed), `wasm` (the machine's own package through the wasm backend, in a page), `wasmEmulator` (cx16's real x16emu as WebAssembly) and `boot` (the bare machine), each with `available` and, when not, a `reason`. The wasm claim is declared by each machine package (`emulator.wasm`) and held to the truth by a test that builds every one: the PET, VIC-20, X16 and web build through the wasm backend; the C64 does not yet (the wasm backend does not lower an array pinned at a fixed address, `screenRam`). An editor no longer needs a hand-kept list of which machines can preview in a page.
  
  `8bs run`'s usage now documents `--web`, `--x16emu`, `--locale` and `--define`.

### Patch Changes

- 4a646ff: `@8bitscript/c64/charset` works for glyph codes of 32 and up, and `copy` and `readRow` read the program's own glyph. `charset.offset(code)` was `Video.CHARSET + code * 8` with a `utinyint` code, an eight-bit product, so `define`, `setRow`, `copy`, `fill` and `readRow` on any glyph from 32 up addressed the glyph 32·k lower (`define(40, ...)` and `define(200, ...)` both landed on glyph 8); the code is now widened to 16 bits first (`charset_offset` 25 → 42 bytes, one more byte of RAM). Separately, the I/O window around those accesses (`bankIoOut`) cleared CHAREN, which from the port's `%101` gives `%001`, where writes reach the RAM under `$D000` but reads see the character ROM, so `copy` and `readRow` returned the ROM's glyph instead of the program's; it now clears LORAM (`%100`, RAM everywhere) as its own comment said. The package header and docs also said `@8bitscript/text` selects the upper-case set on every print; it selects the mixed-case set, so call `charset.useUppercase()` after a print to see glyphs defined with the `define` family. Other packages with a glyph-address multiply were checked: the web charset already widens, atari8's inverted-digit table stays under 256, and the VIC-20 has no charset package.
- 8927961: `examples/fancy` has its colour bands and wobble back on the C64. Its per-frame `graphics.update()` rebuilds the C64 raster list (`raster.clear()`, the plan, `raster.commit()`), which erased the list the example builds once with `raster.at()`; it has done so since the four-pillars release added the Mark sprite. On the C64 the still sprite is now published once, before the list; every other machine is unchanged (byte-identical builds). A VICE pixel test and a CI-run source-shape test pin it, and the C64 notes now say what works with a raster list and sprites together and what does not exist yet.
- 40d5e91: `@8bitscript/graphics` is now one contract across machines. Every twin — the PET, VIC-20, C64, X16, web and NES ones, and the generic glyph path every other machine uses — answers the same ten constants (`graphics.MAX`, `FRAMES`, `WIDTH`, `HEIGHT`, `COLORS`, `RECOLORS`, `STEP_X`, `STEP_Y`, `RESTORES`, `TRANSPARENT`) with the value that machine honestly has, so a program can fold on what it can do, and exports the same calls: `place`, `update`, and new `hide`, `setFrame`, `animate` and `color`. A call a machine cannot honour is a documented no-op (`color` on the PET, the X16 and the NES, where `RECOLORS` is false); `docs/project/graphics.md` has the per-machine table, and `packages/compiler/test/graphics-contract.test.mjs` builds a probe that reads every constant and calls every operation on all thirty-two targets.
  
  The one behaviour change: `graphics.place` takes **playfield pixels** on every machine, so `place(slot, 0, 0)` lands on text cell (0, 0). The C64 twin now adds the sprite layer's origin (24, 50) itself, so a program no longer writes `sprites.ORIGIN_X +` in front of its positions (the bundled examples, Studio and the C64 probe did; they don't now). A program that already adds the origin by hand on the C64 draws 24 pixels right and 50 down of where it did.
  
  The generic glyph path now plays animations: the default lowering keeps up to four animation steps as one glyph each (it collapsed an animation to its first frame, with `8BS2111`), and `graphics.update()` steps through them at the animation's `every`, as the web twin already did.
- 55bd004: WASM is the primary runtime, and now there is a way to measure whether it is telling the truth.
  
  **`8bs conform` compares a machine's wasm build with the real machine.** For `pet`, `vic20`, `c64` and `cx16` it builds a probe program through the native emulator and through the wasm backend, captures one frame of each and compares them cell by cell: a wrong glyph is a *structure* difference and fails (exit 1), a different ink colour is a *colour* difference and warns (`--strict-colour` fails it). The probe's four solid corner cells locate the picture in each capture, so there is no table of where each emulator keeps its border. It writes the two captures and a diff image (native, wasm, and the differing cells in red and amber) and a JSON report. The first run found: the C64 matches x64sc in all 1000 cells (its palette differs); the PET is missing reverse video (114 cells); the VIC-20 the same plus the wrong boot character set (166 cells); the X16 draws the ASCII ramp in the host font, not its ISO character ROM (186 cells). Each machine package's `test/conform.test.mjs` pins its number, which can only go down. `docs/project/wasm-primary.md` has the policy, the audit of every example, Studio and the Vegas Nights slots on the five release machines, the parity matrix and the backlog.
  
  **A web bundle for tagged hardware could not load itself.** `8bs build --target vic20 --web` (the VIC-20 with 8K, the release hardware, tag `expanded`) wrote `program-expanded.wasm` and `program-expanded.json`, and `index.html` and `embed.html` still asked for `program.wasm`: on a clean directory the only file the page needs was a 404. The pages now name the file the bundle wrote.
  
  **The wasm capability rows no longer claim nothing is missing.** `8bs targets --json` reported `limits: []` for the PET, VIC-20 and X16, while the audit found reverse video undrawn on the PET and VIC-20, the portable `@8bitscript/raster` and `@8bitscript/input` failing to build for the wasm backend on the VIC-20 and X16 (`raster_probeRegion`, `raster_commit`, `input_poll` are machine code), `@8bitscript/graphics` objects compiling and drawing nothing on the PET, VIC-20 and X16, and no sound on any of them. They are limits now (the X16 already listed most of its own after the Studio change; this adds the input gap and the x16emu fallback), and the editor shows them.
  
  The VS Code launcher says what the three buttons are: **Editor** is the primary way to run a program, **Browser** is the page you can share, **Native** is the real emulator, the second opinion on what the WASM build shows.

## 0.24.0

### Minor Changes

- daac931: A new portable package, `@8bitscript/color`, for the C64 demoscene's "more than 16 colours" trick: `color.blend(slot, a, b)` alternates a border or background color between two palette indices once a frame, riding on `@8bitscript/raster`'s own list, so a CRT's phosphor persistence blends them into a shade neither shows alone. Real on the C64; an honest, documented no-op on the PET (no color chip), the VIC-20 (the technique is unconfirmed on real hardware, not disproven — left unimplemented rather than assumed), the CX16 (VERA's 256-entry software palette makes the trick unnecessary — define the color directly instead), and the web (no CRT persistence to exploit, so alternating a color there would be visible flicker, not a blend). Gated by a new build-time fact, `#fact(video.colorBlend)`, filled in across every machine catalog (true only for the C64).
- a988417: The VIC-20 answers `#fact(video.raster)`: `@8bitscript/raster`'s `Slot.BORDER` and `Slot.BACKGROUND` split at any picture line, on NTSC and PAL, each split landing on its exact line and whole — the line above entirely in the old colors, the target entirely in the new — and still from frame to frame. The VIC raises no interrupt, so the frame runtime applies the list: `FRAME_SYNC.vic20.frameHook` names `vic20RasterFrame`, which `waitFrame()` calls after every frame edge. It re-syncs on `$9004` and the `$9003` bit-7 edge before every planned line and writes `$900F` twice — the border half inside the picture of the line above, the background half in the border after it — with per-region delays measured under xvic and no taken branch between the edge and either store. `commit()` works everything else out ahead of time (picture line to raster line through `$9001`, the pair to poll, the parity, same-line merging, both stores' bytes), and the list and plan live in the cassette buffer. A list built once and `enable()`d shows every frame; `setValue` is live without a commit. Entries closer than two lines are planned two lines apart; `Slot.SCROLL_X` is refused. What it costs is written down in `packages/vic20/AGENTS.md` ("Raster splits"): the frame belongs to the hook until the last planned line, and the layer is about 850 bytes (`examples/fancy` on the 8K build, 2803 → 3654).
  
  The pruner keeps a machine's frame hook — which no program calls — when, and only when, a reachable function shares a global with it (`pruneUnreachable(ir, { frameHook })`, `frameHookWanted`), so a program that imports `@8bitscript/raster` and never commits a list, or whose raster branch a `#fact` folds away, is byte-identical to one without it. Frame hooks now work on level-kind machines as well as edge-kind ones.
  
  Every rasterline layer gains `raster.FINE_SCROLL` — whether `Slot.SCROLL_X` entries are taken (true on the C64 and the web, false on the VIC-20 and in every stub) — so a wobble can fold away where only splits exist. `examples/fancy` uses it: the VIC-20 shows the colour bands without the wobble. `packages/vic20/AGENTS.md` also corrects a stale claim: a VIC-20 program that calls `waitFrame()` runs with interrupts off from start-up.

### Patch Changes

- e80d067: Correct two things the C64's package said that were no longer true.
  
  The description still read "Parked in 0.2.0: not a build target until its native backend lands." The C64 is in `RELEASE_MACHINES` (`packages/compiler/src/resolver/index.mjs`), which is the list `8bs build` and `8bs run` will actually produce a program for, and every example in this repo names `c64` among its targets. The four machines whose descriptions still say it — `atari8`, `c128`, `mega65`, `nes` — really are parked, and keep theirs.
  
  The `ram` option was labelled "RAM Expansion Unit", which names one occupant of a slot that has several. A C64 has a single cartridge port, and Commodore's REU is only one of the banked-RAM cartridges that go in it: GeoRAM, RamCart and RamLink are others, each with its own VICE flag (`-georam`, `-ramcart`, `-ramlink`) and its own way of being addressed. The axis is "what RAM expansion is fitted", so the option key `ram` was right and only the label was too narrow; it is now "RAM expansion". The values are unchanged and still all REUs, so no build, profile or `--hardware ram=…` spelling moves.
  
  The `drive` option is gone. Its four values (1541, 1571, 1581, none) moved `storage.save` and `storage.kib` — what a program may assume it can save — while passing VICE nothing at all, so choosing a 1581 changed a number on the fact sheet and left the emulated machine exactly as it was. That was deliberate rather than an oversight (`packages/cli/test/hardware.test.mjs` said so out loud: "on the C64, a drive is not linked in and is not an emulator flag at all"), but it promised a capacity no program could reach: nothing in this repo saves anything yet — no package calls the KERNAL's `SETLFS`/`SETNAM`/`SAVE`, and no `.8bs` surface offers saving — so the axis graded builds against a medium that was never attached.
  
  `packages/c64/AGENTS.md` already described the catalog as "the REU, the SID, and what is in each control port", and its "Where things live" table already listed `ram (REU), sid, port1, port2`. The drive had been added without either being updated; the package now matches its own documentation again.
  
  The stock sheet is unchanged — `storage.save: true`, `storage.kib: 164` — because a C64 with a 1541 is the machine as sold and that is the assumption a program is entitled to make. What is gone is the *choice*: `--hardware drive=1581` on a C64 is now an unknown value, named with the options that do exist. The PET keeps its own drive axis, which is real: it passes `-drive8type` per value and VICE attaches the drive. The C64's comes back the same way when there is a save API to make it mean something. `c128` and `vic20` still carry the same facts-only drive axis this removes, and are the same decision waiting to be made.
  
  Nothing here changes a build, a tag, or a linked image.

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

- aa3fd8e: C64: `text.print`, `text.printNumber` and `text.fill` in native code, and an `asm6502` block may name its own frame.
  
  - `@8bitscript/c64/text`: the three run routines are `native/6502/text.s` now, one linked section each. Measured with CIA 2 timer A around one call (`test/text-timing-probe.8bs`): a nine-character `print` 1,908 → 498 cycles, a five-digit `printNumber` 2,944 → 1,265, a forty-cell `fill` 8,078 → 1,110 — a HUD line was a fifth of an NTSC frame under the compiler's generic code, with a `place()` call and two more inside it for every cell. `text.putChar`/`putColor` are unchanged; `fill` now calls `prepare()` first like the other two (the picture set up, the mixed-case set selected in text mode), where before it wrote without. The routines read their arguments from page `$07` (the KERNAL's dead screen, beside the raster list's `$04`/`$05` and the multiplexer's `$06`).
  - Compiler: an `asm6502` operand that names one of the function's own parameters or locals is that slot's zero-page address — `lda cell`, `ldx cell+1`, `lda (s),y`, `lda #<cell` — in the zero-page form of the instruction; any other symbol is still a linker label, and `jsr`/`jmp`/a branch to a frame name is refused. The optimizer counts a name written in a block's text as a read, so a parameter only the block uses is still passed. This is what lets a package hand a string parameter's pointer to native code.
- 63b1906: C64: the VIC-II's opened border, idle graphics and sprite multiplexing, on a reworked raster list.
  
  - `@8bitscript/c64/border`: `border.top()`/`bottom()` add the `$D011` entries that open the upper and lower border for sprites (RSEL cleared at 249 after the VIC's line-247 comparison, restored at 47 + YSCROLL), with `setShort()` for a 24-row base.
  - `@8bitscript/c64/idle`: the ghost byte. In VIC bank 3 the idle-graphics byte `$3FFF` is `$FFFF`, the IRQ vector's high byte, and the raster handler's page used to draw as stripes in the gap a YSCROLL other than 3 opens; `raster.s` now routes the IRQ through a trampoline at `$FD` (the compiler's C64 zero-page budget ends there), so `$FFFF` is 0 and idle graphics are transparent in every program. `idle.setPattern()` writes the ECM byte `$F9FF` (block 231's pad byte) for a chosen pattern in an opened border, and `raster.at(line, idle.PATTERN, bits)` changes it per line.
  - `@8bitscript/c64/multiplex`: up to 24 virtual sprites from the eight — sorted by Y each frame, the eight topmost through the list's frame table, the rest as list entries at the earliest line each hardware sprite is free.
  - `@8bitscript/c64/raster`: the list is double-buffered (`commit()`; `enable()` commits), takes out-of-order entries (`insert()`), carries a frame table of sprite registers the handler writes at the end of every pass (`setFrameByte()`, `Frame.*`), ends its pass at line 255 whatever the last entry's line, and applies a late entry at once instead of losing the frame. `setValue()`/`addressOf()` work on the live list. The REU probe byte moved from `$033C` to `$03FF`.
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
- 6e1056b: Groundwork for the second 6502 machine: the backend stops assuming it is building for the PET.
  
  Three things that were the PET's are now the hardware sheet's or the machine's:
  
  - **The load address comes off the sheet.** It was a per-machine table in `mos/index.ts`, which the VIC-20 disproves — a RAM expansion moves BASIC's program area from `$1001` to `$1201`, so one machine has two. It is `build.defsym.__load_address` now, alongside `__ram_size`, and a catalog can carry machine-level build symbols (`"8bitscript".hardware.build`) rather than only per-option ones. A machine whose sheet lacks one is refused by name.
  - **Zero-page budgets are per machine.** `ZP_BUDGETS` pairs the polite budget (a program that returns to BASIC) with the owned one (a program that never does). The C64's polite range is nothing like the PET's: BASIC owns `$02-$8F` and the KERNAL `$90-$FF`, leaving `$FB-$FE` — four bytes, enough to print and return and nothing like enough for real state, which is the same trade the PET's own two budgets make.
  - **`@address` arrays lower.** They were refused by name; they now bind their label to the pinned address through a new `equate` directive in the assembler, so an `@address` array reaches hardware by exactly the path a data-section array reaches the program image by, and emits no bytes. This is what the C64 and VIC-20 packages are written against — `screenRam[cell] = 32` over the VIC's screen — 65 uses across the two.
  
  The PET is byte-for-byte unchanged by all of it (hello-world 108/108/127 across the 2001, 3032 and 8032; 2048 2440 bytes on a stock 4K 2001).
  
  The C64 is deliberately **not** added to `RELEASE_MACHINES` yet: a package's own emulator tests switch on from that list, so listing a machine before it can build a program runs them against one that cannot boot what they load. It joins when it builds. The next blocker is `asm6502` blocks, which reach the backend as raw text and need a 6502 assembly parser; `setupVideo()` in `@8bitscript/c64` uses them to bank the KERNAL out.

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
