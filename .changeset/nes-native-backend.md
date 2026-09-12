---
"@8bitscript/compiler": patch
"@8bitscript/nes": patch
---

The NES builds natively: hello-world and 2048 both run under FCEUX.

`mos/image-nes.ts` produces a real cartridge — an iNES header, 32 KiB of
NROM PRG-ROM with the code at `$8000`, the 6502's reset/NMI/IRQ vectors on
top of it, and 8 KiB of CHR-ROM. That last part has no equivalent on any
other target: the NES has no character ROM, so the font `@8bitscript/nes`
ships as a native source is part of the FILE, and `mos/chr-nes.ts` reads
the data-only slice of GNU-as syntax that file is written in
(`.macro`/`.rept`/`.byte`/`.space` and integer expressions) rather than
expanding 512 tiles of artwork into literal bytes by hand.

`packages/nes`'s hardware sheet carries `__load_address` `$8000` (where
NROM maps PRG-ROM) and `__ram_ceiling` `$FFF9` — 32761 apart, which is the
32 KiB PRG-ROM the catalog documents less the three vectors and the one
`RTI` byte the two unused ones point at — plus `__bss_origin` `$0200` and
`__bss_ceiling` `$0800`, 1536 apart, exactly the `memory.ram` fact. Zero
page is the whole page: the 2A03 has no CPU port at `$00/$01`, there is no
OS, and NROM has no mapper registers, so there is nobody to be polite to.

`mos/startup/nes.ts` emits the reset handler: the APU's frame and DMC IRQs
silenced, the stack pointer the 6502's reset genuinely leaves undefined,
and the two vertical blanks the PPU needs before it accepts a write. Its
absence is invisible in the code and total on screen — the first `.nes`
built without it ran correctly and photographed as 256x240 pixels of
black. `main()` ending halts rather than `RTS`ing (nothing pushed a return
address), and on this machine the halt keeps delivering the package's
write queue at every vertical blank, which is what lets a program that
draws once and stops show anything. `waitFrame()` gets its NES runtime —
PPUSTATUS bit 7, whose read is its own acknowledgement — and calls
`FRAME_SYNC.nes`'s frame hook inside the blank; a hook the optimizer
inlined out of existence is refused by name rather than silently dropped.

Three changes here are machine-independent:

- **Mutable arrays on a ROM image.** A `.prg` is copied into RAM before it
  runs, so a mutable array could always ride inside the program image and
  be initialized by the load. A cartridge cannot: a store into it does
  nothing, silently, and `@8bitscript/nes`'s own write queue is such an
  array. An image that declares `writableImage: false` now gets its
  mutable arrays bump-allocated into the RAM window its sheet names,
  cleared at start-up (a cartridge's RAM holds garbage at power-on), with
  any real initializer copied down out of the ROM — and refused by name
  when that window is missing or too small.
- **`memory.read(addr);` as a statement** lowers. A read whose value is
  discarded looks like dead code and is the opposite: it is what resets the
  PPU's address/scroll write toggle and what acknowledges the PET's
  retrace flag. It was refused as an unlowered construct; it is now the
  load it always meant, and is never elided.
- **`FRAME_SYNC.nes`'s NTSC ratio** read 59601 CPU cycles per two frames,
  which is 60.0585Hz. The NES's published rate is 60.0988Hz and the exact
  figure is 59561: 341 x 261 + 340.5 dots a frame (the pre-render line is a
  dot shorter on odd frames), twice, over the PPU's 3:1 ratio to the CPU.
  0.067% is invisible in a screenshot and about 58 logical frames of drift
  a day, which is the drift this accumulator exists to prevent.

`@8bitscript/nes` itself gains the lowercase half of its character set —
the font stopped at `Z`, so `Hello World!` drew as `H   W  !` — and a fix
to `locate()`, where a `utinyint` row multiplied by 32 wrapped at eight
bits and put every row below the eighth on the wrong one (2048's status
line, printed at row 21, landed on row 5). Its write queue drops from 112
bytes to 48: 112 was measured against the pre-0.2.0 toolchain's delivery
loop, this backend's is slower, and re-measuring under FCEUX put the
corruption edge at 56 on both a sparse and a full board.
