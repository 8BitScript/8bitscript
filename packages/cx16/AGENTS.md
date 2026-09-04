# Writing Commander X16 support for 8BitScript

This file is for anyone — human or agent — touching `packages/cx16`,
`packages/backend-6502`'s `cx16` entries, `packages/cli/src/setup/cx16.mjs`,
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

- `packages/cx16/src/index.8bs` exports the common colour surface and the
  `screen` namespace. `border` is real but *made*: VERA's border colour has
  nowhere to show by default (the active display area fills the 640×480
  output), so `applyColors()` insets the active area by 16 pixels on every
  side and that ring takes the colour. `background` is *painted*: there is
  no register for it, so every text cell's attribute byte is rewritten
  through VERA's data port. `screen.putChar(cell, code)` takes ASCII —
  LLVM-MOS's start-up puts the KERNAL in ISO mode before `main()` — on an
  80×60 grid whose map base is read from VERA's `L1_MAPBASE` at runtime,
  not assumed. `putColor` is real (per-cell foreground nibble).
- The frame driver (`FRAME_SYNC.cx16` in `packages/backend-6502`) polls
  VERA's ISR VSYNC bit under `sei`, one `frame()` per VSYNC.
- There is no `--profile` for the X16 yet — no banked-RAM size, no
  video-output (VGA/composite) profile, no expansion-card capabilities.
- `8bs setup cx16` builds the emulator and ROM together from upstream and
  installs them under `/opt/commander-x16`; the pair this file was verified
  against is x16emu r50 (`77f2bab3`) with ROM `fbe32a60` — the same
  revisions `x16emu -version` and the boot banner report — read in
  checkouts of the upstream `x16-emulator` and `x16-rom` repositories at
  those commits.

There is no banked-memory model in the language, no far pointer, no VRAM
allocator, no asset pipeline, no sprite/tile/audio/storage/input API, and
no capability probing yet — for any machine. The rules below are what to
hold that work to when it comes; don't write docs implying it exists.

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
| LLVM-MOS's cx16 start-up prints `CHR$(15)` before `main()`. | `llvm-objdump` of a linked build |
| With a nonzero VSTART, VERA's layer line 0 lands two lines above the active area's top edge (the layer line counter starts on the VSTART line through a two-line register-history pipeline). | `video.c` ~1029-1063, and on screen |

## Corrections to the research notes

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
- **ISO mode is not the KERNAL's boot state** — it is LLVM-MOS's start-up
  choice for this platform. A raw-assembly program would find PETSCII.
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
  output (the `^O` at the end of a run is LLVM-MOS's `CHR$(15)`).
  `8bs run cx16 --screenshot <file.png>` already wraps this (needs `ffmpeg`
  on PATH) — see [`docs/setup/verify.md`](../../docs/setup/verify.md#screenshots)
  before reaching for the raw flags directly.

## Where things live

```
packages/cx16/src/index.8bs              target package: border/background/applyColors(), screen
packages/backend-6502/src/index.mjs      driver (mos-cx16-clang), FRAME_SYNC.cx16 (VERA ISR poll)
packages/cli/src/setup/cx16.mjs          8bs setup cx16: emulator+ROM pair, macOS launcher wrapper
packages/cli/src/run.mjs                 8bs run cx16: x16emu -prg <file> -run
packages/compiler/test/cx16-screen.test.mjs   the package's generated C, by VERA address
examples/borders/src/main.8bs            the working program (every target), ASCII readout at cell 0
docs/setup/cx16.md                       install, the wrapper trap, doctor, what the picture shows
x16-emulator 77f2bab3, x16-rom fbe32a60   the upstream revisions every fact above was read in
                                         (wherever those two repositories are checked out)
```
