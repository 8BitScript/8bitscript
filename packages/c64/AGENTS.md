# Writing Commodore 64 support for 8BitScript

This file is for anyone — human or agent — touching `packages/c64` (its
`.8bs` sources and `native/6502/raster.s`, `multiplex.s`, `text.s`),
this package's hardware catalog (`package.json`, `"8bitscript".hardware`:
the REU, the SID, the two control ports), `packages/compiler/src/mos`'s
`FRAME_SYNC.c64`, `packages/cli`'s `x64sc` handling (`VICE_MODEL_ARGS.c64`),
or the C64 rows of `docs/roadmap.md`, `docs/setup/vice.md`
and `packages/studio/AGENTS.md`. Read the root [`AGENTS.md`](../../AGENTS.md)
first; the rules there apply to every target and are not repeated.
[`packages/nes/AGENTS.md`](../nes/AGENTS.md), [`packages/cx16/AGENTS.md`](../cx16/AGENTS.md)
and [`packages/pet/AGENTS.md`](../pet/AGENTS.md) are the three contrasts:
almost nothing, a great deal behind windows, and only RAM with a family of
models. The C64 is a fourth case —

> **The C64 is one machine with one memory map, and every chip in it
> shares that map with the program. The VIC-II draws from one 16K window
> of the same 64K the linker allocates; the SID and both CIAs sit in the
> 4K the CPU can swap for the character ROM; the KERNAL's interrupt drives
> the keyboard chip a game wants for itself. Nothing is abstracted away by
> hardware, so the work of this package is deciding, once and in writing,
> who owns which RAM and which chip — and then keeping that promise in
> every file.**

The models (breadbin, C64C, SX-64, C64GS, Educator 64, the Japanese and
Argentine boards) differ in chips and case, not in map: one build runs on
all of them, and unlike the PET's models they are not hardware options
(see "Models are not profiles" below). What *is* fitted à la carte — the
catalog's options — is the REU, the SID, and what is in each control
port; none of them changes the build. Region (PAL/NTSC) is a runtime fact
the frame driver probes, not a build option.

## What exists today

Do not describe more than this as working:

- **The picture lives in VIC bank 3** (`src/geometry.8bs`, the `Video`
  namespace and the arrays over it): screen matrix `$E000`, sprite
  pointers `$E3F8`, 111 sprite shape blocks `$E400`–`$FFBF` (blocks
  144–254), and the character ROM's 4K copied into the RAM under the I/O
  area at `$D000`. Color RAM is the fixed `$D800`. `$D018` is `$84`
  (`Video.MEMORY_POINTER_UPPERCASE`; `$86` for the lower-case set).
  `setupVideo()` in `src/index.8bs` puts it there once — `sei`, copy the
  ROM in place (`copyCharacterRom()`: `$01` low bits `%010` for the copy,
  `%101` after), select the bank through CIA2 by masking, set `$D018` —
  and every surface calls it before its first write. Why bank 3: a linked
  program occupies `$0801`–`$CFFF` and the linker decides where every byte
  goes; `$D000`–`$FFFF` is the only RAM the linker never touches, and the
  VIC sees RAM there (its ROM windows are in banks 0 and 2). The KERNAL's
  `$0400` screen is not used at all.
- **The KERNAL is banked out from `setupVideo()` on** (`$01` low bits
  `%101`: RAM at `$A000` and `$E000`, I/O in). With the ROM mapped the
  CPU's reads of `$E000`–`$FFFF` returned KERNAL bytes, so `screenRam[cell]`
  read the ROM, a coarse scroll would have copied it and a bitmap plot
  read-modify-written it; with it out, the screen reads back (verified:
  a program prints the space code it wrote). The CPU's vectors at
  `$FFFA`–`$FFFF` are then RAM, and `native/6502/raster.s`'s `.init.250`
  section — linked into every C64 program through `"8bitscript".native`,
  22 bytes — points the NMI and IRQ vectors at a bare `rti` before
  `main()`, so RESTORE does nothing. Every window with the I/O area
  banked out (`bankIoOut()`/`bankIoIn()`, `writeUnderIo()`,
  `readUnderIo()`) is `sei` … `%100` (RAM everywhere) … `%101` … `cli`
  only if `interruptsOn`. Because the KERNAL is out and the picture is at
  `$E000`, `main()` cannot RTS to BASIC: that return snaps VIC back to
  `$0400` and the greeting vanishes (hello-world under x64sc: stock
  `READY.`, light-blue border, dark-blue playfield — not `Hello World!` at
  `$E000`). The compiler's C64 image therefore `endsByHalting` (`JMP` to
  itself, 3 bytes), the same flag the Atari uses for a different reason. A
  PET or VIC-20 still RTSs: their picture is the KERNAL's own screen.
- `src/index.8bs` names the registers: the 6510 port (`processorPort`,
  with the bank-switching table), the VIC-II (`spritePositions[16]`,
  `spriteXHigh`, `control1`, `raster`, `spriteEnable`, `control2`,
  `spriteExpandX/Y`, `memoryPointer`, `interruptStatus/Mask`,
  `spritePriority`, `spriteMulticolor`, `spriteCollision`,
  `spriteBackgroundCollision`, `borderColor`, `backgroundColor` + `1..3`,
  `spriteSharedColor0/1`, `spriteColors[8]`), the SID (`sidRegisters[25]`,
  `paddleX/Y`, `voice3Oscillator/Envelope`), CIA1 (`cia1PortA/B`,
  `cia1DirectionA/B`, `cia1InterruptControl`), CIA2 (`cia2PortA`,
  `cia2DirectionA`, `cia2InterruptControl`), and the REU (`reu*`,
  `$DF00`–`$DF0A`). Each with its bits in the comment beside it. Also the
  machine's state — `videoMode` (`VideoMode.TEXT`/`BITMAP`),
  `interruptsOn` — and `detectRegion()` (`Region.PAL`/`NTSC`): the frame
  driver's raster probe again, two frames, for a program that needs the
  answer the runtime keeps to itself.
- `src/screen.8bs` (behind `@8bitscript/screen`) and `src/text.8bs`
  (behind `@8bitscript/text`): the portable surfaces, over `Video`.
  `screen.blank()` clears `Video.CELL_COUNT` cells of `screenRam`;
  `text.putChar` takes ASCII, converts to a screen code, and writes
  `screenRam`/`colorRam` directly at any time — the VIC-II reads screen
  RAM every eighth line but a write between reads is never visible as
  "snow"; there is no vertical-blank queue and none is needed.
  `prepare()` calls `setupVideo()` and selects the upper-case set on
  every run of text, in text mode (in bitmap mode it leaves `$D018`
  alone, and the codes it writes land in the bitmap). `text.print`,
  `text.printNumber` and `text.fill` are `native/6502/text.s` (one
  section each, so a program links only the ones it calls): the `.8bs`
  functions copy their parameters to page `$07` from an `asm6502`
  block that names them and `jsr` — see "What the text routines cost"
  in the measured table.
- **C64-only subpaths** (`"8bitscript".exports` in `package.json`), the
  hardware layers a portable capability will sit on — importing one makes
  a program C64-specific:
  - `@8bitscript/c64/video` (`src/geometry.8bs`): `Video`, `Bitmap`,
    `screenRam`, `colorRam`, `spritePointers`, `spriteShapes`, `bitmapRam`.
  - `@8bitscript/c64/sprites` (`src/sprites.8bs`): `sprites.place(n, x,
    y)` with a 9-bit X, `setShape(n, block)` (the pointer is at the
    screen matrix + `$3F8`: `$E3F8` in text mode, `$DFF8` under I/O in
    bitmap mode, and it routes by `videoMode`), `setShapeByte(block, i,
    v)` (blocks 144–254 in plain RAM, 96–111 under I/O), `setColor`,
    `show`/`hide`/`hideAll`, `expand`, `setBehindBackground`,
    `setMulticolor` + `setSharedColors`, `collisions()`/
    `backgroundCollisions()` (read once a frame: the registers clear when
    read), `blockOffset(block)` into `spriteShapes`, and the constants
    (`COUNT` 8, `WIDTH` 24, `HEIGHT` 21, `BYTES` 63, `FIRST_BLOCK` 144,
    `BLOCK_COUNT` 111, `LEFT` 24, `TOP` 50). A program copies its `const`
    shape tables into blocks at start-up — a const array is data wherever
    the linker put it, which the VIC cannot see.
  - `@8bitscript/c64/pointer` (`src/pointer.8bs`): the C64 behind
    `@8bitscript/pointer` — a **mouse arrow**, and the first thing in this
    repository to draw with a sprite for a reason other than a test. It
    **owns sprite 0 and shape block 254** and says so, because a cursor
    belongs in front of everything (the VIC's order is fixed) and because
    a program laying out its own shapes counts up from `FIRST_BLOCK` and
    would otherwise land on the arrow's. `update()` reads `./mouse.8bs`'s
    accumulator in *pixels* rather than taking `input.pointerCell()`'s
    cell, so the arrow moves a pixel at a time while what the program
    hit-tests stays a cell; the tip is the sprite's top-left pixel, so
    placing it at `(LEFT + x, TOP + y)` makes the pixel the user aims at
    and the cell the program tests the same thing by construction. All of
    it is behind `#fact(input.mouse)`: 182 bytes of program and 1 of RAM
    on a build fitted with a mouse, and nothing at all on one that is not.
    See [`packages/pointer/AGENTS.md`](../pointer/AGENTS.md).
  - `@8bitscript/c64/raster` (`src/raster.8bs` + `native/6502/raster.s`):
    **a list of register writes at raster lines, not a handler of the
    program's own.** `raster.clear()`, `raster.at(line, address, value)`
    (ascending lines, up to 63 entries; `Register.BORDER`, `BACKGROUND`,
    `CONTROL_1/2`, `MEMORY_POINTER`, the sprite registers, `SID_VOLUME`;
    `raster.spriteX/Y/Color/Pointer(n)`), `insert(line, address, value)`
    (the same, at any line: later entries slide up a slot), `commit()`,
    `setValue(entry, value)` (rewrite one LIVE entry's value byte in
    place, `entry` the byte offset index * 4, and only the first byte of
    an existing 4-byte entry is accepted — an unaligned offset, or one
    whose value byte would land at or past the list's end, is refused
    untouched — a computed effect rebuilds a byte per entry each frame
    instead of re-running `at()` for the whole list), `addressOf(entry)`,
    `setFrameByte(offset, value)` + `Frame.*`, `enable()`, `disable()`,
    `count()`. **The list is double-buffered**: `clear()` and `at()`
    build the next list in whichever of two pages (`$0200`, `$0300`) the
    handler is not reading, `commit()` hands it over, and the handler
    takes it at the end of its pass — **line 255, every frame, whatever
    the last entry's line** — so a list committed before 255 is live
    from the next frame, whole. A program that builds once before
    `enable()` never calls `commit()` (`enable()` does). Each page
    carries a **frame table** (`$0400`/`$0500`, `Frame.POSITIONS`,
    `X_HIGH`, `ENABLE`, `POINTERS`, `COLORS`, `FLAG`): the eight
    sprites' registers, written by the handler at line 0 of the next
    frame if flagged — what puts multiplexed sprites back for that frame's
    top in the same interrupt that swaps the list. The handler is
    assembly the package ships: it acknowledges `$D019`, applies every
    entry on the line — **and any entry whose line the raster has
    already reached** (a cascade that falls behind catches up, never
    skips a frame) — arms `$D012` for the next entry and re-checks that
    the raster did not pass it meanwhile, saves and restores A and X,
    touches no zero page but its own `jmp` at `$FD` (see
    "Idle graphics and the ghost byte" below: **the IRQ vector's high
    byte, `$FFFF`, is the VIC's idle byte in bank 3**, so the IRQ goes
    through page zero and that byte is 0). `enable()` clears both CIAs'
    masks (the KERNAL's timer A would otherwise reach the handler and
    never be acknowledged), acknowledges the VIC, `jsr`s the install
    routine that writes the `jmp` at `$FD`-`$FF` and takes the
    committed list, sets `interruptsOn`, and `cli`s. An entry's write
    lands 58-64 cycles into its line — the right border — so **an entry
    at line L shows from line L+1**; further entries on one line land
    25 cycles apart, a bad line adds ~43. 8bitscript has no function
    values, so a program cannot name code to run at a line; what the
    list covers is color splits, split scrolling, character-set and
    screen switches, the opened border and the multiplexer below, and
    computed effects as a list rebuilt each frame.
  - `@8bitscript/c64/idle` (`src/idle.8bs`): **the idle graphics and the
    ghost byte.** `idle.GHOST` (`$FFFF`: what idle lines draw with ECM
    clear — 0 by construction, read with `ghost()`, never written),
    `idle.PATTERN` (`$F9FF`: what they draw with ECM set — block 231's
    pad byte, plain RAM; `setPattern(bits)`, `pattern()`, and an address
    a raster entry can write per line), `idle.ECM` (`$D011` bit 6),
    `firstBadLine(yscroll)`/`lastRowLine(yscroll)`, and `Pattern.*`
    (`TRANSPARENT`, `BLACK`, `DITHER`, ...). See the section below.
  - `@8bitscript/c64/border` (`src/border.8bs`): **the upper and lower
    border opened for sprites.** `border.bottom()` inserts the `$D011`
    writes that make the VIC miss its bottom comparison (RSEL clear at
    249; ECM set at 247 + YSCROLL, once row 24 is drawn), `border.top()`
    the one at 47 + YSCROLL that clears ECM and restores RSEL before the
    first bad line; `setShort(true)` for a 24-row base (an extra RSEL
    write at 245); `topLine()`/`bottomLine()`. Both go through
    `raster.insert`, from `$D011`'s current YSCROLL/DEN/BMM. The whole
    vertical border opens — upper as a consequence of lower — and shows
    sprites and the idle byte; the side borders stay. 456 bytes over a
    raster-list program (measured: `insert`'s two page paths are most
    of it).
  - `@8bitscript/c64/multiplex` (`src/multiplex.8bs`): **up to 24
    virtual sprites from the eight**, sorted by Y each frame, the eight
    topmost through the list's frame table and the rest as list entries
    (Y first, then pointer, X, `$D010`, color — only what differs) at
    the earliest line each hardware sprite is free: `setCount(n)`,
    `set(v, x, y, block, color)`, `place`, `setShape`, `setColor`,
    `hide`, `update()` (after `raster.clear()`, before `commit()`;
    returns how many draw), `dropped()`. It owns all eight hardware
    sprites — positions, `$D010`, `$D015`, pointers, colors are the
    frame table's every frame, so a sprite shown beside it with
    `sprites.show()` is disabled again at the next line 0. Text mode; the
    per-hardware-sprite bits (expand, multicolor, priority) are shared. 1287 bytes
    over a raster-list program, 184 of them tables (measured); twenty
    sprites in four rows verified (`test/multiplex-probe.8bs`).
  - `@8bitscript/c64/bitmap` (`src/bitmap.8bs`): `bitmap.enter(multicolor)`
    / `leave()`, `clear(bits)`, `plot`/`unplot`/`point(x, y)` (320×200),
    `plotColor`/`pointColor(x, y, c)` (160×200, four colors),
    `offset(x, y)`, `setCellColors(cell, fg, bg)` and `fillColors` (the
    color matrix at `$DC00`, under I/O — one window per call),
    `setCellColor3`/`fillColor3` (color RAM, multicolor's `%11`). The
    bitmap is `$E000`–`$FF3F`, `$D018 = $78`; the matrix sits in the
    lower-case set's second half so the upper-case set survives and
    `leave()` is a register change. Sprites over a bitmap draw from blocks
    96–111 at `$D800`.
  - `@8bitscript/c64/charset` (`src/charset.8bs`): `charset.define(code,
    r0..r7)`, `setRow`, `readRow`, `copy(target, source)`, `fill(code,
    bits)`, `restore()` (the ROM copy again), `setMulticolor(on)` +
    `setSharedColors`, `useLowercase()`/`useUppercase()`; `offset(code)`
    = `$D000 + 8 * code`. Every write is a window under I/O.
  - `@8bitscript/c64/scroll` (`src/scroll.8bs`): `scroll.setX(0-7)`,
    `setY(0-7)` (bit 7 of `$D011` kept clear), `setNarrow(on)` (38
    columns), `setShort(on)` (24 rows), `shiftLeft/Right/Up/Down(code,
    color)` — screen and color RAM together, the opened column or row
    filled; a thousand-cell copy each, about a frame of CPU.
  - `@8bitscript/c64/keyboard` + `/keys` (`src/keyboard.8bs`,
    `src/keys.8bs`): `keyboard.scan()` once a frame after `waitFrame()`,
    all eight columns into a snapshot, port A left at `$FF`;
    `keyboard.pressed(Key.X)`, `keyboard.column(n)`. `Key.X = column * 8
    + row`, one table for every C64 (the matrix never changed), sharing
    the PET layer's names where the key exists on both.
  - `@8bitscript/c64/joystick` (`src/joystick.8bs`): `joystick.scan()`
    after `keyboard.scan()`, both ports into a snapshot; `up/down/left/
    right/fire(port)`, `bits(port)`; `Joystick.PORT_1/PORT_2` and the
    five bits. Port 2 is the player's port, for the reason below.
  - `@8bitscript/c64/sid` (`src/sid.8bs`): `sid.setVolume`,
    `setFrequency`, `setPulseWidth`, `setEnvelope`, `setWaveform`,
    `gateOn`/`release`, `play(voice, Note.X)`, `frequencyOf(note)`,
    `setRegion(Region.X)`, `detectRegion()`, `setFilter`, `reset`;
    `Waveform.*`, `Filter.*`, `Note.C0`–`Note.B6` over two frequency
    tables, PAL (the default) and NTSC, chosen at run time. The registers
    are write-only; the control bytes are shadowed.
  - `@8bitscript/c64/reu` (`src/reu.8bs`): `reu.detect()` (KiB, 0 for
    none) and the transfers — `stash`/`fetch`/`swap`/`verify(c64Address,
    bank, address, length)` and `fillReu(bank, address, length, value)`,
    every register set per call, `$90` plus the direction as the command,
    the status register's fault bit as `verify`'s answer. The C64 side
    goes through the CPU's map as `$01` has it: `$E000` is the screen's
    RAM, `$D000` the I/O area unless a caller banks it out.
  - `@8bitscript/c64/mouse` (`src/mouse.8bs`): a 1351 in a port —
    `present()`, `poll()`, `x/y`, buttons.
- **Hardware** (the catalog in `package.json`): `ram` — `none` (default)
  or `reu128`…`reu16m`, with presets `stock` and `reu…` of the same names;
  `sid` — `6581` (default) or `8580` (`-sidmodel`); `port1`/`port2` —
  `none`, `joystick`, `paddles`, `mouse1351` (`-controlport1device`
  0/1/2/3; port 2 defaults to a joystick). **`mouse1351` passes `-mouse`
  as well** — VICE's mouse *grab* ("Enable mouse grab" in `x64sc -help`) —
  because a device in the port that the emulator has not grabbed the host
  pointer for never moves; Command+M (`Alt+M` off macOS) hands the pointer
  back, per VICE's `hotkeys.vhk`. A REU changes nothing about the
  build — it is eight registers at `$DF00` and a DMA engine — so none of
  these reaches the linker or the output name: each only fits x64sc the
  same thing, and sets a fact (`memory.banked`, `input.mouse`).
- `FRAME_SYNC.c64` (`packages/compiler/src/mos`): a *level* driver — top half
  of the frame is `$D012 < 128` with `$D011` bit 7 clear (read in that
  order), the PAL probe is a raster line past 287. The backend that
  implements it (`packages/compiler/src/mos/startup/waitframe.ts`)
  disables interrupts ONCE, a `SEI` in `waitFrame()`'s one-time start-up
  setup ahead of the region probe: **a program that calls `waitFrame()`
  runs with interrupts off from start-up**, and one that draws first has
  them off from `setupVideo()`, **until `raster.enable()`**. The
  KERNAL's 60 Hz IRQ (CIA1 timer A) scans the keyboard through the same
  ports `keyboard.scan()` uses and would race it; with it silenced the
  ports read what the program selected. `raster.enable()` silences both
  CIAs, installs the list's handler, sets `interruptsOn` and `cli`s; the
  per-call `waitFrame()` routine never touches the I flag — there is no
  per-poll `sei` — so that `cli` stays in force and the handler keeps
  firing while `waitFrame()` polls `$D012` (a poll with I set never
  shows a split; the wobble row below proves the live one on screen).
  Consequences: no
  KERNAL keyboard buffer, no jiffy clock, no RUN/STOP+RESTORE (with the
  ROM out, RESTORE's NMI is a bare `rti`), and returning from `main()`
  into BASIC is off the map. NTSC is 263 × 65 cycles at 1022727 Hz (a
  6567R8), PAL 312 × 63 at 985248 Hz (6569).
- `8bs run c64` launches `x64sc -model ntsc` (or `-model c64` with
  `--pal`), `--screenshot` through `-limitcycles`/`-exitscreenshot`.
  Other models: `docs/setup/vice.md` has the `-model` table.
- No hazard entry: no primary source documents a C64 write that damages
  hardware (see Hazards).

There is no portable input, sprite, sound, canvas or banked-memory
capability yet (these are the C64's hardware layers, not
`@8bitscript/input`/`sprites`/`sound`/`bitmap`), no interrupt handler a
program writes (a language feature — function values — this package's
raster list works around; the opened border and the multiplexer are what
the list can carry, side-border opening and FLI are what it cannot), no
extended-color text mode as a mode (ECM is set only in idle lines, for
the pattern byte), no
`.d64`/`.crt` output, no KERNAL calls of any kind (loading a file), and no
model detection. The rules below are what to hold that work to.

## Facts verified here

Cite these freely; each was read in the source named or seen on screen
under x64sc (VICE 3.10, Homebrew), not recalled.

| Fact | Where |
| ---- | ----- |
| A C64 program loads at `$0801`, usable RAM length `$C7FF` (to `$CFFF`), C stack at `$D000` growing down, BASIC ROM unmapped: start-up is `ldx #$2f / stx $00 / ldx #$3e / stx $01` (`$01 = $3E`: LORAM 0, HIRAM 1, CHAREN 1 — BASIC out, KERNAL and I/O in) and exit restores `$3F`. `$A000`–`$BFFF` is program RAM. The native backend does not emit that start-up yet. | C64 link map and start-up disassembly (measured pre-0.2.0) |
| A `.prg` starts with a BASIC `SYS` line (`basic-header.o`), so `RUN` after `LOAD` starts it; x64sc's `-autostartprgmode 1` injects it and types `RUN`. | `commodore.ld`, first screenshot below |
| Reading the character ROM with CHAREN clear and storing each byte back to the same address copies it into the RAM underneath; with the VIC in bank 3 and `$D018 = $84`, screen codes at `$E000` render from that copy (normal and reverse), and a 63-byte shape at `$E400` with pointer 144 draws as sprite 0 at (100, 100) in the sprite's color. Both sets are in the copy: the same screen codes with `$D018 = $86` render as lower case. | scratch program, `8bs run c64 --screenshot`, once per pointer value (the layout in `geometry.8bs`) |
| The same copy with the KERNAL IRQ alive hangs the machine on the BASIC screen: the IRQ handler acknowledges CIA1 by reading `$DC0D`, which with I/O banked out is the ROM, so the interrupt is never cleared and fires again on `rti`, forever. `sei` first, always. | the same scratch program, built before `presync` existed — the first screenshot showed `RUN` and nothing else |
| A color-cycling demo on the bank-3 layout: readout and colors correct, 1034 bytes of program (766 before: the ROM copy loop and the guard; 1056 since the KERNAL went out, see below). | `8bs run c64 --screenshot`, the build's memory line (pre-0.2.0) |
| A program using every subpath at once — three sprites (one at X 280 through the ninth bit, one double-size, one behind the background), text over them, `sid.play`, the two scans — builds to 1549 bytes and draws as written; sprite 0 at (24, 50) covers the first cell of the top row, i.e. (24, 50) is the screen's top-left pixel. | scratch program, screenshot |
| The `Key` table matches VICE's positional C64 keymap at every host key whose C64 key is unambiguous (letters, digits, and ~30 others): the vkm's first number is the `$DC00` bit, its second the `$DC01` bit (`Return 0 1`, `space 7 4`, `Escape 7 7` = RUN/STOP, `Control_L 7 5` = the C= key, `Tab 7 2` = CTRL). | `/opt/homebrew/share/vice/C64/gtk3_pos.vkm`, `packages/compiler/test/c64-package.test.mjs` |
| x64sc's models: `c64` (PAL, 6569, 6581, 6526, KERNAL rev 3), `c64c` (PAL, 8565, 8580, 6526A), `c64old` (PAL, 6569R1, rev 2), `ntsc` (6567R8, 6581), `newntsc` (8562, 8580, 6526A), `oldntsc` (6567R56A, 6581, KERNAL rev 1), `drean` (PAL-N, 6572), `jap` (NTSC, Japanese KERNAL/chargen), `c64gs` (PAL, 8580, GS KERNAL), `pet64` (4064 KERNAL), `ultimax` (no KERNAL); `-sidmodel` 0 6581 / 1 8580 / 2 8580 + digiboost; `-reusize` 128–16384 KiB; `-VICIImodel` 6569, 6569r1, 8565, 6567, 8562, 6567r56a, 6572. | `x64sc -help`, VICE's `c64/c64model.c` |
| The SID frequency formula `f = Fn × clock / 2^24` gives `Fn = 7493` for A4 on PAL, 440.02 Hz back; the table's last entry, B6, is 33640. B7 would overflow 16 bits on PAL (the ceiling is about 3848 Hz); C7–A#7 would fit, and the table stops at the last complete octave by choice. | the 6581 datasheet formula, `c64-package.test.mjs` recomputes the table |
| **What the text routines cost** (CIA 2 timer A around one call each, `test/text-timing-probe.8bs`, printed once and read off the capture, 2026-09-19; each count carries the compiled call and `prepare()`, ~150 cycles, and a bad line or two): under the compiler's generic code `text.print(0, "FRAME 123")` was **1,908** cycles (~210 a character: a `place()` call and two more inside it for every cell — the "~60 raster lines per nine characters" the multiplex probe's loop paid), `printNumber(40, 12345, 5)` **2,944**, `fill(80, 40, 42)` **8,078**. With `native/6502/text.s`: **498**, **1,265** and **1,110** — ~28 cycles a character, ~20 a filled cell, and a number its place-value subtractions (~40 each, 15 for 12345) plus ~60 a digit. Bytes (`8bs build c64`): hello-world 406 → 393 of program, 8 → 12 of zero page (`print` is a call with a four-byte frame now, not an unrolled literal); swarm 4,622 → 4,744 (the print and number routines, 91 and 184); fancy 2,414 → 2,456; joystick 2,526 → 2,558, each with fewer zero-page bytes. The swarm's `FRAME` at `--frames 600` is 380 before and after. What the routines write is `test/text-probe.8bs`'s 41 checks, read back from the matrix and color RAM: mixed case, reverse, the three number widths, a fill across `$E100`, the empty string. | `test/text-timing-probe.8bs`, `test/text-probe.8bs` under `test/layers.test.mjs`, the captures |
| `-ntsc`/`-pal` alone only change VICE's sync factor and leave the model's geometry; `-model` switches ROMs, VIC-II and timing together, which is why `8bs run` uses `-model`. An earlier at-line-0 frame check fired twice a frame because `$D012` wraps at 256 on a 263/312-line frame. | `packages/cli/src/run.mjs`, `FRAME_SYNC.c64`'s comment (measured under VICE) |
| The catalog's stock fact sheet: grid 40×25 of 8×8, 16 colors, 2 per cell, 256 RAM glyphs, 2×2 blocks, bitmap, one layer with fine scroll, 8 sprites and 8 per line, 24×21, 3 colors (multicolor); 3 SID voices with ADSR, filter, samples through the volume register, a volume per voice, oscillator 3 as a random source; keyboard, two ports, no pads; disk; 51199 bytes (`$0801`–`$CFFF`), nothing banked until an `ram=reu*` value says so (`memory.banked`, `memory.bankedKib`), no mouse or paddles until a port value says so. | `src/geometry.8bs`; the `link.ld` and SID rows above; the VIC-II and SID sections of the research notes below; `package.json` (read) |
| `@8bitscript/c64/reu` — `reu.detect()`: presence by a `$DF02` round trip ($55 then $AA), size by stashing a marker to the first byte of each 64 KiB bank and watching bank 0 for the wrap or the bank for silence. VICE's `reu.c`: the bank register's unused bits are `0xF8` on the 128/256/512 KiB units (`reg_bank_unused`, forced high on read, masked on write) and 0 above; the address wraps at `wrap_around` (`0x20000` for 128 KiB, `0x80000` for 256/512, the size for larger); `$DF02`–`$DF05` read back what was written; the status register's bit 4 is the 256K-chip flag. Under x64sc the probe printed 0 / 128 / 256 / 512 / 1024 / 16384 KiB for no REU, `ram=reu128`, `reu256`, `reu512`, `reu1m`, `reu16m` — the 3-bit bank register, the 256 KiB unit that aliases inside a 512 KiB wrap, the 8-bit register with the wrap at the unit's size, and the register wrapping to zero — and the border took the color `test/reu-probe.8bs` encodes for each. Cost: `test/reu-probe.8bs` is 810 bytes of program with `reu.detect()` and 628 with the same code reading its answer from RAM instead — 182 bytes for the probe, most of it the bank loop (the first draft, one helper setting nine registers per transfer and inlined four times, was 459; autoload took it down). A program that does not import `./reu` carries none of it. | `src/reu.8bs`; VICE `src/c64/cart/reu.c` (fetched 2026-09-05); four screenshots (ran); `test/reu.test.mjs` |
| `@8bitscript/c64/mouse` — a 1351's presence and movement. At rest, with `-controlport1device` at each of its four settings and the pot lines pointed at port 1 (`$DC00 = $40`), the SID's `$D419`/`$D41A` read: nothing **255**, joystick **255**, paddles **255**, 1351 **64** — which is `(0 & 0x7f) + 0x40`, the zero of VICE's `mouse_get_1351_x`. So a reading in 64..191 is what says a mouse, and `present()` is that test; a real paddle at mid-travel would read there too, so it means "consistent with a 1351", not proof. Movement is the signed 7-bit difference of two pot readings; buttons ride the joystick lines, left on FIRE and right on UP (`mouse_1351.c`). **Presence is decided once, in `poll()`, from the same reading movement comes from, and `present()` returns what that poll saw** — it used to re-read the registers, and because the SID's converter runs continuously, two reads in one frame disagreed: with a 1351 fitted in port 1, `@8bitscript/c64/input`'s `poll()` concluded *no pointer* in the same frame that a read a few instructions later found one, so `@8bitscript/c64/pointer`'s arrow was hidden and shown on alternate frames and never appeared. One reading a frame, shared by every caller. **Movement now is exercised, but only by hand** — `--screenshot` cannot move a host pointer, and moving one under x64sc was seen to move the reported cell. **Y runs opposite the screen**: applying the same sign as X moved the arrow up when the mouse moved down (Studio, 2026-09-07), so `poll()` swaps last and now on that axis and leaves rest at the top-left. **Bit 0 is SID ADC noise, not motion**: at rest under x64sc the pots sit in 64..65 (VICE's `makepotval` adds `rand(0, 1)` for a 1351), and a driver that stepped on all seven bits walked the pointer ±1 pixel a frame, including with the host mouse ungrabbed. Masking to bits 1–6 (`$7E`) and ignoring `|delta| < 3` while still updating `last` stopped the drift and also ate slow host motion — a trackpad step is often 1–2 counts a frame, so the pointer hung until the host jumped (Studio, 2026-09-07). `step()` now confirms a 1-count before tracking, then applies each further 1-count, and idles on a still frame. Cost: `test/mouse-probe.8bs` is 1275 bytes of program with the driver and 1027 with a bare pot read — 248 bytes. | `src/mouse.8bs`; VICE `src/joyport/mouse_1351.c` (fetched 2026-09-05); four screenshots (ran); `test/reu.test.mjs` |
| With the KERNAL banked out (`$01` low bits `%101`) a program that writes the space code to `screenRam[100]` and prints what it reads back prints 32; the borders example (1056 bytes now, 1034 before) and the all-subpath program (1571 against 1549) build and draw as before — 22 bytes each: the vector stub, its `.init` section and the port switch. A program that never imports `./raster` links `__8bs_c64_rti` and nothing else from `raster.s`; one that does links the install routine and the handler too. | scratch programs, linked-image symbol map (pre-0.2.0), screenshots |
| hello-world that RTSs after `setupVideo()` is the stock boot picture — light-blue border, dark-blue playfield, `READY.` at the top left — not the black screen and `Hello World!` written at `$E000`. `MachineImage.endsByHalting` makes `main()` spin (`JMP` to itself, 3 bytes) the way Atari does; the capture is then black with the greeting at cell 0. A PET or VIC-20 still RTSs. | `8bs run c64 --screenshot` of `packages/examples/hello-world`; `mos/image.ts` `C64`; `test/layers.test.mjs` |
| **The raster list**: four `raster.at` entries (border red at 100, green at 150, yellow at 200, blue at 240) draw four bands down the border, top to bottom, while the frame loop keeps counting frames and printing (the frame driver's poll is unbothered by the interrupt). `.init.250` runs before `main()` (an `.init` section storing to `$D021` was seen to run first), per-routine sections let the linker drop the handler from a program that never names it, and `asm6502 { jsr __8bs_c64_raster_install }` reaches a native symbol by name. The emitted `__asm__` carries no clobbers, so the routine saves A and X itself. | `test/raster-probe.8bs` under `test/layers.test.mjs` (a pixel per band), the scratch programs |
| **Bitmap mode** at `$E000` with the color matrix at `$DC00` (`$D018 = $78`): a rectangle plotted at (40–119, 40–99) and a diagonal line draw white on blue cells; cell 0 given red-on-black draws black (no bit set); a sprite whose 63 bytes were written to block 96 under the I/O area, pointer written at `$DFF8` under the I/O area, draws yellow over the bitmap; `leave()` back to text needs no ROM copy (the upper-case set was untouched). | `test/bitmap-probe.8bs` under `test/layers.test.mjs`, scratch screenshot |
| **Character set and scroll**: `charset.fill(1, 255)` and `charset.define(2, $FF, $81 × 6, $FF)` turn a row of A's into solid blocks and a row of B's into hollow boxes, including the A inside "CHARSET"; two `shiftRight` and one `shiftDown` move all three rows by two columns and one row; `setNarrow(true)` plus `setX(4)` show as the 38-column window. | scratch program, screenshot and pixel reads |
| **REU transfers** against `ram=reu512`: the screen filled with code 160, stashed into bank 1 at `$1000`, blanked, `verify` false, fetched back, `verify` true, `fillReu` of 40 spaces then `fetch` blanks row 0 and `swap` blanks row 1 while rows 2–24 keep the glyph — green border, "REU 00512 KIB"; a stock C64 tries nothing (red). Length 0 as 65536 is from the register description, not run. | `test/reu-transfer-probe.8bs` under `test/layers.test.mjs` |
| **The region probe**: `detectRegion()` returns NTSC under `-model ntsc` and PAL under `-model c64`, and `sid.frequencyOf(Note.A4)` is 7218 on the first and 7493 on the second: `round(440 × 2^24 / 1022727)` and `/ 985248`. | `test/region-probe.8bs` under `test/layers.test.mjs`, both models |
| An `@address` global is emitted as a C `#define`, so its name is a macro across the whole translation unit: a global named `index` or `end` broke every function with a parameter of that name (`sprites.place(index, …)`). Names of `@address` globals in a package must be ones no parameter anywhere will use (`rasterList`, `rasterEnd`, `rasterIndex`). | a build of the first raster.8bs; `packages/compiler/src/mos` emits them as `#define` |
| **The wobble band** (`raster.setValue`): 24 `$D016` entries following a 32-entry sine, one entry per **two** scanlines — a 48-scanline band, six text rows, lines 100–147 — lines and addresses written once with `raster.at`, all 24 value bytes rewritten every frame with `raster.setValue` — draws its scanlines at different horizontal offsets (the capture shows the whole 160–167 edge sweep), inside `$D021` splits (black above, red behind the band), read from the screenshot by where each line's white/background edge sits. One entry every second line, not every line: the handler (~55 cycles) cannot finish inside a bad line's ~20 CPU cycles, and a cascade that falls a line behind sets `$D012` to a line the raster is already on and misses a frame — with per-line entries the capture showed a solid red picture with one stray notch; two lines per entry is the pitch that keeps the 24-entry cascade on time, the band's six bad lines (107, 115, ..., 147) included, so the 24-byte-per-frame rebuild rides that spacing. The below-band `$D021` split is the frame-loop witness: built BLUE, `setValue`d to green only after sixty `waitFrame()` returns, so green below the band in the 500-frame capture proves `raster.enable()`'s `cli` survives into the loop and the handler still fires while `waitFrame()` polls (a 250-frame capture of the same build still shows that pixel blue; a dead handler leaves the whole screen one color). Cost: the probe is 1029 bytes of program with the raster import and 625 with the same screen fill and frame loop without it — 404 bytes for the list, its handler and install routine, `at`, `setValue`, `clear` and `enable`. | `test/wobble-probe.8bs` under `test/layers.test.mjs` (edge position per scanline, the blue→green switch), the two builds' memory lines |
| **The ghost byte is the IRQ vector's page.** `POKE 53265,31`'s shape (`scroll.setY(7)`, 25 rows, the raster list enabled) over a blue playfield: the four idle lines 51-54 drew `....#.#.` across every cell — `$0A`, the page the linked handler happened to be at — because bank 3's `$3FFF` is `$FFFF`. With `raster.s`'s IRQ target at `$00FD` (`jmp` handler, or `rti` before `enable()`) the same capture shows four solid blue lines, and `idle.ghost()` reads 0 (the border the probe turns green). The compiler's C64 zero-page budget ends at `$FD` for this. | `test/idle-probe.8bs` under `test/layers.test.mjs`, the two captures (2026-09-19); `packages/compiler/src/mos/index.ts` `C64_ZP_BUDGET` |
| **The border opens.** `border.bottom()` (RSEL clear at 249, ECM at 250 with YSCROLL 3) and `border.top()` (at 50): over a red border and a blue playfield the capture shows blue from line 28 (the first captured) to 50 and from 251 on, red only in the side columns, a sprite at Y 20 on lines 21-41 and one at Y 252 on lines 253-273 — across the NTSC frame's end into the next frame's lines 0-10 — and the pattern byte's `raster.at` writes exactly where set: black on 46-50 and 251-254, blue from 255. No stray partial line at any of the four `$D011`/`$F9FF` transitions: each entry's write is in its line's right border. | `test/border-probe.8bs` under `test/layers.test.mjs`, pixel rows classified across the whole width |
| **An entry at line L shows from L+1.** The raster probe's `at(100, BORDER, red)` is red from PNG row 73 = line 101; the picture's green from row 23 = line 51; the border again from row 223 = line 251. So this VICE's NTSC capture maps raster line L to row **L − 28** (not L − 20 as recorded earlier — the old bands were wide enough to pass either way), and the handler's first store is at cycles 58-64 of its line, past the display window (cycle ~57), as the cycle count in `raster.s` says. | `test/raster-probe.8bs`, `test/border-probe.8bs`, `test/multiplex-probe.8bs` (2026-09-19) |
| **Twenty sprites from eight.** Four rows of five solid blocks 40 lines apart, one hidden, every sprite moving a pixel a frame for 32 frames with the list cleared, rebuilt and committed each frame: all twenty at their final positions in their row's color, 21 lines tall, the hidden one's spot playfield, `SHOWN 20 DROPPED 00`. The probe's loop took several frames per iteration (its `text.print`s cost ~60 raster lines per nine characters under the compiler's code — see "What the text routines cost") and the picture is still whole, because the eight topmost are restored by the handler's frame table rather than by program code that has to run every frame — the first draft wrote them from `update()` and lost them on every frame it did not run. A list of ~45 entries at three-line intervals (`test/zz-dense`, since deleted) ran at full frame rate: the handler's late catch-up does not storm. | `test/multiplex-probe.8bs` under `test/layers.test.mjs` (`--frames 450`), the two captures |
| Sizes (`8bs build c64`, the memory line): a program with `screen.blank` and `waitFrame()` is 415 bytes; with the raster list rebuilt and committed each frame 1021; plus `border.top()`/`bottom()` 1477; plus the multiplexer (sixteen sprites) instead 2308. | scratch programs, 2026-09-19 |
| A binop computes at its operands' own width (`packages/compiler/src/mos`'s exact-width design): `block * 64` with `block: utinyint` wraps at 8 bits, so `sprites.setShapeByte`'s bitmap branch wrote block 96's bytes into program RAM at `$C000` and sprite 0 drew the lowercase charset copy that lives at `$D800` instead of the shape — glyph noise on screen, not a diagnostic. Widen through a `usmallint` local before the multiply (`blockOffset` had the same shape; `bitmap.8bs` avoids it with its `ROW_OFFSET` table). | `test/bitmap-probe.8bs` under x64sc (the sprite drew glyphs until the widening), `src/sprites.8bs` |

## From the sources, not verified here

Leads to confirm the first time code depends on them. Christian Bauer's
*The MOS 6567/6569 video controller (VIC-II) and its application in the
Commodore 64* (`zimmers.net/cbmpics/cbm/c64/vic-ii.txt`) is the primary
reference for the VIC-II; the 6581 datasheet and oxyron.de's register
maps for the SID; the VIC-II, SID and CIA register maps for the
chips' register order; c64-wiki.com for the rest.

**Memory map.** `$0000`–`$00FF` zero page (`$02`–`$8F` BASIC's;
`$90`–`$FF` the KERNAL's); `$0100`
stack; `$0200`–`$03FF` KERNAL/BASIC workspace (`$0314`/`$0316`/`$0318`
the IRQ/BRK/NMI vectors, `$033C`–`$03FB` the cassette buffer, `$02A7`–
`$02FF` and `$0334`–`$033B` unused — all dead here, and this package's
raster list takes `$0200`–`$03FE` for its two pages and state, the REU
probe byte `$03FF`); `$0400`–`$07FF` the KERNAL's screen
(pointers `$07F8`; dead here too — the frame tables are at `$0400` and
`$0500`); `$0800`–`$9FFF` BASIC RAM (38911 bytes free to BASIC
from `$0801`; a linked program's region is bigger because BASIC is out); `$A000`–
`$BFFF` BASIC ROM / RAM; `$C000`–`$CFFF` RAM; `$D000`–`$DFFF` I/O (VIC-II
`$D000`–`$D3FF` mirrored every 64 bytes, SID `$D400`–`$D7FF` every 32,
color RAM `$D800`–`$DBFF`, CIA1 `$DC00`, CIA2 `$DD00`, I/O 1 `$DE00`,
I/O 2 `$DF00`) or the 4K character ROM; `$E000`–`$FFFF` KERNAL ROM / RAM.
Writes to a ROM address always go to the RAM underneath.

**The processor port** (`$01`, direction `$00`): bit 0 LORAM (BASIC ROM at
`$A000`), bit 1 HIRAM (KERNAL at `$E000`), bit 2 CHAREN (1 = I/O at
`$D000`, 0 = character ROM — only when at least one of the other two is
set; all three clear is 64K RAM), bits 3–5 cassette write, sense, motor.
With the cartridge lines GAME/EXROM there are 14 distinct configurations;
without a cartridge, the eight from bits 0–2. `$3E` (LORAM clear) is what
start-up leaves (pre-0.2.0): RAM at `$A000`, I/O at `$D000`, the KERNAL at `$E000`.

**VIC-II timing** (Bauer §3): 6569 (PAL) 312 lines × 63 cycles, 6567R8
(NTSC) 263 × 65, 6567R56A (old NTSC) 262 × 64; the CPU clock is the
color crystal ÷ 18 (PAL 17734472 Hz → 985248) or ÷ 14 (NTSC 14318181 →
1022727). The Drean 6572 (PAL-N) is 312 × 65, at a clock near NTSC's
(the exact figure is not in a source read here). **Bad lines**:
on every raster line in `$30`–`$F7` whose low three bits equal YSCROLL
(one line in eight with the default scroll, 25 of them a frame) the VIC
takes the bus for 40–43 cycles to fetch the next row's 40 screen codes
and colors — the CPU gets about 20 of 63 cycles on those lines. Sprites:
each active sprite costs its 3 fetches per line it covers (about 2 CPU
cycles, plus the bus takeover). Overall the CPU keeps roughly 90–95% of
the cycles with nothing but text on; the user's notes' "half" is wrong.
`$D011` bit 4 (DEN) off blanks the picture and *removes* bad lines.

**VIC-II registers.** `$D000`–`$D00F` sprite X/Y, `$D010` X bit 8s,
`$D011` (RST8, ECM, BMM, DEN, RSEL, YSCROLL), `$D012` raster, `$D013`/
`$D014` light pen, `$D015` sprite enable, `$D016` (RES, MCM, CSEL,
XSCROLL), `$D017` Y-expand, `$D018` (VM13–VM10 screen in 1K steps, CB13–
CB11 charset in 2K steps — bitmap uses CB13 only), `$D019`/`$D01A`
interrupt status/enable (raster, sprite-background, sprite-sprite, light
pen), `$D01B` sprite-behind-background, `$D01C` sprite multicolor, `$D01D`
X-expand, `$D01E`/`$D01F` collisions (cleared by reading), `$D020` border,
`$D021`–`$D024` backgrounds 0–3, `$D025`/`$D026` shared sprite colors,
`$D027`–`$D02E` sprite colors. Text modes: standard (2 colors a cell:
color RAM + background 0), multicolor (MCM: cells with color-RAM bit 3
set are 4×8 double-width pixels in background 0/1/2 + the color's low
three bits), extended color (ECM: 64 characters, the code's top two bits
pick background 0–3). Bitmap modes: hi-res (8K, 2 colors a cell from
screen RAM's two nybbles) and multicolor (4 a cell). The sixteen colors
are fixed; the palette is not "8 base + 8 bright".

**Sprites** (Bauer §3.8): 24×21, 63 bytes in a 64-byte block, pointer =
address ÷ 64 at screen + `$3F8` + n, fetched from the current bank; X 0–
511, Y 0–255; the display window with RSEL/CSEL set is X 24–343, Y 50–249
(38-column/24-row modes shrink it to 31–334 / 55–246); a sprite is drawn
when its Y equals the raster line's low byte, so Y 250+ is under the
bottom border and X 344+ (to 487) in the right border/blanking. Priority
among sprites is fixed by number; `$D01B` decides each sprite's priority
against the background's *foreground* pixels (background 0 always shows
through transparent pixels). Multicolor sprites: 12×21, pixel pairs `01`
shared color 0 (`$D025`), `10` own color, `11` shared color 1
(`$D026`). Expansion doubles the size, not the data. Eight sprites per
raster line is the whole limit — there is no "8 of 64" as on the NES —
and more objects means multiplexing across raster lines, which is
raster-list entries (`@8bitscript/c64/raster`).

**VIC bank** (`$DD00` bits 0–1, inverted): `%11` bank 0 `$0000`, `%10`
bank 1 `$4000`, `%01` bank 2 `$8000`, `%00` bank 3 `$C000`. The character
ROM appears to the VIC at `$1000`–`$1FFF` in bank 0 and `$9000`–`$9FFF` in
bank 2 (RAM there is invisible to it); banks 1 and 3 see RAM everywhere.
`$DD02` bits 0–1 must be outputs. The other bits of `$DD00` are the
serial bus and RS-232 — mask, never store a literal.

**SID** (`$D400`, 6581/8580): three voices × (16-bit frequency, 12-bit
pulse width, control: gate/sync/ring/test/triangle/sawtooth/pulse/noise,
attack/decay, sustain/release), filter cutoff 11 bits (`$D415` low three,
`$D416` high eight), `$D417` resonance and routing, `$D418` mode and
volume, `$D419`/`$D41A` paddles, `$D41B`/`$D41C` voice 3 out. `f = Fn ×
clock / 2^24`; pulse width `$800` is square. Attack 2 ms–8 s, decay/
release 6 ms–24 s by nybble. 6581 vs 8580: different filter (the 6581's
is the "warm" one and varies chip to chip), the 6581's volume-register
click that made 4-bit sample playback work (the 8580 needs a resistor mod
for it), combined waveforms only on the 6581. A noise waveform on voice 3
with `$D41B` readable is the machine's hardware entropy.

**CIA1** (`$DC00`): port A out = keyboard columns / joystick 2 in (bits
0–4: up, down, left, right, fire, active low; bits 6–7 select which
port's paddles the SID reads), port B in = keyboard rows / joystick 1;
`$DC02`/`$DC03` direction (`$FF`/`$00` from the KERNAL); timer A drives
the KERNAL's IRQ at ~60 Hz; `$DC0D` interrupt control, cleared by
reading. RESTORE is wired to the CPU's NMI line, not into the matrix
(the KERNAL's NMI handler reads CIA2's `$DD0D` to tell it from RS-232). **The matrix** (column = `$DC00`
bit, row = `$DC01` bit): 0: DEL, RETURN, CRSR→, F7, F1, F3, F5, CRSR↓ ·
1: 3, W, A, 4, Z, S, E, LSHIFT · 2: 5, R, D, 6, C, F, T, X · 3: 7, Y, G,
8, B, H, U, V · 4: 9, I, J, 0, M, K, O, N · 5: +, P, L, −, ., :, @, , ·
6: £, *, ;, HOME, RSHIFT, =, ↑, / · 7: 1, ←, CTRL, 2, SPACE, C=, Q,
RUN/STOP. No diodes: three keys can ghost a fourth.

**REU**: `$DF00` status, `$DF01` command (bit 7 execute, bit 4 autoload,
bits 0–1 direction), `$DF02`–`$DF03` C64 address, `$DF04`–`$DF06` REU
address and bank, `$DF07`–`$DF08` length, `$DF09` interrupt mask, `$DF0A`
address control. 1700 = 128K, 1764 = 256K, 1750 = 512K; VICE emulates up
to 16M. Transfers run at one byte per cycle with the CPU halted.

**The 1541** is not a poke: the drive's head can be commanded past its
stop and damaged by a drive-side program; nothing in memory does it.

## Corrections to the research notes

The notes that prompted this file are largely right on the chips and wrong
in the places where secondary sources tend to be. The following in them
are wrong, misleading, or unverified:

- **"1.0 MHz (PAL)."** 0.985 MHz PAL, 1.023 MHz NTSC; both matter for
  every timing figure and the SID's pitch.
- **"$0800–$9FFF (39,711 bytes)"** beside "38,911 bytes free": 38911 is
  BASIC's figure from `$0801`; a linked program's region is `$0801`–
  `$CFFF`, 51K, because BASIC is unmapped. Neither is "39,711".
- **"No graphics or buffers should be placed in [$1000–$1FFF and $9000–
  $9FFF] (the CPU can't see them when VIC is active)."** Backwards. The
  CPU sees RAM there always; the *VIC* sees the character ROM there in
  banks 0 and 2. The rule is: don't put VIC data there. This package's
  bank 3 has no such window.
- **"Roughly half the CPU cycles are stolen for video refresh."** No: one
  line in eight loses ~40 of 63 cycles, plus ~2 per sprite per line. Text
  alone leaves the CPU well over 90%.
- **"Sprites don't have priority masks (a hardware sprite always covers
  the background)."** `$D01B` puts any sprite behind the background's
  foreground per sprite; only sprite-to-sprite order is fixed.
- **"Each has its own colr mode … single-color (plus common background)."**
  Each sprite chooses hi-res (one color) or multicolor (its color plus
  the two shared) individually.
- **"The palette has 16 fixed colors (8 base + 8 bright variants)."** The
  sixteen are fixed, but they are not eight pairs; orange, brown, and the
  three greys have no "base" partner.
- **"C64 has no built-in cartridge slot (it uses an external expansion
  port)."** The expansion port *is* the cartridge slot; every C64
  cartridge plugs into it, and the C64GS is nothing but.
- **"A serial IEC bus connects 1541-style floppy or Datasette (device
  8)."** The Datasette is device 1 on its own cassette port; disk drives
  are IEC device 8 and up.
- **"Use the built-in BITMAP modes or fill commands (in BASIC)."** C64
  BASIC 2.0 has no graphics commands at all; those are BASIC 3.5/7.0 on
  the Plus/4 and C128.
- **"Avoid writing graphics registers ($D000+)"** and **"8bitscript should
  validate writes to $D000–$DFFF … maybe warn about $D021–$D022 timing."**
  Writing the VIC-II is the whole job; a mid-frame write shows from that
  raster line on, which is a visual choice, not a hazard. The root
  `AGENTS.md`'s bar for a diagnostic is hardware damage, and no C64 write
  meets it (see Hazards). Do not add one.
- **"Some filters on early 6581 SIDs distort more"** is a nuance, not a
  rule: the 6581's filter is non-linear and varies chip to chip (the 8580's
  is closer to the datasheet), and that character is the one musicians
  prefer. Don't write code that assumes either.
- **"BASIC's interrupt support is weak"**: irrelevant here — nothing runs
  under BASIC, and interrupts are off.
- **"The NES has 54 palette entries … C64 sprites (8 total on-screen) are
  higher resolution"**: the comparison rows are anecdote, not spec; keep
  numbers out of prose unless verified.
- **"SID's oscillator 3 as a PRNG"** is right as *hardware entropy*, and
  the root file already says where that goes: an explicit, optional
  import, never under the deterministic PRNG.
- **"~40 cycles bad lines, 8th scanline"**: right, with the YSCROLL
  condition that makes "every eighth" true only at the default scroll.

## Three things the VIC-II does that its manual does not say

The Programmer's Reference Guide describes a 40×25 window with a border
around it, eight sprites, and a raster register. The chip does more, and
this package exploits three of the things it does — each verified under
x64sc (the rows above), each with its mechanism from Bauer's article
(`zimmers.net/cbmpics/cbm/c64/vic-ii.txt`, §3.5, §3.7, §3.8.1, §3.9,
§3.14) so that the recipe is a consequence of the mechanism and not a
cargo cult. The section numbers below are Bauer's. Read this before
touching `raster.s`, `raster.8bs`, `border.8bs`, `idle.8bs` or
`multiplex.8bs`; the rules at the end are what those files hold to.

### 1. The vertical border can be opened, and sprites show through it

**Mechanism (§3.9).** Two flip-flops draw the border. The *main* one is
set when the raster's X reaches the right comparison value (344, or 335
with CSEL clear) and reset when it reaches the left one (24 / 31) — *if
the vertical flip-flop is not set*. The *vertical* one is set "if the Y
coordinate reaches the bottom comparison value in cycle 63" — line 251
with RSEL set (25 rows), 247 with it clear (24) — and reset when Y
reaches the top value (51 / 55) with DEN set. "The comparisons only
match if the values are reached precisely. There is no comparison with
an interval." While the vertical flip-flop is set the main one cannot
reset, so the whole line is border; and "the vertical border flip flop
controls the output of the graphics data sequencer" — with it set, the
sequencer outputs background color under the border.

**Recipe (§3.14.1, "Hyperscreen").** With 25 rows on, let line 247 pass,
then in lines 248-250 clear RSEL. The bottom comparison is now 247,
already passed; at 251 nothing matches; the flip-flop is never set. And
nothing sets it later: the top comparison at 51 only *resets*, and it is
reset already. So it stays clear through the rest of the frame, through
the vertical blank, and through the next frame's top lines until the
first row — **the upper border opens as a consequence of the lower one,
and there is no way to have one without the other.** Set RSEL again
anywhere before 247 comes round (`border.top()` does it at 47 + YSCROLL)
and repeat every frame; forget a frame and the border is back for that
frame. Two `$D011` writes a frame, both list entries, no program code.

**What appears there.** Outside lines 48-247 no bad line can occur
(§3.5), so the VIC is in *idle state* (§3.7.1) — it draws the idle byte
(below) — and it fetches and draws **sprites on every line of the frame
whatever the state**. That is the point: a sprite's Y is 0-255 and it
draws on lines Y+1 to Y+21, so with the border open a sprite can be
anywhere from line 1 to 276 — off the top of the playfield and off the
bottom, whole. Text and bitmap graphics cannot be shown there (no bad
lines, no matrix fetch); the idle byte and sprites are the whole
vocabulary. The *side* borders stay: opening them needs a CSEL write in
one exact cycle of every line ("the change from CSEL=1 to CSEL=0 has to
be exactly in cycle 56"), which a list applied from an interrupt that
lands 58-64 cycles into a line cannot do, and this package does not
pretend to.

**The lines, and why** (`border.8bs`): RSEL clear at **249** — an entry
lands at the end of its line, so 249 is after 247's comparison and a
whole line before 251's, with room for another entry or two queued
ahead of it on the same line. ECM set (for the pattern byte) at **247 +
YSCROLL**, the last pixel line of row 24 — not earlier, because ECM
changes how codes 64-255 render while the row is still being drawn;
with YSCROLL 3 that is 250, with 0-2 it is one write with RSEL's at 249,
with 4-7 opening the border also reveals the 1-4 lines of row 24 the
border used to cover. ECM clear and RSEL set at **47 + YSCROLL**: the
last idle line before the first bad line at 48 + YSCROLL. DEN is never
touched — "a Bad Line Condition [needs] the DEN bit ... set during an
arbitrary cycle of raster line $30". With a 24-row base RSEL must be
*set* by 246 (so 247's comparison uses 251) and cleared again by 250;
`border.setShort(true)` adds the write at 245.

**Using it.** `sprites.place(n, x, 252)` is a sprite in the lower border;
`sprites.place(n, x, 20)` in the upper. A multiplexed sprite goes there
the same way (`multiplex.set(v, x, 240, ...)`). Bauer's caveat and
ours: on NTSC (263 lines) a sprite past Y 242 continues into the next
frame's lines 0-10 — the VIC counts on — and the frame table restores
the registers at line 0 (it did at 255, and a multiplexed sprite at Y
240 drew its last three rows at its next frame's X — seen in the
sprites probe, 2026-09-19), so those rows are in vertical blanking,
invisible. On PAL (312 lines) Y 255 ends at 276, well inside the frame.

### 2. Idle graphics, and the ghost byte

**Mechanism (§3.7.1, §3.7.3.9).** The VIC is in *display state* from the
first bad line of a frame to cycle 58 of the last row's last line, and
*idle state* everywhere else. In idle state "only g-accesses occur. The
access is always to address $3fff ($39ff when the ECM bit ... is set).
The graphics are displayed by the sequencer exactly as in display state,
but with the video matrix data treated as '0' bits." With the matrix
data 0, in every text mode a `1` bit is color 0 — black — and a `0` bit
is `$D021`. So one byte, repeated across the line, eight pixels a cell,
black over the background: **the idle graphics**, drawn from the last
byte of the VIC's 16K bank — the byte demo coders call the ghost byte.
In bitmap mode both of a hi-res cell's colors come from the (zero)
matrix data, so the idle area is solid black whatever the byte; in
multicolor bitmap only `%00` pairs show `$D021`.

Where a program sees idle lines: (a) the gap YSCROLL opens — with 25
rows on and YSCROLL 4-7 (`POKE 53265,31` is YSCROLL 7) the window
starts at 51 but the first bad line is at 48 + YSCROLL, and the lines
between are idle: "If you set a YSCROLL other than 3 in a 25 line
display window and store a value not equal to zero in $3fff you can see
the stripes"; YSCROLL 0-2 puts the gap below row 24 instead; (b) the
opened border, all of it; (c) the lines an FLD effect holds the VIC in
idle by stepping YSCROLL so no bad line matches (§3.14.2) — a program
can do that with `$D011` entries, one per gap line, within what the list
can afford.

**The finding that shaped this package.** Bank 3's `$3FFF` is `$FFFF` —
the high byte of the 6510's IRQ vector. With the raster handler linked
into program RAM at `$0Axx`, the four gap lines of the YSCROLL-7 probe
drew `....#.#.` — `$0A` — across every cell: the handler's page number,
on screen. There is no other byte the VIC will read there, so the fix
had to be on the CPU's side: `raster.s` now puts the IRQ target in
**page zero** — an `rti` at `$FD` from `.init.250` in every program, a
`jmp` to the handler there once `raster.enable()` runs — and the
compiler's C64 zero-page budget ends at `$FD` to make room
(`packages/compiler/src/mos/index.ts`, `C64_ZP_BUDGET`). `$FFFF` is
therefore 0 in every C64 program: **idle graphics are transparent by
default, with nothing to set** — the gap, and an opened border, are the
background color. Three bytes of zero page and three cycles a frame per
interrupt is what that costs. Nothing may write `$FFFF`: a list entry
there sends the next interrupt into the wrong page.

**A pattern instead of transparency: ECM.** With ECM (`$D011` bit 6) set
"the address generator always holds the address lines 9 and 10 low", so
the idle fetch is `$39FF`: `$F9FF` here, the 64th byte of sprite shape
block 231 — a pad byte no sprite uses (a shape is 63 bytes) and plain
RAM. That is `idle.PATTERN`. `border.bottom()` sets ECM in the same
write that opens the border and `border.top()` clears it before the
first row, so **what an opened border draws is `idle.setPattern(bits)`'s
byte**: `Pattern.BLACK` for sprites floating on black while the playfield
stays blue, `Pattern.TRANSPARENT` (the default) for the background color
to the edges, `Pattern.DITHER` for a 50% mix. And since the list writes
any address, `raster.at(line, idle.PATTERN, bits)` changes the byte at a
line: a byte every two or three lines paints a dithered gradient down
the opened border for one entry each, `$D021` splits beside it make it
a colored one. ECM means "`$39FF`" in *text* modes only — ECM with BMM
or MCM is an invalid mode and draws black (also a way to a black band).
`$F9FF` is whatever RAM held at power-on; `setPattern` (or the first
`border.bottom()`) writes it before ECM is first set. A gap opened with
YSCROLL can carry a pattern the same way — ECM on at the line above the
gap, off at 47 + YSCROLL — if the program adds those two entries itself.

### 3. Sprite reuse — multiplexing

**Mechanism (§3.8.1).** In cycles 55-56 of every line the VIC compares
each enabled sprite's Y with the raster's low byte and, if they match
"and the DMA for the sprite is still off, the DMA is switched on"; in
cycle 58 the display is turned on; the sprite's rows are fetched one per
line (sprites 0-2 at the end of the line, 3-7 at the start of the next)
and drawn on the following line — "the sprite Y coordinates stored in
the registers must be 1 less than the desired Y position of the first
sprite line" — and after the 21st fetch, at cycle 16, "the VIC checks if
MCBASE is equal to 63 and turns off the DMA and the display". Then:
"Sprites can be 'reused' vertically: If you change the Y coordinate of a
sprite to a later raster line during or after its display has completed
... the sprite is displayed again at that Y coordinate (you may then of
course freely set a new X coordinate and sprite data pointer). It is
therefore possible to display more than 8 sprites on the screen. This is
not possible in the horizontal direction."

So a hardware sprite whose last use began at Y = a is free from line
a + 21; a new Y written before cycle 55 of line b draws it again from
b + 1; its pointer, X and color may change once the old rows are drawn
and before the new first row. Eight per raster line is the whole limit.

**What `multiplex.8bs` does with that**, every frame in `update()`:
sorts the virtual sprites by Y (insertion sort over a persistent order:
nearly free when little crossed — Cadaver's "Ocean" idea on codebase64,
where the multiplexer literature lives); writes the eight topmost into
the list's *frame table*; and for each further sprite k, in Y order,
takes hardware sprite k & 7 — in sorted order that is the one that
freed up earliest — and appends entries at the earliest line it may:
`max(previous Y + 21, the line the queued entries land by)`, Y first
(the one write that must be in time), then pointer, X, `$D010` (a
whole byte, so a running value is kept in line order) and color, each
only if it differs from what the hardware sprite holds. If they would
not all land before the new Y — the hardware sprite is still busy, or
too much is queued — the sprite is dropped for this frame and counted.
One to five entries per reuse: twelve reuses of sprites that change
everything, twenty-seven that only move, within the 63.

**The frame table is the part that is not in the literature.** A
multiplexer's list moves the eight down the frame, and something has to
put them back for the next frame's top. The first draft wrote the
registers from `update()` and lost the top eight on every frame the
program's loop did not reach `update()` — the list kept moving them,
nothing put them back — and even at full rate the eight and the list
below them were a frame apart, because a list commits for the *next*
frame. So each list page carries the eight sprites' registers
(`Frame.*`: 16 position bytes, `$D010`, `$D015`, eight pointers, eight
colors, a flag) and the handler writes them at line 0 of the next
frame, from the page the pass's end at 255 swapped in — one pass's end
in two interrupts, so the eight and the list are never a frame apart.
They were written at 255 itself at first, and a sprite reused in the
opened lower border (Y above 234, drawing past 255) jumped to its next
frame's X for its last rows; line 0 is vertical blanking on both
standards, and the ~420 cycles the table takes put the raster at line
6 or 7 — an entry on a line under that is applied at once, late and
invisible. The multiplexer writes no register at all; a frame without
`update()` repeats the last picture.

**Why the pass ends at line 255, always.** The handler used to arm the
first entry's line straight after the last entry, wherever that was; a
list whose last entry is at 140 then swapped at 140, and a program that
committed at 150 waited a frame. Now the last entry arms 255, 255
does the swap and arms line 0, and line 0 does the frame table and the
first line. A commit before 255 is live next frame, deterministically;
only a program still building past 255 ever waits in `clear()`.

**Why entries catch up instead of skipping a frame.** The wobble probe's
comment records the old failure: a cascade of per-line entries that
fell a line behind armed a compare the raster had passed and missed the
rest of the frame. The handler now tests each next entry's line against
`$D012` (with `$D011` bit 7 clear — PAL's lines 256-311 wrap the low
byte) and applies it at once if reached or passed; after arming it
re-reads `$D012` and, if the raster got there meanwhile, checks `$D019`
for whether the compare fired and applies the entry itself if not.
Bauer says the compare is tested "in cycle 0 of every line"; whether a
write in the line itself fires is not stated, so the handler does not
depend on it either way.

### What the handler's timing allows, and what it does not

An entry's first write lands 58-64 cycles into its line (7 for the
interrupt sequence, up to 6 finishing the instruction under way, 3 for
the `jmp` at `$FD`, 48 of handler); later entries on the line 25 cycles
apart; a bad line stalls the CPU ~43 cycles. Everything above is built
on that number: writes take effect from the next line's left edge, so
"the border changes at L" is an entry at L−1, the border opens with an
entry at 249, and a multiplexed sprite's entries go three lines or more
above its Y. What it rules out, and this package does not attempt: side
border opening (a CSEL write in cycle 56 of every line), FLI (a `$D011`
write in cycles 14-ish of every line), linecrunch, and any effect that
wants a register written at a *horizontal* position — those need a
cycle-exact handler of the program's own, which 8bitscript has no
function values to name. FLD at a few lines' pitch (§3.14.2: "does not
even have to be updated each rasterline") is within reach as `$D011`
entries stepping YSCROLL, and is the next thing to try from here.

### What the multiplexer costs in cycles, and where the frame goes

Measured with CIA 2's timer A around each stage of `examples/swarm`'s
loop, 2026-09-19, sixteen sprites with eight reused, all through the
compiler's generic 6502 code: the sort ~1,800 cycles, the eight sprites'
frame table ~3,800 (after `raster.setFrameSprite`/`setFrameHeader`
replaced 35 `setFrameByte` calls — a call is ~190 cycles, mostly its
arguments), the eight reuses' entry groups ~10,300 (after
`raster.spriteEntries` replaced four or five `at` calls a sprite — ~1,300
a sprite for forty-odd statements of bookkeeping), ~16,000 in all, out
of 17,095 in an NTSC frame. So a program that multiplexes sixteen
sprites and moves them runs at two hardware frames an iteration on the
C64 today: right, and half rate. The handler itself is not the cost
(~100 cycles an interrupt plus 25 an entry, ~3,000 a frame for this
list); the update is. Three things fell out of measuring it:

- **The frame table is written at line 0, not 255.** A reused sprite
  whose Y is above 234 draws its last rows past 255 (in the opened lower
  border), and the table written at 255 gave it the next frame's X for
  those rows (`312 & 255 = 56`: seen in the sprites probe). The handler
  now arms line 0 after the swap and writes the table there, in
  vertical blanking; entries on lines under 7 are applied late and
  unseen.
- **A register the list leaves is the register the frame keeps.** When
  a program stops inserting `border.top()` (the scene closed the border)
  the last `$D011` write — RSEL off, ECM on, from line 250 — held for
  every frame: the top text row lost its first four lines and every
  letter cell went solid. `sprites`' C64 twin keeps the line-50 restore in
  every plan once the border has ever been opened.
- **The reuse line can never be above what the list already holds.**
  `multiplex.update()` takes `max(line, raster.lastEntryLine())`, so a
  program that appends entries before it (the border's `top()` at 50)
  does not lose every sprite whose reuse line is 49 (a sprite at Y 28
  in the top border).

The cure was the update in native assembly — the rule
docs/project/frame.md states, that a machine package ships the assembly
that applies a plan — with the tables at fixed addresses so the code can
reach them. Done the same day: `native/6502/multiplex.s`,
`__8bs_c64_multiplex_update`, the same three steps in the same order
with the same drops (its header says so line by line, and the x64sc
tests that read the sprites probe and the multiplex probe by pixel
passed unchanged with the 8BitScript body gone). Its tables are page
$06 — the KERNAL's dead screen, as the frame tables are $04 and $05:
the twenty-four virtual sprites at $0600, the working copy of the eight
at $0690, count/dropped/shown at $06B8, and the raster list's build state
at $06C0, which `raster.shareBuild()`/`takeBuild()` hand over around the
`jsr` so raster.8bs's own variables stay where the compiler put them.
The entry stores' page byte is patched on entry, twenty operands, as the
handler patches its own at a swap.

Measured with CIA 2's timer A (`packages/sprites/test/c64-timing.8bs`,
sixteen sprites in a diagonal, eight reused with two or three entries
each, none dropped): the `jsr` is **~9,500 cycles** where the 8BitScript
update was ~16,000 — and about 40% of that window is not the routine
but what the VIC and the handler take out of it (bad lines ~950, sprite
DMA ~1,100, ten to twelve interrupts and the line-0 frame table ~2,300):
eight sprites with no reuse read 2,143, and each further reused sprite
~500. The swarm example's whole loop is then ~15,300 of the NTSC
frame's 17,095 (recorded per frame, printed once): the scene ~400, the
flock's motion ~3,500 with the steal in it, the update ~11,000 — one
hardware frame an iteration, with a frame lost on about half the
frames that also recolour all sixteen (FRAME 776 at `--frames 1000`,
where 789 is every frame). What it took beyond the routine, each
measured: the frame counter as five digits kept in place and one
`text.putChar` a frame (a five-digit `printNumber` every frame was
~2,800 under the compiler's code; ~1,265 since `text.s`, still more
than a `putChar`); and `multiplex.setColor` given one call site so the linker
inlines it (rule 9: a void callee with one site) — the twin's `begin()`
goes through `multiplex.set`, and a sixteen-sprite recolour is sixteen
stores. What is left is the compiled motion and the VIC's own steal;
the next lever, if one is wanted, is the flock's arithmetic in tighter
code, not the layer.

### Other uses these open up

- **Sprites leaving the playfield whole**, top and bottom — a ship
  flying off, a boss entering from below, a status sprite in the lower
  border (the classic use: a scoreboard of sprites under the playfield,
  eight of them, none costing a playfield sprite if the multiplexer
  places them there).
- **A letterbox**: open the border, `Pattern.BLACK`, and the picture is
  a 200-line film strip with black above and below while `$D021` is
  whatever the game wants.
- **Dithered gradients in the opened border**: `raster.at(line,
  idle.PATTERN, ...)` through `Pattern.SPARSE`, `DITHER`, `DENSE`,
  `BLACK` every few lines, over a `$D021` split — a sky fading to black
  behind the sprites, for four or five entries.
- **A 25-row vertical scroller with no garbage**: the gap YSCROLL opens
  is now invisible in every program, so the "24-row trick" is a choice,
  not a necessity.
- **Row 24's hidden lines**: with YSCROLL 4-7 and the border open, the
  last row is drawn whole below the old window — 204 pixel lines of text
  instead of 200.
- **A blank line between text rows** by holding YSCROLL so the next bad
  line is missed for a few lines — FLD, one entry per gap line.

### Rules these files hold to

- `$FFFF` is the IRQ vector's page *and* the idle byte: nothing writes
  it, the IRQ target stays in page zero, and the compiler's C64 budget
  stops at `$FD`. Any change to where the IRQ goes is a change to what
  every idle line draws — check `test/idle-probe.8bs`'s capture.
- `$F9FF` is block 231's pad byte and nothing else's: a shape copy
  writes 63 bytes, never 64.
- Never clear DEN in a `$D011` entry. Set ECM only from the last line of
  row 24 to the last line before the first bad line, and only in text
  mode.
- Entries land at the end of their line: an effect wanted from line L
  is an entry at L−1; RSEL's clear must be at 248-250 (249 here, for
  slack); the multiplexer's Y writes go three lines or more above the Y.
- A list is built whole and committed; `setValue` is for a list whose
  lines stand. The pass ends at 255: commit before it. The frame table
  is written at line 0 of the next frame.
- An entry a program stops adding leaves its register as the last
  entry set it: whatever `bottom()` sets, `top()` must keep resetting.
- Append in line order where you can: `insert()` slides every entry
  above its line (~50 cycles each). The border's `top()` goes in before
  the multiplexer's run, `bottom()` after.
- Every claim above about a line or a cycle was seen in a capture or
  read in Bauer; the next such claim gets the same treatment before it
  is written down.

## Rules for this target

### The picture is in bank 3, and the reasons are structural

- The VIC's data — screen, charset, sprite shapes, sprite pointers, the
  bitmap and its color matrix — lives in `$D000`–`$FFFF` and nowhere
  else. Never put VIC data inside `$0801`–`$CFFF`: the linker owns it and
  nothing checks for an overlap. A custom character set is written into
  the RAM copy at `$D000`–`$D7FF` through the windows in `index.8bs`; the
  bitmap takes `$E000`–`$FF3F` and evicts the shape blocks and the text
  screen — a mode change `bitmap.enter()`/`leave()` own, with `videoMode`
  telling the sprite layer and text where things are. The color matrix
  is under the I/O area because every other 1K slot in the bank is the
  program's or the bitmap's; the price is a window per matrix write, and
  the alternative — a link script ending the program at `$BFFF` to free
  `$C000`–`$CFFF` for plain-RAM VIC data — costs every program 4K and was
  not taken. Revisit if a canvas capability needs matrix writes every
  frame.
- `$01` and `$DD00` are read, masked, written. Never a literal: the
  cassette bits and the serial bus are in the same bytes. `$01`'s low
  bits are `%101` from `setupVideo()` on, `%010` for the length of a ROM
  copy, `%100` inside a window under I/O (`bankIoOut()`); HIRAM low hides
  the character ROM as well as the KERNAL, so a copy sets `%010` first.
- Any code that banks I/O out runs with interrupts off and touches no
  register until it is back — `bankIoOut()`/`bankIoIn()` and nothing
  else, because they are what knows whether to `cli` (the raster list's
  `interruptsOn`). Verified above what happens otherwise.
- An `@address` global's name is a C macro for the whole program: give it
  a name no parameter will ever have.
- Color RAM never moves: `$D800` + cell, written through I/O.
- `Video` in `geometry.8bs` is the single source for every address; a
  surface reads `Video.X`, never a number. The arrays over the bank are
  declared *there* because `@address` takes only a literal or a
  same-file const.

### The program owns the machine

- From the first `waitFrame()` or the first draw, interrupts are off, and
  from the first draw the KERNAL ROM is out. The only interrupt that runs
  after that is the raster list's, once `raster.enable()` has silenced
  both CIAs and moved the IRQ vector — a program's own code never runs in
  an interrupt. There is no KERNAL keyboard, no jiffy clock, and `main()`
  does not return. Anything that needs the KERNAL (loading a file through
  the IEC bus, printing through CHROUT) is not written for this state and
  must not be written casually — a storage capability would map the ROM
  back (`%011`), `cli` around a KERNAL call with CIA1 timer A's interrupt
  masked and the raster list disabled, and that is a design to make on
  purpose.
- The raster list is a *list*: entries in ascending line order, built
  in the page the handler is not reading and committed, applied by the
  shipped handler from the next frame. A write lands at the end of its
  line — in the right border — so an effect wanted from line L is an
  entry at L−1, and nothing lands "a few cycles into" a picture line
  unless a bad line or a queue of entries on the same line pushes it
  there. The window rule above is what keeps the handler alive: a
  window under I/O with the interrupt live would acknowledge into RAM
  and loop forever.
- CIA1 is read in one order, once a frame: `waitFrame()`, then
  `keyboard.scan()` (leaves port A at `$FF`), then `joystick.scan()`.
  Everything after answers from the snapshots. A read of the ports
  anywhere else sees whatever column was last selected.
- Port 2 is the player's port. Port 1 shares the matrix rows: a stick
  there presses keys and keys press the stick. Port 2 shares the columns,
  which a scan drives only for the length of `keyboard.scan()`. This is
  the wiring, not a convention to argue with.
- Collision registers are read once, right after `waitFrame()`, and
  kept; they clear on read. Four hardware sprites in one object touching
  anything sets four bits — a program that wants "which pair" tests
  rectangles in software.

### Sprites are eight, and shapes are copied

- Shape data is a `const` array in the program; a `const` array is data
  wherever the linker put it, so a program copies each shape into a block
  (`spriteShapes[sprites.blockOffset(b) + i]`) once. Animation is
  `setShape(n, block)`: one byte a frame.
- Eight per line is the limit; eight per *frame* is not — `@8bitscript/c64/multiplex`
  reuses them down the frame through the raster list (the section
  above), a reuse costing one to five of the list's 63 entries and a
  hardware sprite 24 lines between uses. Budget per raster line, as the
  NES file says for its own reason: nine objects on one line is the one
  thing no list can fix. A program that multiplexes by hand uses the
  same entries — `raster.at(line, raster.spriteY(n), y)` and the sprite's
  X, pointer and color beside it, at a line three or more above `y` and
  at or after the previous use's `y + 21` — and the frame table
  (`raster.setFrameByte`) to put the eight back for the next frame's
  top; writing a moved sprite's registers from program code instead is
  the mistake the multiplexer's first draft made.
- In bitmap mode the shape blocks are 96–111 under the I/O area, written
  through `sprites.setShapeByte()`, and the pointers move with the matrix;
  `setShape()` follows `videoMode`.
- `place()` takes the VIC's coordinates: X 24–343 and Y 50–249 are on
  screen with the full window. A portable sprite capability will
  translate from screen pixels (0, 0) by adding `LEFT`/`TOP`; this layer
  does not.

### Sound is three voices and two tables

- `sid.8bs` is the registers with their units, and a note table per
  clock — PAL, the default, and NTSC. The build is region-independent (the
  frame driver's raster probe is at runtime and nothing reaches the
  program from it), so the choice is the program's, at run time:
  `sid.detectRegion()` (the same probe, `detectRegion()` in `index.8bs`,
  two frames once) or `sid.setRegion()` from a program that knows. A
  program that calls neither plays the PAL table, 3.8% sharp on NTSC —
  two thirds of a semitone, in tune with itself. The runtime publishing
  its own answer through a cross-machine builtin is still the design to
  reach for when a second machine needs it; the package-level probe is
  what exists.
- The registers are write-only: keep shadows (the package does), never
  read-modify-write a SID register.
- `$D41B`/`$D41C` are readable and are the hardware-entropy source;
  nothing deterministic depends on them.

### Models are not profiles

- One `.prg` runs on every model VICE lists and every real board; the
  chip differences (6581/8580 filter and volume click, 6567R56A's 262-line
  frame, the Drean's 65-cycle lines) are runtime facts a program may
  notice and the build cannot select. The catalog's options are the REU,
  the SID, and the control ports, not the model: VICE's `-model` is how
  `--pal` is expressed here, so a `model` option waits until region moves
  into the catalog. The
  frame driver's NTSC figure is the 6567R8's; on an R56A the frame period
  is 1.9% off (262 × 64 against 263 × 65) and on a Drean under 1%
  (`docs/setup/vice.md`), which a future probe could fix by counting
  cycles per line.
- A C64GS has no keyboard: a program for it is joystick-only by choice,
  not by profile. The Ultimax cannot run a `.prg` at all.

### Hazards

- There is no C64 "killer poke": no primary source (VICE, c64-wiki, the
  Programmer's Reference Guide) documents a memory write that damages a
  C64. The one hardware-damage story — driving a 1541's head past its
  stop — is a drive-side program, not a write on the C64's bus. So there
  is no `c64` row in `packages/compiler/src/linker/hazards.mjs`, and the
  bar for adding one is the root file's: a documented destroying write,
  nothing less.
- Folklore says making CIA1 port lines outputs (`$DC02`/`$DC03`) with a
  joystick shorting them can stress the CIA. *Unverified*, not in a
  primary source; the package writes the directions the KERNAL uses
  (A out, B in) and no other, which is the wiring's intent.

### Verify before you write it down

The COLBK/COLPF2 rule from the root file applies. `8bs run c64
--screenshot`, or `x64sc -model <m> -limitcycles N -exitscreenshot f.png
-autostartprgmode 1 -autostart dist/main-c64-ntsc.prg`, is cheap; the
first screenshot in this work proved the bank-3 layout and the second
proved that an unguarded ROM copy hangs the machine. Move a row from
"from the sources" to "verified here" when you check it.

## Seeing the screen without a human at x64sc

`8bs run c64 --screenshot <file.png>` builds and captures through VICE's
`-limitcycles`/`-exitscreenshot` (see
[`docs/setup/verify.md`](../../docs/setup/verify.md#screenshots));
`--frames` is converted at the region's CPU clock. `--pal` runs `-model
c64`. Captures disable VICE's random autostart delay
(`+autostart-delay-random`, `packages/cli/src/screenshot.mjs`), so a
`-limitcycles` capture lands on the same program state every run — with
the delay on, the same test saw the steady state one run and the boot
screen the next. `test/layers.test.mjs` and `test/reu.test.mjs` do this for the
probe programs under `test/`, reading a pixel or two of each screenshot
(x64sc's NTSC capture is 384 × 247; **raster line L is PNG row L − 28**
and VIC sprite X is PNG column X + 8, so the picture's pixel (x, y) is
at (32 + x, 23 + y) — measured 2026-09-19 against the raster probe's
band edges, and used by the idle, border and multiplex tests; an
earlier note here said L − 20, and the bands it was written for were
wide enough not to notice. Rows 223-234 are the lower border, lines
251-262; rows 235-246 the next frame's lines 0-11). A program's own
`FRAME` counter reads about 80 at the default `-limitcycles` — the
autostart takes ~210 frames of the 293 — so a probe that needs N
iterations gets `--frames 210 + N × (frames per iteration)`. Keyboard and joystick cannot be driven headlessly — VICE's
`-keybuf` feeds the KERNAL's buffer, which this program never reads — so
the input layers are verified against VICE's own keymap table and the
register documentation, not by pressing keys under `-limitcycles`.

## Where things live

```
packages/c64/src/geometry.8bs        Video: bank 3, $E000 screen, $D000 charset copy, $E3F8 pointers, $E400 shapes, $D018 = $84; Bitmap: $E000 bitmap, $DC00 matrix, $DFF8 pointers, $D800 blocks 96-111, $D018 = $78; the arrays over them
packages/c64/src/index.8bs           target package: every register by name, videoMode/interruptsOn, setupVideo() (sei, ROM copy, bank, pointer, KERNAL out), copyCharacterRom(), the windows under I/O, detectRegion(), the REU registers
packages/c64/native/6502/raster.s    .init.250 (NMI → rti in text, IRQ → rti at $FD: $FFFF = 0, every program), __8bs_c64_raster_install (jmp at $FD), __8bs_c64_raster_swap, __8bs_c64_raster_restore (the frame table, at line 0), the raster-list handler: two pages, late catch-up, the pass's end at 255 and line 0
packages/c64/src/screen.8bs          @8bitscript/c64/screen: blank() over Video.CELL_COUNT cells, sixteen color names
packages/c64/src/text.8bs            @8bitscript/c64/text: ASCII → screen code, putChar/putColor direct writes, print/printNumber/fill a jsr into text.s with the parameters at page $07, COLUMNS/CELL_COUNT from Video; $D018 only in text mode
packages/c64/src/sprites.8bs         @8bitscript/c64/sprites: place/setShape (by videoMode)/setShapeByte/setColor/show/hide/expand/priority/multicolor/collisions
packages/c64/src/raster.8bs          @8bitscript/c64/raster: the write list, two pages at $0200/$0300 + frame tables at $0400/$0500 — clear/at/insert/spriteEntries/commit/setValue/addressOf/setFrameByte/setFrameSprite/setFrameHeader/count/lastEntryLine/enable/disable, Register.*, Frame.*, spriteX/Y/Color/Pointer(n)
packages/c64/src/idle.8bs            @8bitscript/c64/idle: the ghost byte ($FFFF, read-only, 0) and the ECM pattern byte ($F9FF): setPattern/pattern/ghost, Pattern.*, firstBadLine/lastRowLine
packages/c64/src/border.8bs          @8bitscript/c64/border: top()/bottom() — the $D011 entries that open the vertical border (RSEL at 249, ECM at 247 + YSCROLL, both back at 47 + YSCROLL), setShort
packages/c64/src/multiplex.8bs       @8bitscript/c64/multiplex: 24 virtual sprites from eight — setCount/set/place/setShape/setColor/hide/update/dropped; the tables at page $06, update() a jsr into multiplex.s (~9,500 cycles a frame for sixteen with the VIC's steal inside: see "What the multiplexer costs")
packages/c64/native/6502/multiplex.s   __8bs_c64_multiplex_update: the sort, the build page's frame table, the reuse entries — page $06's map in its header; raster.shareBuild/takeBuild hand the list's build state over at $06C0
packages/c64/native/6502/text.s      __8bs_c64_text_print / _number / _fill: text.print, printNumber and fill from page $07 ($0700 cell, $0702 color, $0703 reverse, $0704 the string's address / value / count, $0706 width / character), the cell added into each routine's own `sta $E000,y` / `sta $D800,y` operands on entry
packages/sprites/src/index.c64.8bs    @8bitscript/sprites on the C64: the portable objects surface as a thin twin over multiplex + border (begin/place/setShape/setColor/hide/extend/update/plan, left/right/top/bottom that follow extend)
packages/c64/src/bitmap.8bs          @8bitscript/c64/bitmap: enter/leave, clear, plot/unplot/point, plotColor/pointColor, setCellColors/fillColors (under I/O), setCellColor3/fillColor3
packages/c64/src/charset.8bs         @8bitscript/c64/charset: define/setRow/readRow/copy/fill/restore, multicolor text, upper/lower case
packages/c64/src/scroll.8bs          @8bitscript/c64/scroll: setX/setY, setNarrow/setShort, shiftLeft/Right/Up/Down over screen and color RAM
packages/c64/src/keyboard.8bs        @8bitscript/c64/keyboard: scan() snapshot of the eight columns, pressed(key), column(n)
packages/c64/src/keys.8bs            @8bitscript/c64/keys: Key.X = column * 8 + row, the one C64 matrix
packages/c64/src/joystick.8bs        @8bitscript/c64/joystick: scan() both ports, up/down/left/right/fire(port), bits(port)
packages/c64/src/sid.8bs             @8bitscript/c64/sid: voices, envelopes, filter, Note.C0-B6 over the PAL and NTSC tables, setRegion/detectRegion
packages/c64/src/reu.8bs             @8bitscript/c64/reu: reu.detect() (the first probe), stash/fetch/swap/verify/fillReu
packages/c64/src/mouse.8bs           @8bitscript/c64/mouse: a 1351 in a port — present(), poll(), x/y, buttons (a probe and its driver in one)
packages/c64/test/reu-probe.8bs      the probe run for real: prints the KiB, border color encodes it; test/reu.test.mjs reads it under x64sc
packages/c64/test/layers.test.mjs    raster-probe, idle-probe, border-probe, multiplex-probe, wobble-probe, bitmap-probe, region-probe, reu-transfer-probe, hello-world: linked clean, then run under x64sc and read by pixel
packages/c64/package.json            "8bitscript".exports names the twenty-one subpaths (screen, text, video, sprites, keyboard, keys, joystick, sid, reu, mouse, raster, bitmap, charset, scroll, input, pointer, random, rasterline, idle, border, multiplex); "8bitscript".native ships raster.s and multiplex.s
packages/compiler/test/c64-package.test.mjs   layout consistency, registers, borders through the bank, each subpath's emitted C, raster.s's shape, keys vs VICE, both note tables
packages/compiler/test/borders-parity.test.mjs   the c64 row expects $D018 = 132
packages/c64/package.json            "8bitscript".hardware: ram (REU), sid, port1, port2 — values, x64sc flags, facts, presets
packages/compiler/src/mos/image.ts  C64 still a BASIC SYS .prg (`entryIsVectored` false) but `endsByHalting` so main() JMPs to itself rather than RTSing into unmapped BASIC
packages/compiler/src/mos/index.ts  C64_ZP_BUDGET: $02-$FC — $FD-$FF are raster.s's IRQ trampoline, because $FFFF is the VIC's idle byte
packages/compiler/src/mos/index.ts  FRAME_SYNC.c64 (level driver, presync sei unless interruptsOn, PAL probe)
packages/compiler/src/resolver/index.mjs   nativeSourcesBeside(): a package's native files ride with its own files, however imported
packages/cli/src/run.mjs             x64sc, -model ntsc/c64, the catalog's flags appended
packages/cli/src/hardware.mjs        how a build's hardware is resolved from the catalog
docs/setup/vice.md                   the x64sc -model table
```
