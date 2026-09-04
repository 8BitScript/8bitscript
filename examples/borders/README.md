# borders

Cycles the border/background colours forever with a TICK/OPTION readout —
the classic first sign of life, with a bit more happening on screen, on
whichever machine you build for. One file, one program, on every target:
`main()` sets up once and `frame()` runs once per tick, forever, and nothing
in `src/main.8bs` drives that loop itself.

The walkthrough that builds and runs this project is
[docs/tutorial.md](../../docs/tutorial.md).

```bash
pnpm start            # VIC-20, NTSC
pnpm run start:c64    # C64, NTSC
pnpm run start:web    # browser
```

Every target has a `start:<target>` script (`pet`, `c128`, `atari8`, `nes`,
`cx16`, `mega65`, `web`); `build` and `build:<target>` compile to `dist/`
without opening the emulator. NTSC vs PAL is a `--pal` flag on `8bs build`
/`8bs run`, not a separate entry or target, for every target with a real
region split — `vic20`, `c64`, `c128`, `mega65`, `atari8` each have a
`start:<target>-pal` script. The flag is ignored for `pet`, `nes`, `cx16`,
and `web`, none of which have one (see [docs/setup](../../docs/setup) and
packages/backend-6502's `FRAME_SYNC` for why per target). `start:16k` and
`start:c64-reu` build for the VIC-20 16K and C64 REU memory profiles.

## What it shows

Three things: a small tick counter, a curated set of colour options the
program cycles through, and the border/background colours it sets from
whichever option is currently picked.

30 calls of `frame()` at 60Hz is half a second. Every *tick* (not every
`frame()` call) advances the ones digit shown at cell 5, and every ten ticks
the colour option (shown at cell 14) advances too — "TICK" on screen, not
"FRAME": a real frame counter would advance 60 times a second, and this
deliberately advances at about 2Hz instead, the same real-world rate on
every target.

`applyOption()` holds four curated border/background pairs, by name,
instead of cycling raw values 0-255 — every name is one of the eight every
machine package defines, so the same four pairs mean the same four pictures
on all of them (a VIC-20 border only reaches those eight). To change which
colours are displayed: add a case, bump the wrap check in `frame()` from 4,
and rebuild. None of the four backgrounds is White or Yellow:
`screen.showDigit()` and `drawLabels()` always draw in white, and white text
is invisible against a white background, barely readable against yellow.

## How the frame loop is driven

Every target calls `frame()` at the same real-world rate — an exact 60Hz of
real time, not a per-target guess and not whatever the display hardware
happens to refresh at — but *how* differs entirely below the language,
which is the point: `main.8bs` never says which target it's building for.

On the 6502 machines, the backend notices the module exports both `main`
and `frame` and synthesises the driving loop itself: it waits for the video
chip's raster to reach the top of the screen (real vertical blank, not a
busy-wait calibrated by hand), and because no machine's frame is exactly
1/60s — 59.83Hz on an NTSC C64, 60.29Hz on an NTSC VIC-20, ~50Hz on PAL —
it drains an exact fixed-point accumulator of logical frames owed rather
than blindly calling `frame()` once per blank (see packages/backend-6502's
`FRAME_SYNC`). On the web, the host's `requestAnimationFrame` loop paces
the same fixed 60Hz timestep against real elapsed time
(`packages/cli/src/web-runtime.mjs`). All of them tick in lockstep as a
result, indefinitely — none of them drifts.

A module that only exports `main`, with no `frame`, is unaffected — it keeps
meaning exactly what it always has (`examples/counter`,
`examples/step1-main-loop`): the whole program, looping forever on its own.

## What `@8bitscript/machine` provides

`@8bitscript/machine` resolves at build time to the target package for the
machine being built — `@8bitscript/vic20`, `@8bitscript/c64`,
`@8bitscript/nes`, and so on. Every one of them exports the same surface,
and this program leans on all of it:

- `border`/`background`/`applyColors()` for the colour registers (or
  whatever stands in for them: the NES draws its border as a frame of tiles,
  the X16 insets VERA's picture, the PET has no colour at all and ignores
  them), and `BorderColor`/`BackgroundColor`, the same eight colour names on
  every machine — Black, White, Red, Cyan, Purple, Green, Blue, Yellow —
  each holding whatever value that machine's hardware wants for that colour.
  A VIC-20 border is a 3-bit field, an Atari colour is a GTIA hue/luminance
  byte, an NES colour is a 2C02 palette index; none of that reaches
  `main.8bs`.
- `screen.putChar()`/`putColor()`/`showDigit()`/`CellCount` for the screen:
  a character grid whose cell 0 is the top-left corner inside the border on
  every machine, and whose character codes are ASCII on every machine —
  space, '0'-'9', 'A'-'Z' and a little punctuation, in upper case only, the
  portable set every target's character set can show. Each package turns
  those into what its hardware wants (a Commodore screen code, an ANTIC
  internal code, a tile index) and, on the Commodore machines, keeps the
  upper-case character set selected, so "TICK" reads the same on all of
  them.

Some of that surface is deliberately inert on hardware that has no such
thing (the PET has no colour; the NES and Atari have no per-cell colour, so
the `putColor()` calls are ignored and all text draws in white anyway), and
some of it is built rather than found (the NES draws its border, the X16
insets VERA's picture to make room for one). See each package's own file
comment.

## Why the program clears and labels the screen itself

Blanking the screen is this program's own choice, not something
`screen.showDigit` or `applyColors` does automatically: on real hardware the
Commodore machines boot into BASIC and leave its banner and "READY." on
screen, the NES's screen memory holds garbage at power-on, and a program
that never touches the rest of screen memory leaves all that there, mixed
in with whatever it draws. `screen.CellCount` is however many cells this
machine's grid has — 506 on the VIC-20, 1000 on the C64, 728 inside the
NES's frame, 4800 on the X16 — so the loop is the same everywhere.

`drawLabels()` draws the row-0 labels once, so the two digits mean
something without a general text API to lean on: "TICK " then its digit at
cell 5, "OPTION " then its digit at cell 14. The codes are ASCII ('A' is
65, 'T' is 84) — upper case, which is the portable set. The colour pokes are
for the machines with per-cell colour RAM; the others ignore them.

`clearCell`, the loop index for `clearScreen()`, is a global rather than a
local because there are no local variables in the compiled subset yet.

## Draw first, then `applyColors()`

Everything is drawn *before* the first `applyColors()`. On most machines the
order makes no difference; on the NES it does — its screen memory is only
freely writable while the picture is off, and `applyColors()` is what turns
the picture on (see `@8bitscript/nes`). Drawing first is correct
everywhere, so that is the order `main()` uses everywhere. From then on only
`frame()` touches the screen, a digit or two at a time.

## What isn't there yet

There is no general text API yet (that's `screen.putChar(x, y, code)` /
`input.*` in [docs/roadmap.md](../../docs/roadmap.md), not built — this
package's `screen.putChar` takes one flat cell index instead), so what this
program pokes onto the screen — clearing it, the "TICK"/"OPTION" labels, the
two digits — is entirely its own doing, not something the machine packages
do for it. There is also no keyboard/joystick input at all, so "changing" an
option means editing `applyOption()` and rebuilding, not pressing a key
while it runs.
