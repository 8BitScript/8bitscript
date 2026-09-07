---
title: Getting started
nav_order: 5
---

# Getting started

This walks through building and running an 8BitScript program for the first
time. It is a work in progress, same as the rest of the toolchain: it covers
the one path that goes end to end today, and it grows as more of the language
compiles. If a step here stops matching what the CLI actually does, the CLI is
right and this page is stale — file that as a bug in the docs.

## Before you start

You need the host toolchain, the LLVM-MOS SDK, and VICE installed. Work
through the [setup guide](setup/index.md) first if you have not already; its
last page, [Verify your setup](setup/verify.md), gives you `pnpm run doctor`,
which checks all of it in one command.

Nothing here is published to npm yet — every package under `packages/` is
private, and examples consume them with `workspace:*` so pnpm links them
straight out of the monorepo (see [the package model](packages.md) for why).
That means today's starting point is this repository, not a fresh directory
with an `8bs` install in it. You write and run programs inside `examples/`
until that changes.

## Clone and install

```bash
git clone https://github.com/8BitScript/8bitscript.git
cd 8bitscript
pnpm install
```

Then confirm the toolchain is ready:

```bash
pnpm run doctor
```

Every row should say `ok`. If one doesn't, `pnpm run doctor` names the setup
page that fixes it.

## Run an example

[`examples/borders`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/borders)
is the example that goes end to end today: it clears the leftover BASIC boot
screen, labels a `TICK` counter and the current `OPTION` number, and steps
the border and background through four curated colour combinations — one
program, one source file, on every target from the VIC-20 to the NES to
the web. It is the
classic first sign of life on real hardware, so it is the one worth seeing
run before reading any code.

```bash
cd examples/borders
pnpm start
```

`8bs build`s the program for the unexpanded VIC-20 (`$1001`, no memory
expansion — VICE's default), then opens it in `xvic`. You should see the
BASIC banner and `READY.` prompt disappear, replaced by a single line reading
`TICK` and `OPTION` near the top of the screen; the digit after `TICK` ticks
over roughly twice a second — it counts *ticks*, not real display frames,
which is why it's not called "FRAME": see [what the program
does](#what-the-program-does) below for what a tick actually is. Every ten
ticks the screen switches to the next of the four colour options, with the
digit after `OPTION` changing alongside it. Close the emulator window when
you're done.

`pnpm run start:web` runs the *identical* file and shows the identical line
drawn over the canvas instead — same wording, same layout, same cadence, so
the two read as one program rather than two demos that happen to share a
name. It also shows a second, clearly separate number in the corner, `FPS`:
how many frames the program actually took — `waitFrame()` calls that
returned — in the last real second, sampled once a second. It should read
this project's `frameRate`
(60 by default — see `8bs.config.ts`) no matter the display's actual
refresh rate — that claim is checked below, not just made.

`package.json` has one script per target:

| Command | Machine | Region |
| ------- | ------- | ------ |
| `pnpm start` | VIC-20 | NTSC |
| `pnpm run start:pal` | VIC-20 | PAL |
| `pnpm run start:c64` | C64 | NTSC |
| `pnpm run start:c64-pal` | C64 | PAL |
| `pnpm run start:web` | Web | — (no PAL/NTSC on the web; see below) |

`pnpm run build` (and its `:pal`, `:c64`, `:c64-pal`, `:web` variants)
compiles without opening the emulator or browser; output lands in `dist/` as
a `.prg` (VIC-20/C64) or a `.wasm` (web), with the C or AssemblyScript the
backend generated alongside it, so what the compiler did is never a mystery.

## What the program does

`examples/borders/src/main.8bs`:

```
import { screen, BorderColor, BackgroundColor } from "@8bitscript/screen";
import { text } from "@8bitscript/text";

// The four colour pairs, as two tables. A `const` array is data in the
// program — never in RAM — and its elements are resolved by 8bitscript,
// like the `#frames(...)` below: `BorderColor.BLUE` is a number by the
// time the machine sees it. `BORDERS.length` is 4, worked out at compile
// time, so adding a pair means adding a line to each table and nothing else.
const BORDERS: array<utinyint, 4> = [
    BorderColor.BLUE, BorderColor.RED, BorderColor.GREEN, BorderColor.PURPLE,
];
const BACKGROUNDS: array<utinyint, 4> = [
    BackgroundColor.CYAN, BackgroundColor.PURPLE, BackgroundColor.BLACK, BackgroundColor.RED,
];

let framesUntilTick: utinyint = #frames(0.5, seconds);
let ticks: utinyint = 0;
let option: utinyint = 0;

// The whole HUD is one template: the text is drawn as written, and each
// `${...}` field is laid out at compile time into a zero-padded number
// field of the width after the `:` — one digit each here — at the cell the
// text before it adds up to. Nothing is formatted at runtime: this becomes
// the same print/printNumber calls a person would write by hand.
function drawHud(): void {
    text.print(0, `TICK ${ticks % 10:1} OPTION ${option:1}`);
}

// The current pair, looked up in the tables above.
function applyOption(): void {
    screen.setColors(BORDERS[option], BACKGROUNDS[option]);
}

// The program: set up once, then loop forever, one pass per frame.
//
// Draw everything before the first screen.setColors(): the NES only allows
// screen writes while the picture is off, and setColors() turns it on.
// From then on, every screen write happens right after waitFrame() returns —
// which on the NES is the start of vertical blank, the only time its screen
// memory is writable while the picture is on.
export function main(): void {
    screen.blank(BORDERS[option], BACKGROUNDS[option]); // every cell blank, both colours set
    text.setColor(TextColor.YELLOW); // the current colour: everything printed from here on
    drawHud();

    while (true) {
        waitFrame();

        framesUntilTick = framesUntilTick - 1;
        if (framesUntilTick == 0) {
            framesUntilTick = #frames(0.5, seconds);

            ticks = ticks + 1;
            if (ticks % 10 == 0) {
                option = option + 1;
                if (option == BORDERS.length) {
                    option = 0;
                }
                applyOption();
            }
            drawHud();
        }
    }
}
```

- `@8bitscript/screen` and `@8bitscript/text` have no code of their own —
  each is a target-conditional entry that resolves to the machine package's
  own implementation: `@8bitscript/vic20/screen`, `@8bitscript/c64/screen`,
  `@8bitscript/nes/text`, and so on, depending on which machine you build
  for. Every machine implements the same `screen` namespace
  (`setColors(border, background)`, with `BorderColor`/`BackgroundColor`
  beside it) and the same `text` namespace, so this file never branches on
  the machine itself. One package per capability, so the import lines say
  which parts of the machine the program uses. See [target-conditional
  entries](packages.md#target-conditional-entries) and [package
  subpaths](packages.md#package-subpaths) for how that resolution works.
- `BorderColor.BLUE` and the rest are the same eight names on every
  machine — Black, White, Red, Cyan, Purple, Green, Blue, Yellow — each
  holding whatever that machine's hardware wants for that colour: a
  Commodore colour number, a GTIA hue/luminance byte on the Atari, a
  palette index on the NES. The program says "blue"; the package says what
  blue is.
- `screen.setColors(border, background)` is the line where the screen
  changes: one shared register on the VIC-20, two separate ones on the C64,
  two bytes in a browser tab's wasm memory on the web, a palette write and
  a drawn frame on the NES. That difference lives inside each machine's
  `setColors`, not here. Both colours in one call, because on the NES and
  the X16 setting them genuinely is one operation.
- `main()` is the program: the file's one exported function, where the
  machine starts (any name works — `main` is the convention, and the
  compiler insists on exactly one export from the entry file). It sets up
  once, then loops forever — the loop is written right here, in plain sight,
  the way every 8-bit program is written: set up, then `while (true)`, one
  pass per frame.
- `waitFrame()` is what makes a pass "per frame": it blocks until the next
  logical frame, then returns — the 8BitScript spelling of the wait-for-
  vertical-blank every 8-bit program does (cc65 calls it `waitvsync()`).
  Call it once per pass, and everything after it in the loop happens once a
  frame. It runs at the same real rate on every target — this project's
  configured `frameRate` (`8bs.config.ts`, default 60), not a per-target
  guess and not the display's own refresh rate. On the VIC-20/C64 it waits
  for the video chip's own raster line to reach the top of the screen — real
  vertical blank, 60Hz NTSC / 50Hz PAL by construction — through a 16-bit
  fixed-point accumulator accurate to well under a frame a day, so a 60Hz
  `frameRate` on a 50Hz PAL machine
  returns twice from one hardware frame every so often and the logical rate
  never drifts; no calibrated delay constant is involved (see
  `packages/backend-6502`). On the web the program runs in a worker and
  `waitFrame()` blocks on the page's frame clock, which releases frames on a
  fixed `1/frameRate` timestep regardless of the display's actual refresh
  rate — 60Hz, 120Hz, 144Hz, 50Hz, whatever it is (see
  `packages/cli/src/web-runtime.mjs`). `framesUntilTick`, `ticks`,
  and `option` are globals because the loop needs them across passes.
- `ticks` is deliberately not called `frames`: `waitFrame()` returns
  `frameRate` times a second, but the gate below it only lets `ticks`
  advance once every `#frames(0.5, seconds)` worth of those returns — about
  twice a second, whatever `frameRate` is set to. `#frames(0.5, seconds)` is
  a compile-time constant that folds to the exact frame count half a second
  takes (30 at the default 60, 25 at a configured 50) — not a raw frame
  count written by hand, so the tick rate never has to be recomputed by hand
  if `frameRate` changes. The builtin is named for what it gives you, a
  frame count, and the second argument says what the literal is written in;
  it is required, so the call always reads as the conversion it is. The
  `#` is the language's one spelling for "8bitscript evaluates this before
  the target ever sees it" — a plain `name(...)` always runs on the machine
  — so nothing is reserved: a program may declare its own `frames`, and
  `seconds` is only a unit in that slot (see "What 8bitscript resolves" in
  [compiler.md](compiler.md)). "TICK" is what the HUD's label reads for exactly
  that reason: a real frame counter would move much faster than what's on
  screen.
- `text.putChar(cell, code)` and `text.putColor(cell, color)` poke one
  character cell's code and one cell's colour — a flat cell index; a
  position is `y * text.COLUMNS + x`, and `text.COLUMNS` is that machine's
  row width (22 on the VIC-20, 40 on the C64, 28 inside the NES's frame,
  80 on the X16) —
  and `text.CELL_COUNT` says how many cells the whole screen has (506 on
  the VIC-20, 1000 on the C64 and, as a safe superset, on the web's virtual
  screen too; 728 inside the NES's drawn frame; 4256 inside the X16's border inset). Codes are
  ASCII on every machine, upper case only — `84` is `T` everywhere — and
  each package turns them into whatever its hardware wants (the Commodore
  machines also switch themselves to the upper-case character set, since
  the runtime LLVM-MOS links in boots them into the lower-case one). Cell 0
  is the top-left corner inside the border on every machine, so the labels
  land in the same place on all of them. None of that runs automatically:
  `screen.blank()` and `drawHud()` are this *program's* choice to call, not
  something any machine package does on its own — a program that wants the
  BASIC boot screen left alone just doesn't call `screen.blank()`.
- `screen.blank(border, background)` blanks every cell and sets both
  colours. Left off, a colour is black — `screen.blank()` is a black
  screen — and `BorderColor.KEEP` or `BackgroundColor.KEEP` leaves one as
  it is. The parameters have *defaults*, compile-time values 8bitscript
  fills in at the call, so the machine always sees the two-argument call.
  Colours without erasing are `screen.setBorder`, `screen.setBackground`,
  or both with `screen.setColors`, which is what the ticking loop wants.
  On the NES a `blank` after the picture is on costs one dark frame, the
  way a scene change does.
- Names: a `const` is `UPPER_SNAKE` (`BORDERS`, `BorderColor.BLUE`,
  `text.CELL_COUNT`) and a variable starts lower-case (`ticks`, `option`).
  The compiler holds you to it, because the spelling is how a reader tells
  a value 8bitscript resolved from storage on the machine.
- `text.setColor(TextColor.YELLOW)` sets the *current colour*: every
  `print`/`printNumber` after it draws in that colour until the next
  `setColor`. `TextColor` has the same eight names on every machine as
  `BorderColor` does; on a machine with no per-cell colour (the PET, the
  Atari, the NES) the call is accepted and changes nothing.
- `text.print(cell, ...)` is how the HUD gets on screen, and its argument is
  a *template*: a backtick string whose `${...}` fields are placeholders
  for data. The compiler lays it out — at compile time — into the calls a
  person would otherwise write by hand: `text.print(0, "TICK ")` for the
  first run of text, then `text.printNumber(5, ticks % 10, 1)` for the
  field (cell 5, because "TICK " is five characters), then `" OPTION "` at
  cell 6, then `option` at cell 14. `printNumber` writes a value as exactly
  `width` decimal digits, zero-padded, so a field never shifts columns; the
  width is the number after the `:` in a field, or, left off, the digit
  count of the expression's type (three for a `utinyint`). Nothing formats
  at runtime, and no cell number is counted by hand. A plain `"TICK"` in
  double quotes works as `print`'s argument too. Both printers draw in
  white on the machines with per-cell colour. Strings are constant program
  data — ROM on a cartridge — holding only the portable character set
  (upper case, digits, space, and `! , - . : ?`), and a `string` is also a
  parameter type: `s.length` and `s[i]` are how the text package's own
  `print` walks one.
- `main()` draws everything first and sets the colours last, through
  `applyOption()`. On most machines the order is immaterial; on the NES it
  is the rule — its screen memory is only freely writable before the
  picture is switched on, which is what the first `screen.setColors()` does
  — so the file uses the order that is correct everywhere.
- `applyOption()` looks the current `option` (0-3) up in two tables,
  `BORDERS` and `BACKGROUNDS` — `const` arrays, data in the program rather
  than RAM, whose elements (`BorderColor.BLUE`) are resolved at compile
  time — and `BORDERS.length` is the number 4 wherever it is read. None of
  the four backgrounds is Yellow, on purpose: the HUD is printed in yellow
  (`text.setColor`), and yellow text on a yellow background is invisible.
- There is no keyboard or joystick input on any target, so "choosing" an
  option means editing `applyOption()` and rebuilding, not pressing a key
  while the program runs.

## Make a change

Edit `#frames(0.5, seconds)`'s first argument — the two places
`framesUntilTick` uses it — to something larger or smaller, then rebuild and
run again:

```bash
pnpm start
```

A larger duration slows the tick counter down; a smaller one speeds it up
(try `#frames(0.1, seconds)` for a snappier five ticks a second). This still works
out to the right frame count no matter what `frameRate` this project is
configured for — that's the whole point of writing a duration instead of a
raw frame count. Try changing one of
the colour pairs — `BACKGROUNDS[0]`, `BackgroundColor.CYAN`, say — to
another name, or add a fifth entry to each table and make them
`array<utinyint, 5>` — `BORDERS.length` becomes 5 at the one place it is
read, and the tables stay data in the program, not RAM — and watch a new
option join the rotation.

## What doesn't compile yet

The compiler covers a fixed subset of the language today: globals and
local variables, `array<T, N>` (`let` in RAM, `const` as data),
`string<N>` variables and `string` consts, functions with scalar
parameters and return values, calls (with arguments, and usable as
expressions), arithmetic, `if`/`while`/`for`, hardware access including
`memory.read`/`memory.write`, `namespace` declarations for library surfaces
like `screen.setColors(...)`, `asm6502`, imports across modules, `const`s
inlined at compile time, string literals as `string` parameters, and
templates laid out at compile time.
Anything past that — `ptr<T>`, a local array, an array as a function
argument, member access that isn't a declared namespace — fails with a
diagnostic naming the construct, rather than compiling into something
silently wrong.
[The compiler](compiler.md#the-first-milestone-achieved) has the exact
boundary.

## Where to go next

- [The package model](packages.md) — how imports resolve, and how a package
  like `@8bitscript/screen` targets more than one machine from one API.
- [The compiler](compiler.md) — the pipeline from source to `.prg` or
  `.wasm`, and the diagnostic codes you'll hit while writing something that
  goes past the milestone subset.
- [Editor support](language-server.md) — diagnostics under the cursor while
  you write.

This page will grow past "run the one example that works" as the binder
lands — that is the whole reason it says work in progress at the top.
