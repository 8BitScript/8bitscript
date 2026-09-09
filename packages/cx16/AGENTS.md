# Writing Commander X16 support for 8BitScript

This file is for anyone — human or agent — touching `packages/cx16`,
`packages/compiler/src/mos`'s `cx16` entries, `packages/cli/src/setup/cx16.mjs`,
or `docs/setup/cx16.md`. Read the root [`AGENTS.md`](../../AGENTS.md)
first; the rules there apply to every target and are not repeated.
[`packages/nes/AGENTS.md`](../nes/AGENTS.md) is the useful contrast: the
NES forces abstraction because there is almost nothing; the X16 needs it
because there is a great deal, and nearly all of it sits behind windows,
indirect ports, stateful registers, firmware APIs, and optional hardware.

> **Do not model the X16 as "a really fast C64." Model it as a 65C02 with
> a small directly addressable workspace connected to several powerful
> coprocessor-like devices through narrow interfaces.**

## What exists today

Do not describe more than this as working:

- `packages/cx16/src/index.8bs` exports the VERA port helpers —
  `setVramAddress()`, `locateTextMap()`, and the `mapBank`/`mapLow` it
  fills — that the package's two portable surfaces are built on:
  `src/screen.8bs` (behind `@8bitscript/screen`, as `@8bitscript/cx16/screen`)
  and `src/text.8bs` (behind `@8bitscript/text`). `screen.setColors()`'s
  border is real but *made*: VERA's border colour has nowhere to show by
  default (the active display area fills the 640×480 output), so it insets
  the active area by 16 pixels on every side and that ring takes the
  colour. Its background is *painted*: there is no register for it, so
  every text cell's attribute byte is rewritten through VERA's data port.
  `text.putChar(cell, code)` takes ASCII — ISO mode is what makes tile
  index equal the character code — on the 76×56 grid the border inset
  leaves visible (the map is 80×60; `text.COLUMNS` is 76 and
  `text.CELL_COUNT` 4256, so a program never addresses a cell it cannot
  see), whose map base is read from VERA's `L1_MAPBASE` at runtime, not
  assumed. `locate()` finds a cell's row by a reciprocal multiply on the
  cell's split bytes (see the package), not a divide, and parks both VERA
  address ports: port 0 on the character byte stepping by one, port 1 on
  the colour byte stepping by two. `putColor` is real (per-cell foreground
  nibble): a run of text writes character then colour through port 0,
  reading each cell's old colour byte through port 1 so whatever
  background nibble the cell has is kept. `locate()` leaves ADDRSEL at 0,
  which `screen.8bs` assumes.
- `waitFrame()` (`FRAME_SYNC.cx16` in `packages/compiler/src/mos`) polls
  VERA's ISR VSYNC bit under `sei` — at the default `frameRate` of 60 that
  is exactly one VSYNC per `waitFrame()`, with no accumulator emitted at all.
- `src/mouse.8bs` (behind `@8bitscript/cx16/mouse`), `src/input.8bs` and
  `src/pointer.8bs` are the X16 behind `@8bitscript/input` and
  `@8bitscript/pointer`. The pointer is a KERNAL service: `$FF68`
  mouse_config turns it on (and the firmware draws Susan Kare's arrow as
  VERA sprite 0), `$FF71` mouse_scan has to be called from `poll()` because
  `waitFrame()` runs under `sei` and the KERNAL IRQ no longer scans, and
  `$FF6B` mouse_get copies position and buttons into `$80`–`$84` — past
  BASIC's zero-page end, so a linker will not put a variable there.
  `present()` is `#fact(input.mouse)`, not a stored flag: an `asm6502`
  block is opaque, and a bool set before a KERNAL call and read after it
  was kept in a register the call trashed (measured: the arrow drawing at
  (319, 239) while `present()` was false). The rest position is the
  centre of the 640×480 the current screen_mode names; after
  `screen.8bs` insets the display, the sprite is on screen at (335, 254).
  Keyboard (`$FFE4` GETIN) and pads (`$FF56` joystick_get) are still
  unanswered. `test/mouse-probe.8bs` is 1184 bytes of program and 25 of
  RAM; Studio with the layer is 1571 bytes and 35 of RAM, 318 and 5
  above the same program with it taken out.
- There is no `--profile` for the X16 yet — no banked-RAM size, no
  video-output (VGA/composite) profile, no expansion-card capabilities.
- `8bs setup cx16` builds the emulator and ROM together from upstream and
  installs them under `/opt/commander-x16`; the pair this file was verified
  against is x16emu r50 (`77f2bab3`) with ROM `fbe32a60` — the same
  revisions `x16emu -version` and the boot banner report — read in
  checkouts of the upstream `x16-emulator` and `x16-rom` repositories at
  those commits.

There is no banked-memory model in the language, no far pointer, no VRAM
allocator, no asset pipeline, no sprite/tile/audio/storage API, and no
capability probing yet — for any machine. The X16's mouse is the exception
on the input side; its keyboard and pads are still unanswered. The rules
below are what to hold that work to when it comes; don't write docs
implying it exists.

## Facts verified here (against the installed emulator and ROM sources)

Cite these freely; each was read in the source named, not recalled.

| Fact | Where |
| ---- | ----- |
| 128 hardware sprites. Not 256. | `video.c` `NUM_SPRITES 128` |
| The sprite renderer has a per-line cycle budget (~800 VERA cycles), consumed per fetch, so how many sprites fit on a line depends on their width and depth, not on a count. | `video.c` `sprite_budget = 800 + 1`, decremented per fetch |
| VERA address auto-increment steps: 0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, **40, 80, 160, 320, 640**, each also as a decrement. | `video.c` `increments[32]` |
| VRAM `$1F9C0-$1F9FF` is the PSG, `$1FA00-$1FBFF` the palette, `$1FC00-$1FFFF` sprite attributes. | `video.c` `ADDR_PSG_START` etc. |
| PCM FIFO is 4096 bytes. | `vera_pcm.c` `fifo[4096]` |
| Layer registers (`$9F2D-$9F3A`) read back their written values; the `$9F29-$9F2C` group is multiplexed by DCSEL. | `video.c` `video_read` |
| RAM bank select is `$0000`, ROM bank `$0001`; banked RAM beyond the installed banks reads as open bus; ROM banks 0-31 are internal, 32+ are cartridge. | `memory.c` |
| Slow I/O: the emulator charges 3 extra CPU cycles per access to `$9F40-$9F5F` (YM2151, "IO2") **and** to `$9FA0-$9FFF` (IO5-IO7). `$9F60-$9F9F` (IO3, IO4) is not penalised. | `memory.c` `real_read6502`/write |
| Switching the screen editor into or out of ISO mode (`CHR$(15)`/`CHR$(143)`) clears the screen. | `kernal/cbm/editor.s`, `isosto: … jsr clsr` |
| The KERNAL's text mode is layer 1, 1bpp, 128×64 map at `$1B000`, charset at `$1F000` — ROM build constants, not a contract; read `L1_MAPBASE`. | `kernal/drivers/x16/screen.s` `screen_init`, `inc/io.inc` |
| `MEMTOP` with carry set returns the banked-RAM bank count in A (`$00` = 256). | `kernal/cbm/memory.s` `gettop` |
| The KERNAL's RAM sizing ends by selecting bank 1 (`lda #1 / sta ram_bank`), leaving it as the user's bank; bank 0 is its own workspace. | `kernal/drivers/x16/memory.s` |
| `$FF80` is the KERNAL revision byte — **negative** (two's complement) on prerelease builds, e.g. `$CE` for "R50 next". | `kernal/vectors.s` |
| The KERNAL's own interrupt-time VERA users (mouse-cursor sprite, cursor blink) wrap their work in `screen_save_state`/`screen_restore_state`, which save VERA CTRL, the DCSEL=2 register (FX_CTRL) and ADDR0. So the default IRQ handler does not corrupt a program's VERA address state. | `ps2mouse.s`, `editor.s`, `screen.s` |
| `memory_copy`/`memory_fill` detect the `$9F00` I/O page and do not increment through it — which is what lets them stream through a VERA data port. | `kernal/memory.s` |
| Switching into ISO mode (`CHR$(15)` through CHROUT) before `main()` was verified on a linked build (pre-0.2.0). The native backend does not yet emit that start-up. | disassembly of a linked build (pre-0.2.0) |
| With a nonzero VSTART, VERA's layer line 0 lands two lines above the active area's top edge (the layer line counter starts on the VSTART line through a two-line register-history pipeline). | `video.c` ~1029-1063, and on screen |
| The catalog's stock fact sheet: grid 76×56 of 8×8 (the map's 80×60 less the border inset), 256 palette entries, 2 colours per cell, 256 glyphs in the text layer's tileset, 2×2 blocks (the PETSCII set in the ROM font), bitmap, 2 layers with fine scroll each; 128 sprites, up to 64×64, 255 colours at 8 bpp; 16 PSG + 8 FM + 1 PCM = 25 voices, envelopes on the FM side, noise on the PSG, a volume per voice, no filter or random source; keyboard and mouse through the KERNAL (`input.mouse` is true on the stock machine: the emulator's mouse is always there), 2 SNES pad ports (*to verify*: some boards carry 4), no joystick ports; the SD card to save to; 38655 bytes of low RAM (`$0801`–`$9EFF`), 512 KiB banked by default (the `ram` values change it). **`video.spritesPerLine` is 46**: the VERA reference gives a 798-cycle deadline per line and 13–17 cycles for the smallest sprite (8 px, 4 bpp), so 798 ÷ 17 = 46 of those is the worst case; the biggest (64 px, 8 bpp, 99–147 cycles) fits 5. The sheet states the small-sprite figure, and an actors package must say which size its own count assumes. | `src/text.8bs`; the `link.ld`, palette and sprite-budget rows above; VERA Programmer's Reference, "Sprite renderer / line buffer" (fetched 2026-09-05); `package.json` (read) |
| `@8bitscript/cx16/banks` — `banks.kib()`: the count is the first page above a power of two that the machine does not really have. Two shapes, both tested: a mirror of page 1 (a board that keeps fewer than 8 bank bits wraps, and every page tested is one above a power of two, so a wrap lands on page 1), confirmed with a second marker; or nothing at all, caught by writing two different bytes and reading both back. **x16emu is the second shape**: with `-ram 64`, a byte written to page 200 read back as `$A0` (the window's own address high byte) and page 9 read `$3E` — writes to a page the machine does not have are dropped and reads float. Page 0 is never written (KERNAL workspace) and page 1 is left selected. Under x16emu the probe printed 64 / 512 / 2048 KiB for `ram=64`, `512`, `2048`. Cost: `test/banks-probe.8bs` is 1179 bytes of program with the probe and 1000 with the size written in — 179 bytes. | `src/banks.8bs`; three screenshots and one diagnostic build (ran); `test/banks.test.mjs` |
| `@8bitscript/cx16/mouse` — `$FF68` mouse_config A=1, size from `$FF5F` screen_mode (carry set; 80×60 in KERNAL text), parks at (319, 239); `$FF71` mouse_scan is required because FRAME_SYNC.cx16's `sei` silences the KERNAL IRQ that would have scanned; `$FF6B` mouse_get into `$80`–`$84` (program ZP temps start at `$80`). Presence is the `input.mouse` fact, not a flag stored across an opaque `asm6502` call. After screen.8bs insets the display, the firmware sprite is on the screenshot at (335, 254); `pointerCell()` is `x>>3`, `y>>3` in that active-area space (an earlier draft subtracted the inset again and sat two cells off). Probe 1184 B / 25 B RAM, green border under x16emu when present(). | `src/mouse.8bs`; `test/mouse-probe.8bs` (ran); `packages/pointer/test/pointer.test.mjs` |

## Corrections to the research notes

- **`storage.kib` is 32768 on the stock sheet, and it is a floor, not a
  measurement.** The route is the SD card, whose size is the owner's
  rather than the medium's, so the sheet states the smallest medium that
  route can stand for: 32 MiB (32768 KiB), the smallest volume FAT32 is
  defined for.
  **Recalled, not measured in this project** — the Commodore drives'
  figures were taken by formatting an image with `c1541`; no equivalent
  was run here. *To verify* against the KERNAL's DOS and a real card.

- **"Five monitors at 8 MHz / 2 MHz."** Those are CPU-side MMIO windows,
  not displays: VERA at `$9F20`, expansion IO3 at `$9F60`, IO4 at `$9F80`
  on the fast bus; IO5-IO7 (`$9FA0-$9FFF`) on the slow bus. BASIC's
  `VPEEK`/`VPOKE` document add-on VERAs at IO3 and IO4 only (per the
  official docs; not checked here). Never write "an 8 MHz display".
- The slow bus also covers the **YM2151's window** (`$9F40-$9F5F`), which
  the notes leave out. "2 MHz" is how the notes describe it; what this
  project has verified is the emulator's model — 3 extra cycles per access
  — not the hardware's exact wait-state behaviour.
- **256 sprites** is wrong; it is 128.
- **`$FF80`** is not simply "the version number": prerelease builds store
  its negation. Compare against a documented value, don't assume positive.
- **ISO mode is not the KERNAL's boot state** — it is a start-up
  choice for this platform. A raw-assembly program would find PETSCII.
  The native backend does not yet emit that start-up.
- Everything in the notes about YM2151 write timing (~10 cycles after
  register select, ~150 busy cycles, writes during BUSY dropped), PCM
  rates, the composite/overscan guidance, RTC NVRAM (32 user bytes at
  `$20-$3F`), I²C cartridge addresses `$50-$57`, the Serial/MIDI card, and
  the R48 `memory_crc` bug is **from the official documentation as cited
  there, not verified in this project**. Treat it as a lead to verify the
  first time code depends on it.

## Rules for this target

### Memory

- Fixed RAM (`$0000-$9EFF`) and the banked window (`$A000-$BFFF`) are
  different address spaces. An address in the window is meaningless
  without its bank: represent far references as (bank, offset), never as
  a bare 16-bit pointer.
- Never assume 2 MB. Detect the bank count with `MEMTOP` at runtime, and
  let a build declare what it needs (`>= 512K`) rather than what it wants.
- Reserve bank 0 (KERNAL/CMDR-DOS workspace). The KERNAL leaves bank 1
  selected for the user.
- Bank select is global state. Generated interrupt code that changes
  `$0000`/`$0001` must restore them before `RTI`.

### KERNAL

- Depend only on the published entry points (`$FF81-$FFF3`, `$FF80`) and
  vectors (`$0314-$0333`). Never call into a ROM bank by offset, and never
  depend on KERNAL zero-page or `$0200+` layout — the ROM's own docs say
  they may change.
- Gate version-sensitive behaviour on `$FF80`, remembering its sign.
- Prefer `memory_copy`/`memory_fill`/LZSA2 for bulk moves, especially
  RAM→VRAM through a data port, over hand loops.

### VERA

- VRAM is indirect: set ADDR0 or ADDR1, then stream through DATA0/DATA1.
  Set the address once per run and use the auto-increment — including the
  40/80/160/320/640 strides for walking rows and columns — never
  address-then-one-byte in a loop.
- CTRL (ADDRSEL, DCSEL), ADDR0/1, and FX are shared mutable state.
  Library code either preserves what it found or is explicitly marked as
  owning VERA; `index.8bs` sets DCSEL both ways itself and leaves it 0.
  The KERNAL's IRQ handler preserves them around its own work (verified),
  so setup code running with interrupts enabled is safe — a program's own
  IRQ code must extend the same courtesy.
- `$1F9C0-$1FFFF` are write-only device registers behind a VRAM address:
  reading them returns a shadow, not the device. Keep CPU-side shadows for
  sprite attributes, palette, and PSG state; never read-modify-write them.
- Don't hardcode the KERNAL's VRAM layout. `index.8bs` reads
  `L1_MAPBASE`; a full-screen program that takes VRAM over should get an
  allocator that honours the alignments (map base 512-byte, tile base
  2048-byte, sprite data 32-byte).
- Any nonzero VSTART needs the two-line layer correction `index.8bs`
  applies (layer-1 vertical scroll 510); re-measure with `x16emu -gif`
  rather than trusting the arithmetic.
- Keep logical resolution, output type (VGA/NTSC/RGB), scaling, and a
  composite-safe area as separate properties; none is "the" resolution.

### Sprites and graphics

- 128 descriptors is not a per-scanline count. Budget sprite work per
  scanline by width and bpp; the tooling should estimate worst-case
  renderer load, the way the NES tooling should count sprites per line.
- Lower sprite index wins at equal Z; treat index allocation as priority,
  hidden behind the runtime.
- Sprite coordinates are 10-bit and wrap at 1024 (so -10 is 1014).
- Tile layers for scrolling worlds; bitmap layers have no hardware
  H/V scroll. Deduplicate tiles at build time, including H/V flips, and
  pick the lowest workable bpp.
- Prefer software collision primitives; VERA's collision mask is coarse
  and updates once per frame.

### Raster and interrupts

- VERA renders one line ahead of scan-out; a register change lands a line
  later than the scanline register suggests. Keep that inside a
  target-specific raster scheduler.
- If FX is on, an interrupt that touches VERA must save and suspend it.
- The line IRQ has interlace quirks (bit 0 ignored, readings alternate by
  field). Same rule: scheduler code, not application code.

### Audio

- YM2151, VERA PSG, and VERA PCM are three resources, not one. Per chip,
  either the ROM audio API owns it or a raw engine does — never both.
- Route every YM write through a timing-aware scheduler with a software
  shadow; the registers are write-only and writes during BUSY are lost.
- PSG envelopes are software. PCM is FIFO-driven with deadlines: prefill,
  then start; service on the low-water interrupt.

### Storage, input, expansion, testing

- The emulator's HostFS is not cycle-accurate; test storage behaviour
  against a FAT32 SD image and, finally, hardware.
- RTC NVRAM gives 32 user bytes — settings and a high score, not saves.
- Expansion cards, extra VERAs, extra controllers, cartridge NVRAM,
  serial/MIDI/network: capabilities to probe, never assumed from
  `machine == cx16`.
- Pin emulator + ROM together; `8bs setup cx16` already builds them as a
  pair. Note both revisions in any comment that records a measurement.
- `x16emu -gif file.gif -warp -sound none` plus `ffmpeg` frame extraction
  is this project's headless verification path; `-echo raw` shows KERNAL
  output (a `^O` at the end of a run is `CHR$(15)`, ISO mode).
  `8bs run cx16 --screenshot <file.png>` already wraps this (needs `ffmpeg`
  on PATH) — see [`docs/setup/verify.md`](../../docs/setup/verify.md#screenshots)
  before reaching for the raw flags directly.

## Where things live

```
packages/cx16/src/index.8bs              target package: the VERA port helpers (setVramAddress, locateTextMap)
packages/cx16/src/screen.8bs             @8bitscript/cx16/screen: screen.blank()/setBorder()/setBackground()/setColors(), the inset border, the painted background
packages/cx16/src/banks.8bs              @8bitscript/cx16/banks: banks.kib() — banked RAM found at run time, 64..2048 KiB
packages/cx16/test/banks-probe.8bs       the probe run for real: prints the KiB, border colour encodes it; test/banks.test.mjs reads it under x16emu
packages/cx16/src/mouse.8bs              @8bitscript/cx16/mouse: mouse.begin/poll/present/x/y/left/hide/show, through the KERNAL
packages/cx16/src/input.8bs              @8bitscript/cx16/input: the pointer in cells; directions still false
packages/cx16/src/pointer.8bs            @8bitscript/cx16/pointer: the firmware arrow; update() empty unless recovering from hide()
packages/cx16/test/mouse-probe.8bs       run under x16emu: green border when present(); test/mouse.test.mjs reads it
packages/cx16/src/text.8bs               @8bitscript/cx16/text: text.print/printNumber/setColor/setReverse/putChar/putColor, CELL_COUNT 4256, COLUMNS 76, TextColor
packages/compiler/src/mos/index.ts       FRAME_SYNC.cx16 (VERA ISR poll; the backend refuses to build)
packages/cli/src/setup/cx16.mjs          8bs setup cx16: emulator+ROM pair, macOS launcher wrapper
packages/cli/src/run.mjs                 8bs run cx16: x16emu -prg <file> -run
packages/compiler/test/cx16-screen.test.mjs   the package's VERA addresses
docs/setup/cx16.md                       install, the wrapper trap, doctor, what the picture shows
x16-emulator 77f2bab3, x16-rom fbe32a60   the upstream revisions every fact above was read in
                                         (wherever those two repositories are checked out)
```
