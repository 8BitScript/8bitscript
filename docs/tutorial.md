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

[`examples/border`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/border)
is the example that goes end to end today: it clears the leftover BASIC boot
screen, labels a `TICK` counter and the current `OPTION` number, and steps
the border and background through four curated colour combinations, on the
VIC-20, the C64, and the web, from one source file (two, counting the web's —
see below). It is the classic first sign of life on real hardware, so it is
the one worth seeing run before reading any code.

```bash
cd examples/border
pnpm start
```

`8bs build`s the program for the unexpanded VIC-20 (`$1001`, no memory
expansion — VICE's default), then opens it in `xvic`. You should see the
BASIC banner and `READY.` prompt disappear, replaced by a single line reading
`TICK` and `OPTION` near the top of the screen; the digit after `TICK` ticks
over roughly twice a second — it counts passes through the program's own
loop, not real display frames, which is why it's not called "FRAME": the
display itself is still refreshing at its usual 50/60Hz throughout. Every ten
ticks the screen switches to the next of the four colour options, with the
digit after `OPTION` changing alongside it. Close the emulator window when
you're done. `pnpm run start:web` shows the identical line drawn over the
canvas instead — same wording, same layout, same twice-a-second/every-ten-
ticks cadence, so the two feel like the same program rather than two
different demos that happen to share a name — plus a third number, `FPS`,
that only the web version has: how many times `frame()` actually ran in the
last real second, sampled once a second. It should read ~60 no matter the
display's actual refresh rate, since that's the whole point of the fixed
60Hz logical step described below — `FPS` is how you check that claim
instead of taking it on faith.

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

`examples/border/src/main.8bs`:

```
import { border, background, applyColors, screen } from "@8bitscript/machine";

let delay: volatile<usmallint> = 0;
let ticks: utinyint = 0;
let option: utinyint = 0;
let clearCell: usmallint = 0;

function clearScreen(): void {
    clearCell = 0;
    while (clearCell < screen.CellCount) {
        screen.putChar(clearCell, 32); // 32 = space, in every VIC/C64 charset
        clearCell = clearCell + 1;
    }
}

function drawLabels(): void {
    screen.putChar(0, 20);  // T
    screen.putColor(0, 1);
    screen.putChar(1, 9);   // I
    screen.putColor(1, 1);
    screen.putChar(2, 3);   // C
    screen.putColor(2, 1);
    screen.putChar(3, 11);  // K
    screen.putColor(3, 1);
    screen.putChar(4, 32);  // space
    screen.putChar(6, 32);  // space
    screen.putChar(7, 15);  // O
    screen.putColor(7, 1);
    screen.putChar(8, 16);  // P
    screen.putColor(8, 1);
    screen.putChar(9, 20);  // T
    screen.putColor(9, 1);
    screen.putChar(10, 9);  // I
    screen.putColor(10, 1);
    screen.putChar(11, 15); // O
    screen.putColor(11, 1);
    screen.putChar(12, 14); // N
    screen.putColor(12, 1);
    screen.putChar(13, 32); // space
}

function applyOption(): void {
    if (option == 0) {
        border = 6;
        background = 3;
    } else if (option == 1) {
        border = 2;
        background = 4;
    } else if (option == 2) {
        border = 5;
        background = 0;
    } else {
        border = 4;
        background = 2;
    }
}

export function main(): void {
    clearScreen();
    drawLabels();
    applyOption();
    applyColors();
    screen.showDigit(5, 0);
    screen.showDigit(14, 0);

    while (true) {
        ticks = ticks + 1;
        screen.showDigit(5, ticks % 10);

        if (ticks % 10 == 0) {
            option = option + 1;
            if (option == 4) {
                option = 0;
            }
            applyOption();
            applyColors();
            screen.showDigit(14, option);
        }

        delay = 0;
        while (delay < 12000) {
            delay = delay + 1;
        }
    }
}
```

- `@8bitscript/machine` is not a real package on its own — it is a
  target-conditional entry that resolves to `@8bitscript/vic20` or
  `@8bitscript/c64` depending on which machine you build for. Both export the
  same `border`, `background`, `applyColors()`, and the `screen` namespace, so
  this file never branches on the machine itself. See
  [target-conditional entries](packages.md#target-conditional-entries) for how
  that resolution works.
- `border` and `background` are ordinary globals until `applyColors()` writes
  them to hardware — one shared register on the VIC-20, two separate ones on
  the C64. That difference lives inside `applyColors`, not here.
- `delay` is `volatile<usmallint>`: without `volatile`, the optimiser would notice
  the inner loop computes nothing observable and delete it, and everything on
  screen would move faster than the eye can follow.
- `ticks`, `option`, and `clearCell` are ordinary globals too — there
  are no local variables yet, so every value a function needs to remember
  across calls, or a loop across passes, lives at module scope, same as
  `delay`. `ticks` is deliberately not called `frames`: it advances once per
  pass through the loop below, about twice a second — not once per real
  display frame, which keeps refreshing at its usual 50/60Hz the whole time
  regardless. `screen.showDigit()`'s label below reads "TICK" for the same
  reason.
- `screen.putChar(cell, code)` and `screen.putColor(cell, color)` poke one
  character cell's code and one cell's colour directly into screen memory —
  a flat cell index, not the `x`/`y` `screen.putChar` still on the roadmap
  (see `docs/roadmap.md`) — and `screen.CellCount` says how many cells the
  whole screen has (506 on the VIC-20, 1000 on the C64). None of that is
  automatic: `clearScreen()` and `drawLabels()` are this *program's* choice
  to call them, in a loop and a fixed sequence of pokes respectively, not
  something `@8bitscript/vic20`/`@8bitscript/c64` do on their own — a
  program that wants the BASIC boot screen left alone just doesn't call
  `clearScreen()`.
- `screen.showDigit(cell, digit)` pokes a single decimal digit (in white)
  at a cell — cell 5 for the tick counter, right after the `TICK ` label
  `drawLabels()` draws, and cell 14 for the option number, after `OPTION `.
- `applyOption()` maps the current `option` (0-3) to one of four curated
  border/background pairs with an `if`/`else` chain, not a lookup table —
  `array<T, N>` parses but isn't in the compiled subset yet either. None of
  the four backgrounds is white(1) or yellow(7), on purpose: the labels and
  digits always draw in white, and white text on a white (or nearly-white
  yellow) background is unreadable or invisible — a real bug this palette
  used to have.
- There is no keyboard or joystick input on any target, so "choosing" an
  option means editing `applyOption()` and rebuilding, not pressing a key
  while the program runs.

`pnpm run start:web` runs a *different* file, `main.web.8bs`: a browser tab
calls the program back once per frame instead of handing it the whole
machine forever, so the `while (true)` above has no web equivalent — see
[why step 1's program doesn't build for the web](learn/step1-main-loop.md#why-this-step-does-not-build-for-the-web)
for what its shape looks like instead, and `8bs.config.ts`'s `entry` map for
how one project points different targets at different files.

## Make a change

Edit the delay loop's bound — `12000` — to something larger or smaller, then
rebuild and run again:

```bash
pnpm start
```

A larger bound slows everything down, tick counter included; a smaller one
speeds it up. Try changing one of `applyOption()`'s colour pairs — option
0's `background = 3;`, say — to another value, or add a fifth `else if` case
and bump `main()`'s `option == 4` to `== 5`, and watch a new option join the
rotation.

## What doesn't compile yet

The compiler covers a fixed subset of the language today: globals, functions
with scalar parameters and return values, calls (with arguments, and usable
as expressions), arithmetic, `if`/`while`, hardware access including
`memory.read`/`memory.write`, `namespace` declarations for library surfaces
like `screen.setBorderColor(...)`, `asm6502`, and imports across modules.
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
  like `@8bitscript/machine` targets more than one machine from one API.
- [The compiler](compiler.md) — the pipeline from source to `.prg` or
  `.wasm`, and the diagnostic codes you'll hit while writing something that
  goes past the milestone subset.
- [`examples/counter`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/counter)
  — the smallest program that compiles, and the simplest of the two that also
  target the web (`pnpm run web` inside it, after `pnpm install`) — it has no
  `frame()`, so `8bs run web` just calls its `main()` once and prints the
  result, rather than opening a browser tab the way `examples/border` does.
- [Editor support](language-server.md) — diagnostics under the cursor while
  you write.

This page will grow past "run the one example that works" as locals, function
arguments, and the binder land — that is the whole reason it says work in
progress at the top.
