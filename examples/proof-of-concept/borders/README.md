# borders

Cycles the border/background colours forever with a TICK/OPTION readout —
the classic first sign of life, with a bit more happening on screen, on
whichever machine you build for. One file, one program, on every target:
`main()` sets up once, then loops forever, one pass per frame — the loop is
right there in `src/main.8bs`, paced by `waitFrame()`.

The walkthrough that builds and runs this project is
[docs/tutorial.md](../../../docs/tutorial.md).

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
`start:<target>-pal` script. The flag is ignored for `nes`, `cx16`, and
`web`, none of which have one (see [docs/setup](../../../docs/setup) and
packages/backend-6502's `FRAME_SYNC` for why per target). `start:16k` and
`start:c64-reu` build for the VIC-20 16K and C64 REU memory profiles (the
16K VIC-20 has its screen at `$1000`, not `$1E00`, and the build follows,
so it is its own file, `main-vic20-16k-ntsc.prg`). The
PET has no region either: its refresh rate is its model's, and the model is
a `--profile` — `start:pet` is the default 3032 (no CRTC, 40 columns, ~60Hz
under VICE), `start:pet-8032` the 80-column business machine (50Hz: VICE
runs the CRTC models' 50Hz editor ROMs, since the 60Hz ones make it refuse
autostart). One `.prg` runs on either — `waitFrame()` measures the actual
refresh — but the 8032 build draws to 80 columns, so it is its own file
(`main-pet-8032.prg`); see [docs/setup/vice.md](../../../docs/setup/vice.md#pet-models).

## What it shows

Three things: a small tick counter, a curated set of colour options the
program cycles through, and the border/background colours it sets from
whichever option is currently picked.

`framesUntilTick` starts at `#frames(0.5, seconds)` — a compile-time
constant that folds to however many frames — `waitFrame()` calls — make half
a second at this project's configured `frameRate` (30 at the default 60, 25
at a configured 50 — see `8bs.config.ts` and "How the frame loop is driven"
below). The builtin is named for what comes out, and the second argument
names what the literal is written in; `seconds` is the only unit so far, and
it is required. Every *tick* (not every frame) advances the ones digit shown at
cell 5, and every ten ticks the colour option (shown at cell 14) advances
too — "TICK" on screen, not "FRAME": a real frame counter would advance at
`frameRate` times a second, and this deliberately advances at about 2Hz
instead, the same real-world rate on every target regardless of `frameRate`.

`applyOption()` looks the current option up in two tables, `BORDERS` and
`BACKGROUNDS` — `const` arrays, four curated border/background pairs by
name instead of raw values 0-255 — and makes one call to
`screen.setColors()`. Every name is one of the eight every machine defines,
so the same four pairs mean the same four pictures on all of them (a VIC-20
border only reaches those eight). A `const` array is data in the program,
never RAM, and its elements are resolved by 8bitscript — `BorderColor.BLUE`
is a number by the time the machine sees it — so `BORDERS.length` is the 4
the loop compares against, worked out at compile time. To change which
colours are displayed: add a line to each table and rebuild. None of the four
backgrounds is Yellow: the HUD is printed in yellow — `main()` calls
`text.setColor(TextColor.YELLOW)` once, and that is the *current colour*
every `text.print()` after it draws in — and yellow text is invisible against
a yellow background.

## How the frame loop is driven

The program drives its own loop — `main()` sets up, then `while (true)`,
with `waitFrame()` as the first thing in each pass. `waitFrame()` blocks
until the next logical frame and returns: the 8BitScript spelling of the
wait-for-vertical-blank every 8-bit program does (cc65's `waitvsync()`), and
the only thing about timing the program ever says. It returns at the same
real-world rate on every target — this project's configured `frameRate`
(`8bs.config.ts`, default 60), not a per-target guess and not whatever the
display hardware happens to refresh at — but *how* differs entirely below
the language, which is the point: `main.8bs` never says which target it's
building for.

On the 6502 machines, `waitFrame()` is a small runtime function the backend
emits into the program (only when the program calls it — a program that
never does carries none of it): it waits for the video chip's raster to
reach the top of the screen (real vertical blank, not a busy-wait calibrated
by hand), and because no machine's frame is exactly 1/60s — 59.83Hz on an
NTSC C64, 60.29Hz on an NTSC VIC-20, ~50Hz on PAL — it keeps an exact
fixed-point accumulator of logical frames owed, so one hardware frame can
satisfy zero, one, or two `waitFrame()` calls and the long-run rate is
exactly `frameRate`, by construction (see packages/backend-6502's
`FRAME_SYNC`). On the web, the program runs in a worker — its own thread,
free to loop forever — and `waitFrame()` blocks on the page's frame clock,
which releases one logical frame per `1/frameRate` of real time while the
page paints the program's screen memory every display refresh
(`packages/cli/src/web-runtime.mjs`). All of them tick in lockstep as a
result, indefinitely — none of them drifts.

`frameRate` is a different, independent knob from `--pal`: `--pal` only
picks which real hardware/emulator region a build targets (NTSC vs PAL
electrical timing, see the `pnpm run start:<target>-pal` scripts above) and
changes nothing about the logical rate `waitFrame()` runs at. A project can
be built `--pal` and still logically tick at 60 (today's default), or built
NTSC while logically ticking at 50 — the two axes don't interact.
`#frames(...)` (see `framesUntilTick` above) always folds against
`frameRate`, never against `--pal`.

A program that never calls `waitFrame()` is just a program: one that returns
is finished, and one that loops without waiting keeps the CPU to itself
(and is not worth building for the web — the page would have nothing to
paint).

## What `@8bitscript/screen` and `@8bitscript/text` provide

The program imports one package per capability it uses, and each of them
resolves at build time to the target package's own implementation for the
machine being built — `@8bitscript/screen` to `@8bitscript/vic20/screen`,
`@8bitscript/c64/screen`, `@8bitscript/nes/screen`, and so on; the same for
`text`. Every target implements the same surface, and this program leans on
all of it:

- `screen.setColors(border, background)` for the colour registers (or
  whatever stands in for them: the NES draws its border as a frame of tiles,
  the X16 insets VERA's picture and paints the background into every cell,
  the PET has no colour at all and ignores the call), and
  `BorderColor`/`BackgroundColor`, the same eight colour names on every
  machine — Black, White, Red, Cyan, Purple, Green, Blue, Yellow — each
  holding whatever value that machine's hardware wants for that colour. A
  VIC-20 border is a 3-bit field, an Atari colour is a GTIA hue/luminance
  byte, an NES colour is a 2C02 palette index; none of that reaches
  `main.8bs`. Both colours in one call because on the NES and the X16 they
  genuinely are one operation.
- `text.print()`/`printNumber()`/`setColor()`/`putChar()`/`putColor()`,
  `CELL_COUNT`/`COLUMNS`, and the shared colour names in `TextColor` for
  the screen: a character grid whose cell 0 is the top-left
  corner inside the border on every machine, and whose character codes are
  ASCII on every machine —
  space, '0'-'9', 'A'-'Z' and a little punctuation, in upper case only, the
  portable set every target's character set can show. Each package turns
  those into what its hardware wants (a Commodore screen code, an ANTIC
  internal code, a tile index) and, on the Commodore machines, keeps the
  upper-case character set selected, so "TICK" reads the same on all of
  them.

Some of that surface is deliberately inert on hardware that has no such
thing (the PET has no colour; the NES and Atari have no per-cell colour, so
`setColor()` and `putColor()` change nothing and all text draws in the
machine's one text colour), and
some of it is built rather than found (the NES draws its border, the X16
insets VERA's picture to make room for one). Each implementation is a file
inside its machine's package — `packages/nes/src/screen.8bs`, say — built
on the registers or port protocol that package's `index.8bs` exports, and
nothing else; see each file's own comment.

## Why the program clears and labels the screen itself

Blanking the screen is this program's own choice, not something
`text.print` or `screen.setColors` does automatically: on real hardware the
Commodore machines boot into BASIC and leave its banner and "READY." on
screen, the NES's screen memory holds garbage at power-on, and a program
that never touches the rest of screen memory leaves all that there, mixed
in with whatever it draws. `screen.blank(border, background)` is the one
call that does it: every cell blank and both colours set, by whatever
route is cheapest on that machine (a fill of screen RAM on a Commodore,
VERA's auto-increment on the X16, a nametable fill with the picture off
on the NES). Both colours default to black — `screen.blank()` is a black
screen — and `BorderColor.KEEP` / `BackgroundColor.KEEP` leaves one as it
is. The text colour is not part of it.

`drawHud()` draws row 0 with one call — `text.print(0, \`TICK ${ticks %
10:1} OPTION ${option:1}\`)` — at start-up and again on every tick. The
backtick string is a template: the compiler splits it at compile time into
`text.print(0, "TICK ")`, `text.printNumber(5, ticks % 10, 1)`,
`text.print(6, " OPTION ")`, and `text.printNumber(14, option, 1)`, each at
the cell the text before it adds up to, so no cell number is counted by
hand and the generated code is exactly the hand-written version. The `:1`
is the field's width in digits (zero-padded, so a field never shifts
columns); left off, it is the digit count of the expression's type. Strings
are constant program data in the portable character set — upper case,
digits, space, `! , - . : ?` — and both printers draw in white on the
machines with per-cell colour RAM; the others ignore the colour.

`framesUntilTick`, `ticks`, and `option` are globals because the loop
needs them from one pass to the next; the loop counters inside the text
packages' `print` are locals, gone when the call returns.

## Draw first, then `screen.setColors()`

Everything is drawn *before* the first `screen.setColors()`. On most
machines the order makes no difference; on the NES it does — its screen
memory is only freely writable while the picture is off, and `setColors()`
is what turns the picture on (see `@8bitscript/nes`). Drawing first is correct
everywhere, so that is the order `main()` uses everywhere. From then on the
screen is only touched right after `waitFrame()` returns — a digit or two at
a time, and on the NES that moment is the start of vertical blank, the only
time its screen memory is writable while the picture is on.

## What isn't there yet

The text API is flat cells and templates (`text.print(cell, ...)`); a
position is `y * text.COLUMNS + x`, worked out by the program, and there is
no cursor and no scrolling (`input.*` is in
[docs/roadmap.md](../../../docs/roadmap.md), not built), so what this program
puts on the screen — the blank, the HUD line — is its own doing, not
something the machine packages do on their own. Number fields show unsigned
values up to 16 bits, and a template has no string fields (a `string<N>`
variable is printed with its own `text.print(cell, name)`). There is also
no keyboard/joystick input at all, so "changing" an
option means editing `applyOption()` and rebuilding, not pressing a key
while it runs.
