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

let framesUntilTick: utinyint = frames(0.5, seconds);
let ticks: utinyint = 0;
let option: utinyint = 0;
let clearCell: usmallint = 0; // global: no local variables yet

function clearScreen(): void {
    clearCell = 0;
    while (clearCell < text.CellCount) {
        text.putChar(clearCell, 32); // 32 = space
        clearCell = clearCell + 1;
    }
}

function drawLabels(): void {
    text.putChar(0, 84);  // T
    text.putColor(0, 1);
    text.putChar(1, 73);  // I
    text.putColor(1, 1);
    text.putChar(2, 67);  // C
    text.putColor(2, 1);
    text.putChar(3, 75);  // K
    text.putColor(3, 1);
    text.putChar(4, 32);  // space
    text.putChar(6, 32);  // space
    text.putChar(7, 79);  // O
    text.putColor(7, 1);
    text.putChar(8, 80);  // P
    text.putColor(8, 1);
    text.putChar(9, 84);  // T
    text.putColor(9, 1);
    text.putChar(10, 73); // I
    text.putColor(10, 1);
    text.putChar(11, 79); // O
    text.putColor(11, 1);
    text.putChar(12, 78); // N
    text.putColor(12, 1);
    text.putChar(13, 32); // space
}

function applyOption(): void {
    if (option == 0) {
        screen.setColors(BorderColor.Blue, BackgroundColor.Cyan);
    } else if (option == 1) {
        screen.setColors(BorderColor.Red, BackgroundColor.Purple);
    } else if (option == 2) {
        screen.setColors(BorderColor.Green, BackgroundColor.Black);
    } else {
        screen.setColors(BorderColor.Purple, BackgroundColor.Red);
    }
}

export function main(): void {
    clearScreen();
    drawLabels();
    text.showDigit(5, 0);
    text.showDigit(14, 0);
    applyOption();

    while (true) {
        waitFrame();

        framesUntilTick = framesUntilTick - 1;
        if (framesUntilTick == 0) {
            framesUntilTick = frames(0.5, seconds);

            ticks = ticks + 1;
            text.showDigit(5, ticks % 10);

            if (ticks % 10 == 0) {
                option = option + 1;
                if (option == 4) {
                    option = 0;
                }
                applyOption();
                text.showDigit(14, option);
            }
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
- `BorderColor.Blue` and the rest are the same eight names on every
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
  vertical blank, 60Hz NTSC / 50Hz PAL by construction — through an exact
  fixed-point accumulator, so a 60Hz `frameRate` on a 50Hz PAL machine
  returns twice from one hardware frame every so often and the logical rate
  never drifts; no calibrated delay constant is involved (see
  `packages/backend-6502`). On the web the program runs in a worker and
  `waitFrame()` blocks on the page's frame clock, which releases frames on a
  fixed `1/frameRate` timestep regardless of the display's actual refresh
  rate — 60Hz, 120Hz, 144Hz, 50Hz, whatever it is (see
  `packages/cli/src/web-runtime.mjs`). `framesUntilTick`, `ticks`,
  and `option` are ordinary globals — there are no local variables yet, so
  every value the loop needs to remember across passes lives at module
  scope.
- `ticks` is deliberately not called `frames`: `waitFrame()` returns
  `frameRate` times a second, but the gate below it only lets `ticks`
  advance once every `frames(0.5, seconds)` worth of those returns — about
  twice a second, whatever `frameRate` is set to. `frames(0.5, seconds)` is
  a compile-time constant that folds to the exact frame count half a second
  takes (30 at the default 60, 25 at a configured 50) — not a raw frame
  count written by hand, so the tick rate never has to be recomputed by hand
  if `frameRate` changes. The builtin is named for what it gives you, a
  frame count, and the second argument says what the literal is written in;
  it is required, so the call always reads as the conversion it is.
  `seconds` is the only unit so far, and it is not a reserved word — it is
  only a unit in that slot. "TICK" is what `text.showDigit()`'s label reads for exactly
  that reason: a real frame counter would move much faster than what's on
  screen.
- `text.putChar(cell, code)` and `text.putColor(cell, color)` poke one
  character cell's code and one cell's colour — a flat cell index, not the
  `x`/`y` `text.putChar` still on the roadmap (see `docs/roadmap.md`) —
  and `text.CellCount` says how many cells the whole screen has (506 on
  the VIC-20, 1000 on the C64 and, as a safe superset, on the web's virtual
  screen too; 728 inside the NES's drawn frame; 4800 on the X16). Codes are
  ASCII on every machine, upper case only — `84` is `T` everywhere — and
  each package turns them into whatever its hardware wants (the Commodore
  machines also switch themselves to the upper-case character set, since
  the runtime LLVM-MOS links in boots them into the lower-case one). Cell 0
  is the top-left corner inside the border on every machine, so the labels
  land in the same place on all of them. None of that runs automatically:
  `clearScreen()` and
  `drawLabels()` are this *program's* choice to call, in a loop and a fixed
  sequence of pokes respectively, not something any machine package does on
  its own — a program that wants the BASIC boot screen left alone just
  doesn't call `clearScreen()`.
- `text.showDigit(cell, digit)` pokes a single decimal digit (in white)
  at a cell — cell 5 for the tick counter, right after the `TICK ` label
  `drawLabels()` draws, and cell 14 for the option number, after `OPTION `.
- `main()` draws everything first and sets the colours last, through
  `applyOption()`. On most machines the order is immaterial; on the NES it
  is the rule — its screen memory is only freely writable before the
  picture is switched on, which is what the first `screen.setColors()` does
  — so the file uses the order that is correct everywhere.
- `applyOption()` maps the current `option` (0-3) to one of four curated
  border/background pairs with an `if`/`else` chain, not a lookup table —
  `array<T, N>` parses but isn't in the compiled subset yet either. None of
  the four backgrounds is White or Yellow, on purpose: the labels and
  digits always draw in white, and white text on a white (or nearly-white
  yellow) background is unreadable or invisible — a real bug this palette
  used to have.
- There is no keyboard or joystick input on any target, so "choosing" an
  option means editing `applyOption()` and rebuilding, not pressing a key
  while the program runs.

## Make a change

Edit `frames(0.5, seconds)`'s first argument — the two places
`framesUntilTick` uses it — to something larger or smaller, then rebuild and
run again:

```bash
pnpm start
```

A larger duration slows the tick counter down; a smaller one speeds it up
(try `frames(0.1, seconds)` for a snappier five ticks a second). This still works
out to the right frame count no matter what `frameRate` this project is
configured for — that's the whole point of writing a duration instead of a
raw frame count. Try changing one of
`applyOption()`'s colour pairs — option 0's `BackgroundColor.Cyan`, say — to
another name, or add a fifth `else if` case and bump the loop's
`option == 4` to `== 5`, and watch a new option join the rotation.

## What doesn't compile yet

The compiler covers a fixed subset of the language today: globals, functions
with scalar parameters and return values, calls (with arguments, and usable
as expressions), arithmetic, `if`/`while`, hardware access including
`memory.read`/`memory.write`, `namespace` declarations for library surfaces
like `screen.setColors(...)`, `asm6502`, and imports across modules.
Anything past that — member access that isn't a declared namespace, local
variables — fails with a diagnostic naming the construct, rather than
compiling into something silently wrong.
[`examples/hello-vic`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/hello-vic)
is written against APIs that need those constructs, so it does not build yet;
its README shows the diagnostics it produces and why that's the intended
behaviour, not a bug. [The compiler](compiler.md#the-first-milestone-achieved)
has the exact boundary.

## Where to go next

- [Learn 8BitScript](learn/index.md) — a series of small projects that
  explain a program part by part, starting with
  [the main file](learn/step1-main-loop.md): what the files are called, what
  `main()` is, and why it ends in a loop that never ends.
- [The package model](packages.md) — how imports resolve, and how a package
  like `@8bitscript/screen` targets more than one machine from one API.
- [The compiler](compiler.md) — the pipeline from source to `.prg` or
  `.wasm`, and the diagnostic codes you'll hit while writing something that
  goes past the milestone subset.
- [`examples/counter`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/counter)
  — the smallest program that compiles, and the simplest of the two that also
  target the web (`pnpm run web` inside it, after `pnpm install`) — its
  `main()` does one thing and returns, so in the browser the page just
  reports that the program finished; it never draws anything.
- [Editor support](language-server.md) — diagnostics under the cursor while
  you write.

This page will grow past "run the one example that works" as locals, function
arguments, and the binder land — that is the whole reason it says work in
progress at the top.
