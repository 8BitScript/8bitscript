---
title: Atari Lynx
nav_order: 21
---

# Writing Atari Lynx support for 8BitScript

This file is for anyone — human or agent — who will create `packages/lynx`,
add `lynx` to `packages/backend-6502` (a `LYNX_PROFILES` entry,
`FRAME_SYNC.lynx`, the driver and linker flags), teach
`packages/cli/src/run.mjs` an emulator for it, or write
`docs/setup/lynx.md`. None of those exist yet; the Lynx is a Phase 6
roadmap machine (`docs/roadmap.md`). Read the root
[`AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/AGENTS.md) first; the rules there apply to every
target and are not repeated. [`packages/nes/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/nes/AGENTS.md)
and [`packages/cx16/AGENTS.md`](https://github.com/8BitScript/8bitscript/blob/trunk/packages/cx16/AGENTS.md) are the contrasts: the
NES forces abstraction by having almost nothing; the X16 by having a lot
behind ports. The Lynx is a fourth case —

> **The Lynx has no text mode, no tiles, no character ROM and no hardware
> sprites in the C64 sense. It has a 64K flat RAM, a 160×102 4-bit
> framebuffer that the display DMA reads out of that RAM, and a blitter
> (Suzy) that draws scaled, flipped, tilted, collision-tracked "sprites"
> *into* that framebuffer from a linked list of control blocks. Every
> visible thing — a letter, a tile, a background — is a Suzy sprite or a
> byte the CPU wrote into the buffer. Model it as "CPU + RAM + blitter +
> a palette of 16 from 4096 + 4 audio channels + 8 timers", and model the
> frame rate as something the program *sets*, not something the machine
> has.**

The machine's variety is small: Lynx I vs Lynx II (stereo/panning, screen,
power) and the cartridge (size, page size, EEPROM). The toolchain's
variety is the real axis: LLVM-MOS today produces only a BLL-style `.o`
that an emulator loads straight into RAM, not a `.lnx` cartridge.

## What exists today

Do not describe more than this as working:

- Nothing in this repository. There is no `packages/lynx`, no
  `LYNX_PROFILES`, no `FRAME_SYNC.lynx`, no `8bs run lynx`, no
  `docs/setup/lynx.md`, and no emulator installed on this machine
  (`which mednafen mame handy` all fail). Nothing below was seen on
  screen.
- LLVM-MOS ships two drivers: `mos-lynx-clang` (headers only — its `lib/`
  has no `link.ld`, and linking an empty `main()` with it fails with
  `ld.lld: error: cannot find linker script link.ld`) and
  `mos-lynx-bll-clang`, which links and emits a 10-byte-header "BS93"
  file (`empty.lynx-bll`, 34 bytes for an empty program). Every
  "verified" row below was read in the SDK's headers and link script or
  in `llvm-objdump` of that linked ELF, not on hardware.

## Facts verified here

Cite these freely; each was read in the file named.

| Fact | Where |
| ---- | ----- |
| CPU flag is `-mcpu=mos65c02`; `-D__LYNX__`; `-mlto-zp=224` (224 zero-page bytes for LTO). `lynx-bll` adds nothing but its own `lib/` path. | `~/.local/opt/llvm-mos/bin/mos-lynx.cfg`, `mos-lynx-bll.cfg` |
| Only `lynx-bll` has a linker script. RAM region `$0200`–`__hiram_start`, where `__hiram_start = MIN($FC00, $FFF0 - __hiram_reserved_size)` and `__hiram_reserved_size` defaults to 0 — so the program gets `$0200`–`$FBFF` and the soft stack starts at `$FC00`, growing down. Zero page from `$0020` (after the 32 imaginary registers). | `mos-platform/lynx-bll/lib/link.ld` |
| The script's own comment: memory from `$FFF0` down "is mapped to the graphics hardware but not to the CPU by default", and reserving it is the way "to store a display screen". I.e. the framebuffer is meant to live *under* the Suzy/Mikey/ROM overlay, where the display DMA can read it. | same file |
| Output format: `80 08`, start address big-endian (`$0200`), length big-endian (including the 10-byte header), `BS93`, then the RAM image — a BLL loadable, not a cartridge. | same file, `OUTPUT_FORMAT`; `xxd empty.lynx-bll` |
| crt0 touches no hardware: `_start` stores the soft-stack pointer into `__rc0/1` and `jsr main`; `exit` spins. No MAPCTL write, no timer, no DISPCTL/DISPADR, no palette. Whoever loads the BS93 file (the BLL loader, or the emulator) leaves the display in *its* state. | `llvm-objdump -d empty.lynx-bll.elf`; `llvm-ar t lynx/lib/libcrt0.a` (only the generic init-stack/zero-bss/exit members) |
| libc has no Lynx-specific member: no display init, no joystick, no EEPROM, no ComLynx code. | `llvm-ar t mos-platform/lynx/lib/libc.a` |
| Suzy at `$FC00`: sprite engine registers `$FC00`–`$FC2F` (TMPADR, TILTACC, HOFF `$FC04`, VOFF `$FC06`, SPRBASE, **COLBASE `$FC0A`**, **VIDADR `$FC0C`**, COLADR, **SCBNEXT `$FC10`**, …); hardware math `$FC52`–`$FC6F` (FACTOR_A/B, PRODUCT 32-bit at `$FC60`, DIVIDEND/DIVISOR/QUOTIENT/REMAINDER); SPRCTL0 `$FC80`, SPRCTL1 `$FC81`, SPRCOLL `$FC82`, SPRINIT `$FC83`; SUZYHREV `$FC88`; SUZYBUSEN `$FC90`, **SPRGO `$FC91`**, **SPRSYS `$FC92`**; **JOYSTICK `$FCB0`**, **SWITCHES `$FCB1`**, **CART0 `$FCB2`**, CART1 `$FCB3`; LEDS `$FCC0`, parallel port `$FCC2`/`$FCC3`. | `mos-platform/lynx/include/_suzy.h` (`struct __suzy`) |
| Joypad bits at `$FCB0`: RIGHT `$10`, LEFT `$20`, DOWN `$40`, UP `$80`, OPTION1 `$08`, OPTION2 `$04`, INNER `$02` (B), OUTER `$01` (A). `$FCB1` bit 0 = PAUSE. Polarity is not stated in the header. | `_suzy.h` `JOYPAD_*`, `BUTTON_*`; `lynx.h` `JOY_*_MASK` |
| SPRCTL0: bits 7–6 bpp (`BPP_1 $00`, `BPP_2 $40`, `BPP_3 $80`, `BPP_4 $C0`), HFLIP `$20`, VFLIP `$10`, bits 2–0 sprite type: BACKGROUND 0, BACKNONCOLL 1, BSHADOW 2, BOUNDARY 3, NORMAL 4, NONCOLL 5, XOR 6, SHADOW 7. SPRCTL1: LITERAL `$80` vs PACKED `$00`, ALGO3 `$40`, reload bits RENONE/REHV/REHVS/REHVST (`$00/$10/$20/$30` — which of hsize/vsize/stretch/tilt the SCB carries), REUSEPAL `$08`, SKIP `$04`, DRAWUP `$02`, DRAWLEFT `$01`. | `_suzy.h` |
| SCB layout (the "REHVST_PAL" form): `sprctl0, sprctl1, sprcoll, next (ptr), data (ptr), hpos (int), vpos (int), hsize (uint), vsize (uint), stretch (uint), tilt (uint), penpal[8]` — 8 bytes of pen palette = 16 nibbles mapping sprite pen → framebuffer colour index; smaller SCB forms drop fields from the end (`SCB_RENONE` is 11 bytes). `PENPAL_1/2/3/4` are 1/2/4/8 bytes. | `_suzy.h` typedefs |
| SPRGO: `SPRITE_GO $01`, `EVER_ON $04`. SPRSYS write: SIGNMATH `$80`, ACCUMULATE `$40`, NO_COLLIDE `$20`, VSTRETCH `$10`, LEFTHAND `$08`, CLR_UNSAFE `$04`, SPRITESTOP `$02`; read: MATHWORKING `$80`, MATHWARNING, MATHCARRY, VSTRETCHING, LEFTHANDED, UNSAFE_ACCESS, SPRITETOSTOP `$02`, **SPRITEWORKING `$01`**. | `_suzy.h` |
| MAPCTL `$FFF9` bits: HIGHSPEED `$80`, VECTORSPACE `$08`, ROMSPACE `$04`, MIKEYSPACE `$02`, SUZYSPACE `$01`. The header names the bits; it does not say which sense unmaps the chip. | `_suzy.h` |
| Mikey at `$FD00`: 8 timers × 4 bytes (`reload, control, count, control2`) at `$FD00`–`$FD1F`; **timer 0 = HBL (`_HBL_TIMER $FD00`), timer 2 = VBL (`_VBL_TIMER $FD08`)**; the header's `_UART_TIMER` macro points at `$FD14` while its comment says "timer4 (UART)" — `$FD14` is the *fifth* 4-byte slot (timer 5); timer 4 is `$FD10`. Which slot clocks the UART is *to verify*; 4 audio channels × 8 bytes at `$FD20/$FD28/$FD30/$FD38` (`volume, feedback, dac, shiftlo, reload, control, count, other`); ATTENA–D `$FD40`–`$FD43`, PANNING `$FD44` (header: "?? not yet allocated?"), MSTEREO `$FD50`; INTRST `$FD80`, INTSET `$FD81`; AUDIN `$FD86`; SYSCTL1 `$FD87`; MIKEYREV `$FD88`; IODIR `$FD8A`, IODAT `$FD8B`; SERCTL `$FD8C`, SERDAT `$FD8D`; SDONEACK `$FD90`, CPUSLEEP `$FD91`, **DISPCTL `$FD92`** ("video bus request enable, viddma"), PKBKUP `$FD93` ("magic 'P' count"), **SCRBASE `$FD94`** (display base pointer); **palette 32 bytes at `$FDA0`–`$FDBF`**. | `mos-platform/lynx/include/_mikey.h`, `lynx.h` |

## From the sources, not verified here

Each is a lead to confirm the first time code depends on it. Sources:
Mednafen's Lynx module (which *is* Handy: `mednafen/lynx/*.cpp` in the
`beetle-lynx-libretro` mirror), cc65's Lynx runtime (`libsrc/lynx/crt0.s`,
`tgi/lynx-160-102-16.s`, `lynx-cart.s`), MAME's `src/mame/atari/lynx.cpp`,
the *Diary of an Atari Lynx developer* architecture post, and the Handy
"Rev P" hardware specification (not read here; the primary document).

**Clocks and CPU.** A 65SC02 at 16 MHz/4 = 4 MHz (MAME: `XTAL(16'000'000)
/ 4`, "G65SC02"); Suzy and the display share the bus so the effective CPU
rate is lower (the developer diary says ~3.6 MHz average). 65C02 opcodes
(`bra`, `stz`, `(zp)`) are what `-mcpu=mos65c02` emits; there is no
decimal mode on the 65SC02 *(to verify)*.

**Memory.** 64K DRAM, one flat space. `$FC00`–`$FCFF` Suzy, `$FD00`–`$FDFF`
Mikey, `$FE00`–`$FFF7` the 512-byte boot ROM, `$FFF8`–`$FFFF` vectors
(MAME map). RAM exists under all of it; MAPCTL `$FFF9` decides per area
whether the CPU sees the chip/ROM or the RAM (cc65's crt0 writes `$0C` =
ROMSPACE|VECTORSPACE, keeping Suzy and Mikey visible and — *to verify* —
exposing RAM in place of ROM and vectors). The display DMA and Suzy read
RAM regardless of MAPCTL, which is why every Lynx runtime puts the
framebuffers up there: cc65 uses `$E018`–`$FFF7` (buffer 0), `$C038`–`$E017`
(buffer 1) and `$A058`–`$C037` for the collision buffer, with the C stack
below `$C037`. Each buffer is 160×102×4 bits = **8160 bytes**; 80 bytes
per line (Mednafen `mikie.cpp`: "80 RAM accesses in rendering a line").

**Cartridge.** Not memory-mapped. The cart is read serially: an address
is shifted in through IODAT `$FD8B` (CART_ADDR_DATA) with SYSCTL1 `$FD87`
as the strobe, then each read of CART0 `$FCB2` returns a byte and advances
the counter (cc65 `lynx-cart.s`: "CART0 as a read strobe"). Pages are
256/512/1024/2048 bytes × 256 pages → 64K/128K/256K/512K per bank
(Mednafen `cart.cpp`, from the `.lnx` header's `page_size_bank0/1`);
two banks (RCART0/RCART1); Wikipedia lists 128K/256K/512K commercial carts
and up to 1–2 MB with bank switching. The `.lnx` header is 64 bytes:
`LYNX`, two page sizes, version 1, name, manufacturer, a rotation byte.
A cart's data is *copied* into RAM before use; there is no "ROM section" a
pointer can point at. EEPROM (93C46-family, on the cartridge, bit-banged
through Mikey's I/O lines) exists on later carts *(to verify: which lines;
cc65 has `lynx-eeprom.s`)*.

**Display.** 160×102, 4 bpp, 16 colours per scanline from a 12-bit
(4096) palette: 16 entries at `$FDA0`–`$FDBF`, green nibble in the first
16 bytes, blue/red byte in the second 16 (Mednafen `mikie.cpp`). DISPCTL
`$FD92` bits: DMAEnable, Flip, FourColour, Colour (`mikie.h`, bits 0–3 in
that order *to verify*); cc65 writes `$0D` (colour, 4-bit, DMA on, no
flip). SCRBASE/DISPADR `$FD94` is the buffer the DMA reads — swapping it
is the page flip. The palette can be rewritten from the HBL interrupt for
more than 16 colours per frame. Rotation (left/right-handed, the
`LEFTHAND` SPRSYS bit and DISPCTL Flip) is a hardware feature; the `.lnx`
header records which way a game expects to be held and Mednafen's
`lynx.rotateinput` follows it.

**Frame rate is set by two timers.** Timer 0 (HBL) counts lines; timer 2
(VBL) is linked to timer 0's borrow and counts 105 lines (102 visible +
3, MAME: "160x102 plus 3 blank scanlines"). cc65's crt0 loads timer 0
with backup `$9E`, control `$18` (RELOAD|COUNT, clock select 0), timer 2
with backup `$68` = 104 (→ 105 lines), control `$1F` (RELOAD|COUNT,
divide 7 = linked), DISPCTL `$0D`, PBKUP `$29`; its TGI driver switches
frame rate by HTIMBKUP/PBKUP: `$BD/$31` = 50 Hz, `$9E/$29` = 60 Hz,
`$7E/$20` = 75 Hz. With a 1 µs timer base *(to verify)* those give
(189+1)×105 = 19.95 ms ≈ 50.1 Hz, (158+1)×105 = 16.70 ms ≈ 59.9 Hz,
(126+1)×105 = 13.34 ms ≈ 75.0 Hz. PBKUP is the "magic P" DRAM-refresh
count and must change with the line time (cc65 keeps the pair together;
the formula is in the Handy spec, *to verify*). **Consequence: there is
no hardware frame rate.** The vertical blank is 3 lines of 105 — ≈ 380 µs
≈ 1500 CPU cycles at 75 Hz — which is not a work budget; the Lynx
double-buffers instead.

**Sprites (Suzy).** A linked list of SCBs starting at SCBNEXT `$FC10`,
started by SPRGO `$FC91` bit 0, finished when SPRSYS bit 0
(SPRITEWORKING) clears. Each sprite is drawn *into the framebuffer at
VIDADR* by the blitter — there is no per-frame sprite limit, no
per-scanline limit, and nothing "moves": the frame is rebuilt from the
list every frame (or only the changed parts, by choice). Per sprite:
1/2/3/4 bpp packed or literal data, a pen palette of up to 16 entries, H/V
flip, 8.8 fixed-point hsize/vsize scaling, stretch and tilt (shear), and
eight sprite *types* that decide how it interacts with the collision
buffer at COLBASE (one byte per pixel; each drawn sprite writes its
SPRCOLL number and reads back the highest number it overlapped into a
"collision depository" at COLLOFF) — that is the hardware collision
detection. The math unit (`$FC52`–`$FC6F`) is a 16×16→32 multiply with
optional accumulate and a 32/16 divide; SPRSYS reports MATHWORKING.
Mednafen `susie.cpp` implements exactly this set.

**Audio.** 4 channels, each an 8-bit DAC driven by a polynomial (LFSR)
shift register with programmable taps (`feedback`) and a `volume`; that
makes square waves, noise and everything in between, and writing the DAC
output register directly plays samples *(to verify)*. Lynx II adds
stereo/attenuation (`$FD40`–`$FD44`, `$FD50`); Lynx I is mono. No
envelopes, no filter — both are software from a timer interrupt. There is
no hardware entropy register; the LFSRs and timer counts are the raw
material *(to verify)*.

**Input.** `$FCB0` (D-pad, A/B, Option 1/2) and `$FCB1` bit 0 (Pause).
No keyboard, no mouse, no paddles. ComLynx is a UART (SERCTL/SERDAT,
timer 4 as the baud clock, up to 62500 baud, up to 8 units).

**Emulators.**
- *Mednafen* (`lynx` module; Handy-derived): needs `lynxboot.img` (512-byte
  boot ROM) in its base directory; loads `.lnx`, headerless ROMs, and
  **BS93 `.o` files straight into RAM** (`system.cpp`: `PresetForHomebrew`,
  boot vector from the header) — so an LLVM-MOS BLL build runs without a
  cart image. Settings: `lynx.lowpass`, `lynx.rotateinput`, `lynx.xscale`
  (default 6.0), shaders. Screenshot is the F9 key (`filesys.path_snap`);
  the general docs list no run-N-frames-and-exit or command-line
  screenshot option, so there is **no documented headless route**.
- *MAME* (`lynx` driver): cartslot accepts `.lnx`, `.lyx`, `.o` and
  validates the `80 08` BS93 header (`lynx.cpp`); needs its `lynxboot.img`
  (both dumps marked BAD_DUMP). Headless: `-str N -video none -sound none
  -nothrottle` writes a snapshot to the snapshot directory at exit
  (MAME docs: "-str … will write a screenshot"). That is the headless
  route for this machine.
- *Handy* itself is a Windows program; the libretro `handy` core is the
  same code as Mednafen's module. Neither adds a headless route.
- No emulator offers a host-filesystem mount: there is nothing on the
  Lynx to mount.

## Conflicts between sources

- `lynx.h` defines `_UART_TIMER` as `$FD14` but calls it "timer4"; by the
  4-byte timer stride in `_mikey.h`, `$FD14` is timer 5 and timer 4 is
  `$FD10`. Mednafen's `mikie.cpp` describes "Timer 4 (UART clock)". Use
  the timer *number* from the Handy spec, not the SDK macro, once checked.
- "4 MHz" (MAME, Wikipedia) vs "up to 4 MHz, ~3.6 MHz average" (developer
  diary). Both are right about different things: the crystal division is
  exact, the CPU loses bus cycles to Suzy and the display DMA. Do not
  hardcode a cycle count per frame; measure or use the timers.
- "16 simultaneous colours" (Wikipedia) vs "16 per scanline" (developer
  diary, Handy): the palette is 16 entries, rewritable per line.
- The header calls `$FD44` "panning ?? not yet allocated?" and `$FD50`
  "stereo control bits"; Mednafen implements pan/attenuation. Treat the
  stereo registers as Lynx II-only and *to verify* on Lynx I.

## Rules for this target

### Memory: one flat 64K, and the top 1K is two things at once

- Everything is a pointer: RAM `$0200`–`$FBFF` is directly dereferenceable
  and there is no bank register. But `$FC00`–`$FFFF` is Suzy/Mikey/ROM to
  the CPU and RAM to the display DMA and Suzy at the same time. A
  framebuffer address in that range is not something the CPU may write
  through a pointer unless MAPCTL has unmapped the overlay, and the
  linker's `__hiram_reserved_size` is how a build says how much of that
  region the display owns. The runtime must own MAPCTL and never let a
  user pointer land there.
- The program plus every asset it will ever use must fit in RAM at once
  (through LLVM-MOS today: a BS93 image ≤ ~63K). Cartridge data on real
  hardware is *streamed* into RAM through CART0 — a loader, not a bank
  switch — so a future `.lnx` profile needs a "load asset N into buffer"
  API, not far pointers. This is the opposite of the C64's "ROM cartridge
  appears at `$8000`".
- 64K on paper is ~55K in practice once two 8160-byte framebuffers and a
  collision buffer are reserved. Budget in bytes, not "64K".

### Video: the frame is *built*, not *shown*

- There is no text mode, no charset, no tile map, no colour RAM. A
  portable `text.print` on the Lynx is a Suzy sprite (or a run of them)
  per glyph from a font stored as sprite data, blitted into the back
  buffer — 20×12 cells at 8×8, 26×17 at 6×6, whatever the font is. The
  X16-style "cell = address" model does not exist; `text.COLUMNS` is a
  property of the font the package chose.
- `screen.setBackground()` is the framebuffer fill (a full-screen
  BACKGROUND-type sprite is the fast way); there is no border and no
  border colour — the LCD *is* the 160×102 area. `setBorder()` is inert,
  the PET's answer.
- Draw into the back buffer, flip SCRBASE on the VBL interrupt (timer 2).
  Never draw into the buffer being displayed and never import the NES
  "queue writes for vblank" model: the vblank is 3 lines and the blitter
  runs during the visible frame by design.
- Colour is a 16-entry palette per frame (per line with an HBL handler).
  A portable colour name maps to a palette index the package assigns, and
  a 4-bpp sprite's pen palette maps pens to those indexes. Keep "palette
  index" and "pen" as two types.
- Hardware multiply/divide exists (Suzy math). The root rule "the 6502
  has no multiply" is *false here*; the codegen notes' `mulhi3`/`udivqi3`
  workarounds should yield to Suzy on this target for 16-bit work, with
  the MATHWORKING wait made explicit.

### Sprites: unlimited, but the CPU still pays per SCB

- No count limit, no per-scanline limit, no flicker: the constraint is
  blit time per frame (pixels written × scaling) and RAM for sprite data.
  The tooling's per-scanline sprite budget (NES, X16) becomes a per-frame
  *pixel* budget here. Estimate it; don't count sprites.
- Collision is per sprite via the collision buffer and SPRCOLL numbers —
  16 collision classes (`sprcoll` low nibble *to verify*) — and comes back
  after the chain finishes. Give a portable "did A touch B" primitive the
  Suzy answer; software AABB is the fallback, not the default.
- Scaling/tilt are free: a portable `sprites.place()` can carry a scale
  without a "not supported here" branch — the machine that *lacks*
  scaling (every other one) is the one that needs the branch.

### Timing: the program owns the frame rate

- `frameRate` maps directly onto timer 0/timer 2 reloads plus PBKUP; a
  Lynx `FRAME_SYNC` should set the timers for the requested rate (50, 60,
  75 are the community values) rather than divide a fixed rate the way
  the PAL/NTSC drivers do. `waitFrame()` = wait for the VBL interrupt (or
  poll INTSET bit for timer 2 under `sei`, like the other pollers).
- Don't count CPU cycles per frame from "4 MHz": Suzy and the display
  steal bus cycles. Time with a spare Mikey timer if a number is needed.

### Audio, input, storage

- Four LFSR/DAC channels with volume only; envelopes are software on a
  timer IRQ. Stereo only on Lynx II (a profile fact, not a machine fact).
- Input is two registers, read whenever; no debouncing hardware, no
  keyboard. A portable `input` maps D-pad + A/B + Option1/2 + Pause.
- Persistence is a *cartridge* property (EEPROM on some carts) and
  absent from the BLL/BS93 path entirely. Until a `.lnx` output exists,
  `lynx` has no persistence capability at all.

### Emulator

- Prefer MAME `lynx` for `8bs run lynx --screenshot` (the `-str` snapshot
  route, BS93 `.o` accepted directly); Mednafen for interactive use (loads
  the same `.o`, needs `lynxboot.img`). Both need the boot ROM the user
  must supply; `8bs setup lynx` cannot download it.

## Where things live

```
~/.local/opt/llvm-mos/bin/mos-lynx-clang          headers-only driver (no link.ld: cannot link)
~/.local/opt/llvm-mos/bin/mos-lynx-bll-clang      the driver that links: BS93 .o loadable, RAM $0200-$FBFF
~/.local/opt/llvm-mos/mos-platform/lynx/include/lynx.h      MIKEY/SUZY structs, _HBL_TIMER/_VBL_TIMER/_UART_TIMER, JOY_* masks
~/.local/opt/llvm-mos/mos-platform/lynx/include/_suzy.h     SCB typedefs, SPRCTL0/1 bits, SPRGO/SPRSYS, MAPCTL bits, register map
~/.local/opt/llvm-mos/mos-platform/lynx/include/_mikey.h    timers, audio channels, INTRST/INTSET, DISPCTL, SCRBASE, palette
~/.local/opt/llvm-mos/mos-platform/lynx-bll/lib/link.ld     __hiram_reserved_size, the BS93 OUTPUT_FORMAT
packages/lynx/                                    (future) the target package; screen/text as Suzy sprite blits
packages/backend-6502/src/index.mjs               (future) LYNX_PROFILES (bll | lnx page size | eeprom), FRAME_SYNC.lynx (timer 0/2 + PBKUP)
packages/cli/src/run.mjs                          (future) mame lynx -quik/-cart <file.o> -str N -video none; mednafen <file.o>
docs/roadmap.md                                   Phase 6: why the Lynx is in the list
```
