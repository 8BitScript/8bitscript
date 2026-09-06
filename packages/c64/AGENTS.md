# Writing Commodore 64 support for 8BitScript

This file is for anyone — human or agent — touching `packages/c64` (its
`.8bs` sources and `native/6502/raster.s`),
this package's hardware catalog (`package.json`, `"8bitscript".hardware`:
the REU, the SID, the two control ports), `packages/backend-6502`'s
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
  area at `$D000`. Colour RAM is the fixed `$D800`. `$D018` is `$84`
  (`Video.MEMORY_POINTER_UPPERCASE`; `$86` for the lower-case set).
  `setupVideo()` in `src/index.8bs` puts it there once — `sei`, copy the
  ROM in place (`copyCharacterRom()`: `$01` low bits `%010` for the copy,
  `%101` after), select the bank through CIA2 by masking, set `$D018` —
  and every surface calls it before its first write. Why bank 3: the SDK
  links the program into `$0801`–`$CFFF` and decides where every byte
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
  only if `interruptsOn`.
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
  alone, and the codes it writes land in the bitmap).
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
  - `@8bitscript/c64/raster` (`src/raster.8bs` + `native/6502/raster.s`):
    **a list of register writes at raster lines, not a handler of the
    program's own.** `raster.clear()`, `raster.at(line, address, value)`
    (ascending lines, up to 63 entries; `Register.BORDER`, `BACKGROUND`,
    `CONTROL_1/2`, `MEMORY_POINTER`, the sprite registers, `SID_VOLUME`;
    `raster.spriteX/Y/Color/Pointer(n)`), `enable()`, `disable()`,
    `count()`. The handler is assembly the package ships: it acknowledges
    `$D019`, applies every entry on the line from a table at `$0200`
    (state at `$0300`–`$0302`), sets `$D012` to the next entry's line,
    saves and restores A and X, touches no zero page. `enable()` clears
    both CIAs' masks (the KERNAL's timer A would otherwise reach the
    handler and never be acknowledged), acknowledges the VIC, `jsr`s the
    install routine that moves `$FFFE` to the handler, sets
    `interruptsOn`, and `cli`s. 8bitscript has no function values, so a
    program cannot name code to run at a line; what the list covers is
    colour splits, split scrolling, character-set and screen switches,
    sprite multiplexing by rewriting a sprite's registers at a line, and
    computed effects as a list rebuilt each frame.
  - `@8bitscript/c64/bitmap` (`src/bitmap.8bs`): `bitmap.enter(multicolor)`
    / `leave()`, `clear(bits)`, `plot`/`unplot`/`point(x, y)` (320×200),
    `plotColor`/`pointColor(x, y, c)` (160×200, four colours),
    `offset(x, y)`, `setCellColors(cell, fg, bg)` and `fillColors` (the
    colour matrix at `$DC00`, under I/O — one window per call),
    `setCellColor3`/`fillColor3` (colour RAM, multicolour's `%11`). The
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
    color)` — screen and colour RAM together, the opened column or row
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
  0/1/2/3; port 2 defaults to a joystick). A REU changes nothing about the
  build — it is eight registers at `$DF00` and a DMA engine — so none of
  these reaches the linker or the output name: each only fits x64sc the
  same thing, and sets a fact (`memory.banked`, `input.mouse`).
- `FRAME_SYNC.c64` (`packages/backend-6502`): a *level* driver — top half
  of the frame is `$D012 < 128` with `$D011` bit 7 clear (read in that
  order), the PAL probe is a raster line past 287 — and a `presync` of
  `sei`: **a program that calls `waitFrame()` anywhere runs with
  interrupts off from start-up**, and one that draws first has them off
  from `setupVideo()`. The KERNAL's 60 Hz IRQ (CIA1 timer A) scans the
  keyboard through the same ports `keyboard.scan()` uses and would race
  it; with it silenced the ports read what the program selected. The only
  interrupt that ever runs after that is the raster list's, if a program
  enables it. Consequences: no KERNAL keyboard buffer, no jiffy clock, no
  RUN/STOP+RESTORE (with the ROM out, RESTORE's NMI is a bare `rti`), and
  returning from `main()` into BASIC is off the map. NTSC is 263 × 65
  cycles at 1022727 Hz (a 6567R8), PAL 312 × 63 at 985248 Hz (6569).
- `8bs run c64` launches `x64sc -model ntsc` (or `-model c64` with
  `--pal`), `--screenshot` through `-limitcycles`/`-exitscreenshot`.
  Other models: `docs/setup/vice.md` has the `-model` table.
- No hazard entry: no primary source documents a C64 write that damages
  hardware (see Hazards).

There is no portable input, sprite, sound, canvas or banked-memory
capability yet (these are the C64's hardware layers, not
`@8bitscript/input`/`actors`/`sound`/`bitmap`), no interrupt handler a
program writes (a language feature — function values — this package's
raster list works around), no extended-colour text mode, no
`.d64`/`.crt` output, no KERNAL calls of any kind (loading a file), and no
model detection. The rules below are what to hold that work to.

## Facts verified here

Cite these freely; each was read in the source named or seen on screen
under x64sc (VICE 3.10, Homebrew), not recalled.

| Fact | Where |
| ---- | ----- |
| The SDK links a C64 program into `ram` at `$0801`, length `$C7FF` (to `$CFFF`), C stack at `$D000` growing down, BASIC ROM unmapped: `unmap-basic.o`'s `.init.010` is `ldx #$2f / stx $00 / ldx #$3e / stx $01` (`$01 = $3E`: LORAM 0, HIRAM 1, CHAREN 1 — BASIC out, KERNAL and I/O in) and `.fini.990` restores `$3F`. `$A000`–`$BFFF` is program RAM. | `$LLVM_MOS_HOME/mos-platform/c64/lib/link.ld`, `commodore/lib/commodore.ld`, `llvm-objdump -d unmap-basic.o` |
| A `.prg` starts with a BASIC `SYS` line (`basic-header.o`), so `RUN` after `LOAD` starts it; x64sc's `-autostartprgmode 1` injects it and types `RUN`. | `commodore.ld`, first screenshot below |
| Reading the character ROM with CHAREN clear and storing each byte back to the same address copies it into the RAM underneath; with the VIC in bank 3 and `$D018 = $84`, screen codes at `$E000` render from that copy (normal and reverse), and a 63-byte shape at `$E400` with pointer 144 draws as sprite 0 at (100, 100) in the sprite's colour. Both sets are in the copy: the same screen codes with `$D018 = $86` render as lower case. | scratch program, `8bs run c64 --screenshot`, once per pointer value (the layout in `geometry.8bs`) |
| The same copy with the KERNAL IRQ alive hangs the machine on the BASIC screen: the IRQ handler acknowledges CIA1 by reading `$DC0D`, which with I/O banked out is the ROM, so the interrupt is never cleared and fires again on `rti`, forever. `sei` first, always. | the same scratch program, built before `presync` existed — the first screenshot showed `RUN` and nothing else |
| `examples/proof-of-concept/borders` on the bank-3 layout: readout and colours correct, 1034 bytes of program (766 before: the ROM copy loop and the guard; 1056 since the KERNAL went out, see below). | `8bs run c64 --screenshot`, the build's memory line |
| A program using every subpath at once — three sprites (one at X 280 through the ninth bit, one double-size, one behind the background), text over them, `sid.play`, the two scans — builds to 1549 bytes and draws as written; sprite 0 at (24, 50) covers the first cell of the top row, i.e. (24, 50) is the screen's top-left pixel. | scratch program, screenshot |
| The `Key` table matches VICE's positional C64 keymap at every host key whose C64 key is unambiguous (letters, digits, and ~30 others): the vkm's first number is the `$DC00` bit, its second the `$DC01` bit (`Return 0 1`, `space 7 4`, `Escape 7 7` = RUN/STOP, `Control_L 7 5` = the C= key, `Tab 7 2` = CTRL). | `/opt/homebrew/share/vice/C64/gtk3_pos.vkm`, `packages/compiler/test/c64-package.test.mjs` |
| x64sc's models: `c64` (PAL, 6569, 6581, 6526, KERNAL rev 3), `c64c` (PAL, 8565, 8580, 6526A), `c64old` (PAL, 6569R1, rev 2), `ntsc` (6567R8, 6581), `newntsc` (8562, 8580, 6526A), `oldntsc` (6567R56A, 6581, KERNAL rev 1), `drean` (PAL-N, 6572), `jap` (NTSC, Japanese KERNAL/chargen), `c64gs` (PAL, 8580, GS KERNAL), `pet64` (4064 KERNAL), `ultimax` (no KERNAL); `-sidmodel` 0 6581 / 1 8580 / 2 8580 + digiboost; `-reusize` 128–16384 KiB; `-VICIImodel` 6569, 6569r1, 8565, 6567, 8562, 6567r56a, 6572. | `x64sc -help`, VICE's `c64/c64model.c` |
| The SID frequency formula `f = Fn × clock / 2^24` gives `Fn = 7493` for A4 on PAL, 440.02 Hz back; the table's last entry, B6, is 33640. B7 would overflow 16 bits on PAL (the ceiling is about 3848 Hz); C7–A#7 would fit, and the table stops at the last complete octave by choice. | the 6581 datasheet formula, `c64-package.test.mjs` recomputes the table |
| `-ntsc`/`-pal` alone only change VICE's sync factor and leave the model's geometry; `-model` switches ROMs, VIC-II and timing together, which is why `8bs run` uses `-model`. An earlier at-line-0 frame check fired twice a frame because `$D012` wraps at 256 on a 263/312-line frame. | `packages/cli/src/run.mjs`, `FRAME_SYNC.c64`'s comment (measured under VICE) |
| The catalog's stock fact sheet: grid 40×25 of 8×8, 16 colours, 2 per cell, 256 RAM glyphs, 2×2 blocks, bitmap, one layer with fine scroll, 8 sprites and 8 per line, 24×21, 3 colours (multicolour); 3 SID voices with ADSR, filter, samples through the volume register, a volume per voice, oscillator 3 as a random source; keyboard, two ports, no pads; disk; 51199 bytes (`$0801`–`$CFFF`), nothing banked until an `ram=reu*` value says so (`memory.banked`, `memory.bankedKib`), no mouse or paddles until a port value says so. | `src/geometry.8bs`; the `link.ld` and SID rows above; the VIC-II and SID sections of the research notes below; `package.json` (read) |
| `@8bitscript/c64/reu` — `reu.detect()`: presence by a `$DF02` round trip ($55 then $AA), size by stashing a marker to the first byte of each 64 KiB bank and watching bank 0 for the wrap or the bank for silence. VICE's `reu.c`: the bank register's unused bits are `0xF8` on the 128/256/512 KiB units (`reg_bank_unused`, forced high on read, masked on write) and 0 above; the address wraps at `wrap_around` (`0x20000` for 128 KiB, `0x80000` for 256/512, the size for larger); `$DF02`–`$DF05` read back what was written; the status register's bit 4 is the 256K-chip flag. Under x64sc the probe printed 0 / 128 / 256 / 512 / 1024 / 16384 KiB for no REU, `ram=reu128`, `reu256`, `reu512`, `reu1m`, `reu16m` — the 3-bit bank register, the 256 KiB unit that aliases inside a 512 KiB wrap, the 8-bit register with the wrap at the unit's size, and the register wrapping to zero — and the border took the colour `test/reu-probe.8bs` encodes for each. Cost: `test/reu-probe.8bs` is 810 bytes of program with `reu.detect()` and 628 with the same code reading its answer from RAM instead — 182 bytes for the probe, most of it the bank loop (the first draft, one helper setting nine registers per transfer and inlined four times, was 459; autoload took it down). A program that does not import `./reu` carries none of it. | `src/reu.8bs`; VICE `src/c64/cart/reu.c` (fetched 2026-09-05); four screenshots (ran); `test/reu.test.mjs` |
| `@8bitscript/c64/mouse` — a 1351's presence and movement. At rest, with `-controlport1device` at each of its four settings and the pot lines pointed at port 1 (`$DC00 = $40`), the SID's `$D419`/`$D41A` read: nothing **255**, joystick **255**, paddles **255**, 1351 **64** — which is `(0 & 0x7f) + 0x40`, the zero of VICE's `mouse_get_1351_x`. So a reading in 64..191 is what says a mouse, and `present()` is that test; a real paddle at mid-travel would read there too, so it means "consistent with a 1351", not proof. Movement is the signed 7-bit difference between two readings; buttons ride the joystick lines, left on FIRE and right on UP (`mouse_1351.c`). **Movement decoding is not exercised** — nothing in a headless run moves the host pointer VICE reads — and the real 1351 is often described as carrying its counter in bits 1–6 rather than all seven, so the movement *scale* on real hardware is *to verify*. Cost: `test/mouse-probe.8bs` is 1275 bytes of program with the driver and 1027 with a bare pot read — 248 bytes. | `src/mouse.8bs`; VICE `src/joyport/mouse_1351.c` (fetched 2026-09-05); four screenshots (ran); `test/reu.test.mjs` |
| With the KERNAL banked out (`$01` low bits `%101`) a program that writes the space code to `screenRam[100]` and prints what it reads back prints 32; the borders example (1056 bytes now, 1034 before) and the all-subpath program (1571 against 1549) build and draw as before — 22 bytes each: the vector stub, its `.init` section and the port switch. A program that never imports `./raster` links `__8bs_c64_rti` and nothing else from `raster.s` (`llvm-nm`); one that does links the install routine and the handler too. | scratch programs, `llvm-nm`, screenshots |
| **The raster list**: four `raster.at` entries (border red at 100, green at 150, yellow at 200, blue at 240) draw four bands down the border, top to bottom, while the frame loop keeps counting frames and printing (the frame driver's poll is unbothered by the interrupt). `.init.250` runs before `main()` (an `.init` section storing to `$D021` was seen to run first), per-routine sections let the linker drop the handler from a program that never names it, and `asm6502 { jsr __8bs_c64_raster_install }` reaches a native symbol by name. The emitted `__asm__` carries no clobbers, so the routine saves A and X itself. | `test/raster-probe.8bs` under `test/layers.test.mjs` (a pixel per band), the scratch programs |
| **Bitmap mode** at `$E000` with the colour matrix at `$DC00` (`$D018 = $78`): a rectangle plotted at (40–119, 40–99) and a diagonal line draw white on blue cells; cell 0 given red-on-black draws black (no bit set); a sprite whose 63 bytes were written to block 96 under the I/O area, pointer written at `$DFF8` under the I/O area, draws yellow over the bitmap; `leave()` back to text needs no ROM copy (the upper-case set was untouched). | `test/bitmap-probe.8bs` under `test/layers.test.mjs`, scratch screenshot |
| **Character set and scroll**: `charset.fill(1, 255)` and `charset.define(2, $FF, $81 × 6, $FF)` turn a row of A's into solid blocks and a row of B's into hollow boxes, including the A inside "CHARSET"; two `shiftRight` and one `shiftDown` move all three rows by two columns and one row; `setNarrow(true)` plus `setX(4)` show as the 38-column window. | scratch program, screenshot and pixel reads |
| **REU transfers** against `ram=reu512`: the screen filled with code 160, stashed into bank 1 at `$1000`, blanked, `verify` false, fetched back, `verify` true, `fillReu` of 40 spaces then `fetch` blanks row 0 and `swap` blanks row 1 while rows 2–24 keep the glyph — green border, "REU 00512 KIB"; a stock C64 tries nothing (red). Length 0 as 65536 is from the register description, not run. | `test/reu-transfer-probe.8bs` under `test/layers.test.mjs` |
| **The region probe**: `detectRegion()` returns NTSC under `-model ntsc` and PAL under `-model c64`, and `sid.frequencyOf(Note.A4)` is 7218 on the first and 7493 on the second: `round(440 × 2^24 / 1022727)` and `/ 985248`. | `test/region-probe.8bs` under `test/layers.test.mjs`, both models |
| An `@address` global is emitted as a C `#define`, so its name is a macro across the whole translation unit: a global named `index` or `end` broke every function with a parameter of that name (`sprites.place(index, …)`). Names of `@address` globals in a package must be ones no parameter anywhere will use (`rasterList`, `rasterEnd`, `rasterIndex`). | a build of the first raster.8bs; `packages/backend-6502` emits them as `#define` |

## From the sources, not verified here

Leads to confirm the first time code depends on them. Christian Bauer's
*The MOS 6567/6569 video controller (VIC-II) and its application in the
Commodore 64* (`zimmers.net/cbmpics/cbm/c64/vic-ii.txt`) is the primary
reference for the VIC-II; the 6581 datasheet and oxyron.de's register
maps for the SID; llvm-mos-sdk's `_vic2.h`, `_sid.h`, `_6526.h` for the
chips' register order; c64-wiki.com for the rest.

**Memory map.** `$0000`–`$00FF` zero page (`$02`–`$8F` BASIC's — the SDK's
imaginary registers start at `$02` — `$90`–`$FF` the KERNAL's); `$0100`
stack; `$0200`–`$03FF` KERNAL/BASIC workspace (`$0314`/`$0316`/`$0318`
the IRQ/BRK/NMI vectors, `$033C`–`$03FB` the cassette buffer, `$02A7`–
`$02FF` and `$0334`–`$033B` unused); `$0400`–`$07FF` the KERNAL's screen
(pointers `$07F8`); `$0800`–`$9FFF` BASIC RAM (38911 bytes free to BASIC
from `$0801`; the SDK's region is bigger because BASIC is out); `$A000`–
`$BFFF` BASIC ROM / RAM; `$C000`–`$CFFF` RAM; `$D000`–`$DFFF` I/O (VIC-II
`$D000`–`$D3FF` mirrored every 64 bytes, SID `$D400`–`$D7FF` every 32,
colour RAM `$D800`–`$DBFF`, CIA1 `$DC00`, CIA2 `$DD00`, I/O 1 `$DE00`,
I/O 2 `$DF00`) or the 4K character ROM; `$E000`–`$FFFF` KERNAL ROM / RAM.
Writes to a ROM address always go to the RAM underneath.

**The processor port** (`$01`, direction `$00`): bit 0 LORAM (BASIC ROM at
`$A000`), bit 1 HIRAM (KERNAL at `$E000`), bit 2 CHAREN (1 = I/O at
`$D000`, 0 = character ROM — only when at least one of the other two is
set; all three clear is 64K RAM), bits 3–5 cassette write, sense, motor.
With the cartridge lines GAME/EXROM there are 14 distinct configurations;
without a cartridge, the eight from bits 0–2. `$3E` (LORAM clear) is what
the SDK leaves: RAM at `$A000`, I/O at `$D000`, the KERNAL at `$E000`.

**VIC-II timing** (Bauer §3): 6569 (PAL) 312 lines × 63 cycles, 6567R8
(NTSC) 263 × 65, 6567R56A (old NTSC) 262 × 64; the CPU clock is the
colour crystal ÷ 18 (PAL 17734472 Hz → 985248) or ÷ 14 (NTSC 14318181 →
1022727). The Drean 6572 (PAL-N) is 312 × 65, at a clock near NTSC's
(the exact figure is not in a source read here). **Bad lines**:
on every raster line in `$30`–`$F7` whose low three bits equal YSCROLL
(one line in eight with the default scroll, 25 of them a frame) the VIC
takes the bus for 40–43 cycles to fetch the next row's 40 screen codes
and colours — the CPU gets about 20 of 63 cycles on those lines. Sprites:
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
pen), `$D01B` sprite-behind-background, `$D01C` sprite multicolour, `$D01D`
X-expand, `$D01E`/`$D01F` collisions (cleared by reading), `$D020` border,
`$D021`–`$D024` backgrounds 0–3, `$D025`/`$D026` shared sprite colours,
`$D027`–`$D02E` sprite colours. Text modes: standard (2 colours a cell:
colour RAM + background 0), multicolour (MCM: cells with colour-RAM bit 3
set are 4×8 double-width pixels in background 0/1/2 + the colour's low
three bits), extended colour (ECM: 64 characters, the code's top two bits
pick background 0–3). Bitmap modes: hi-res (8K, 2 colours a cell from
screen RAM's two nybbles) and multicolour (4 a cell). The sixteen colours
are fixed; the palette is not "8 base + 8 bright".

**Sprites** (Bauer §3.8): 24×21, 63 bytes in a 64-byte block, pointer =
address ÷ 64 at screen + `$3F8` + n, fetched from the current bank; X 0–
511, Y 0–255; the display window with RSEL/CSEL set is X 24–343, Y 50–249
(38-column/24-row modes shrink it to 31–334 / 55–246); a sprite is drawn
when its Y equals the raster line's low byte, so Y 250+ is under the
bottom border and X 344+ (to 487) in the right border/blanking. Priority
among sprites is fixed by number; `$D01B` decides each sprite's priority
against the background's *foreground* pixels (background 0 always shows
through transparent pixels). Multicolour sprites: 12×21, pixel pairs `01`
shared colour 0 (`$D025`), `10` own colour, `11` shared colour 1
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
  BASIC's figure from `$0801`; the SDK's program region is `$0801`–
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
  Each sprite chooses hi-res (one colour) or multicolour (its colour plus
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

## Rules for this target

### The picture is in bank 3, and the reasons are structural

- The VIC's data — screen, charset, sprite shapes, sprite pointers, the
  bitmap and its colour matrix — lives in `$D000`–`$FFFF` and nowhere
  else. Never put VIC data inside `$0801`–`$CFFF`: the linker owns it and
  nothing checks for an overlap. A custom character set is written into
  the RAM copy at `$D000`–`$D7FF` through the windows in `index.8bs`; the
  bitmap takes `$E000`–`$FF3F` and evicts the shape blocks and the text
  screen — a mode change `bitmap.enter()`/`leave()` own, with `videoMode`
  telling the sprite layer and text where things are. The colour matrix
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
- Colour RAM never moves: `$D800` + cell, written through I/O.
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
- The raster list is a *list*: entries in ascending line order, rebuilt
  between frames, applied by the shipped handler. A colour change inside
  the picture lands a few cycles into its line (more on a bad line); put
  it on the line before, or in the border. The window rule above is what
  keeps the handler alive: a window under I/O with the interrupt live
  would acknowledge into RAM and loop forever.
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
- Eight per line is the limit, and eight per frame is this package's
  promise. Multiplexing (more objects by rewriting sprite registers at a
  raster line) is raster-list entries — `raster.at(line,
  raster.spriteY(n), y)` and the sprite's X, pointer and colour beside it,
  four or five entries per reuse out of the list's 63 — and a sprite
  reused below line L must have finished drawing above it. Budget per
  raster line, as the NES file says for its own reason.
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
c64`. `test/layers.test.mjs` and `test/reu.test.mjs` do this for the
probe programs under `test/`, reading a pixel or two of each screenshot
(x64sc's NTSC capture is 384 × 247; the picture's pixel (x, y) is at
(32 + x, 31 + y), raster line L at about y = L − 20). Keyboard and joystick cannot be driven headlessly — VICE's
`-keybuf` feeds the KERNAL's buffer, which this program never reads — so
the input layers are verified against VICE's own keymap table and the
register documentation, not by pressing keys under `-limitcycles`.

## Where things live

```
packages/c64/src/geometry.8bs        Video: bank 3, $E000 screen, $D000 charset copy, $E3F8 pointers, $E400 shapes, $D018 = $84; Bitmap: $E000 bitmap, $DC00 matrix, $DFF8 pointers, $D800 blocks 96-111, $D018 = $78; the arrays over them
packages/c64/src/index.8bs           target package: every register by name, videoMode/interruptsOn, setupVideo() (sei, ROM copy, bank, pointer, KERNAL out), copyCharacterRom(), the windows under I/O, detectRegion(), the REU registers
packages/c64/native/6502/raster.s    .init.250 (NMI and IRQ vectors → rti, every program), __8bs_c64_raster_install, the raster-list handler
packages/c64/src/screen.8bs          @8bitscript/c64/screen: blank() over Video.CELL_COUNT cells, sixteen colour names
packages/c64/src/text.8bs            @8bitscript/c64/text: ASCII → screen code, direct writes, COLUMNS/CELL_COUNT from Video; $D018 only in text mode
packages/c64/src/sprites.8bs         @8bitscript/c64/sprites: place/setShape (by videoMode)/setShapeByte/setColor/show/hide/expand/priority/multicolour/collisions
packages/c64/src/raster.8bs          @8bitscript/c64/raster: the write list at $0200 — clear/at/count/enable/disable, Register.*, spriteX/Y/Color/Pointer(n)
packages/c64/src/bitmap.8bs          @8bitscript/c64/bitmap: enter/leave, clear, plot/unplot/point, plotColor/pointColor, setCellColors/fillColors (under I/O), setCellColor3/fillColor3
packages/c64/src/charset.8bs         @8bitscript/c64/charset: define/setRow/readRow/copy/fill/restore, multicolour text, upper/lower case
packages/c64/src/scroll.8bs          @8bitscript/c64/scroll: setX/setY, setNarrow/setShort, shiftLeft/Right/Up/Down over screen and colour RAM
packages/c64/src/keyboard.8bs        @8bitscript/c64/keyboard: scan() snapshot of the eight columns, pressed(key), column(n)
packages/c64/src/keys.8bs            @8bitscript/c64/keys: Key.X = column * 8 + row, the one C64 matrix
packages/c64/src/joystick.8bs        @8bitscript/c64/joystick: scan() both ports, up/down/left/right/fire(port), bits(port)
packages/c64/src/sid.8bs             @8bitscript/c64/sid: voices, envelopes, filter, Note.C0-B6 over the PAL and NTSC tables, setRegion/detectRegion
packages/c64/src/reu.8bs             @8bitscript/c64/reu: reu.detect() (the first probe), stash/fetch/swap/verify/fillReu
packages/c64/src/mouse.8bs           @8bitscript/c64/mouse: a 1351 in a port — present(), poll(), x/y, buttons (a probe and its driver in one)
packages/c64/test/reu-probe.8bs      the probe run for real: prints the KiB, border colour encodes it; test/reu.test.mjs reads it under x64sc
packages/c64/test/layers.test.mjs    raster-probe, bitmap-probe, region-probe, reu-transfer-probe: linked clean, then run under x64sc and read by pixel
packages/c64/package.json            "8bitscript".exports names the fourteen subpaths (screen, text, video, sprites, keyboard, keys, joystick, sid, reu, mouse, raster, bitmap, charset, scroll); "8bitscript".native ships raster.s
packages/compiler/test/c64-package.test.mjs   layout consistency, registers, borders through the bank, each subpath's emitted C, raster.s's shape, keys vs VICE, both note tables
packages/compiler/test/borders-parity.test.mjs   the c64 row expects $D018 = 132
packages/c64/package.json            "8bitscript".hardware: ram (REU), sid, port1, port2 — values, x64sc flags, facts, presets
packages/backend-6502/src/index.mjs  FRAME_SYNC.c64 (level driver, presync sei, PAL probe)
packages/compiler/src/resolver/index.mjs   nativeSourcesBeside(): a package's native files ride with its own files, however imported
packages/cli/src/run.mjs             x64sc, -model ntsc/c64, the catalog's flags appended
packages/cli/src/hardware.mjs        how a build's hardware is resolved from the catalog
docs/setup/vice.md                   the x64sc -model table
```
