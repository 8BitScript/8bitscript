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
is the example that goes end to end today: it cycles the screen border through
every colour the machine has, on the VIC-20 and the C64, from one source file.
It is the classic first sign of life on real hardware, so it is the one worth
seeing run before reading any code.

```bash
cd examples/border
pnpm start
```

`8bs build`s the program for the unexpanded VIC-20 (`$1001`, no memory
expansion — VICE's default), then opens it in `xvic`. You should see the
border step through its colours, roughly twice a second. Close the emulator
window when you're done.

`package.json` has one script per target:

| Command | Machine | Region |
| ------- | ------- | ------ |
| `pnpm start` | VIC-20 | NTSC |
| `pnpm run start:pal` | VIC-20 | PAL |
| `pnpm run start:c64` | C64 | NTSC |
| `pnpm run start:c64-pal` | C64 | PAL |

`pnpm run build` (and its `:pal`, `:c64`, `:c64-pal` variants) compiles
without opening the emulator; output lands in `dist/` as a `.prg`, with the C
the backend generated alongside it, so what the compiler did is never a
mystery.

## What the program does

`examples/border/src/main.8bs`:

```
import { border, background, applyColors } from "@8bitscript/machine";

let delay: volatile<u16> = 0;

export function main(): void {
    background = 1;

    while (true) {
        applyColors();
        border = border + 1;

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
  same `border`, `background`, and `applyColors()`, so this file never
  branches on the machine itself. See
  [target-conditional entries](packages.md#target-conditional-entries) for how
  that resolution works.
- `border` and `background` are ordinary globals until `applyColors()` writes
  them to hardware — one shared register on the VIC-20, two separate ones on
  the C64. That difference lives inside `applyColors`, not here.
- `delay` is `volatile<u16>`: without `volatile`, the optimiser would notice
  the inner loop computes nothing observable and delete it, and the border
  would cycle faster than the eye can follow.

## Make a change

Edit the delay loop's bound — `12000` — to something larger or smaller, then
rebuild and run again:

```bash
pnpm start
```

A larger bound slows the cycle down; a smaller one speeds it up. Try changing
`background = 1;` to another value too, and watch the background colour
change along with it.

## What doesn't compile yet

The compiler covers a fixed subset of the language today: globals,
parameterless functions and calls to them, arithmetic, `if`/`while`, hardware
access, `asm6502`, and imports across modules. Anything past that — function
calls with arguments, member access, local variables — fails with a
diagnostic naming the construct, rather than compiling into something
silently wrong.
[`examples/hello-vic`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/hello-vic)
is written against APIs that need those constructs, so it does not build yet;
its README shows the diagnostics it produces and why that's the intended
behaviour, not a bug. [The compiler](compiler.md#the-first-milestone-achieved)
has the exact boundary.

## Where to go next

- [The package model](packages.md) — how imports resolve, and how a package
  like `@8bitscript/machine` targets more than one machine from one API.
- [The compiler](compiler.md) — the pipeline from source to `.prg` or
  `.wasm`, and the diagnostic codes you'll hit while writing something that
  goes past the milestone subset.
- [`examples/counter`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/counter)
  — the smallest program that compiles, and the only one that also targets
  the web (`pnpm run web` inside it, after `pnpm install`).
- [Editor support](language-server.md) — diagnostics under the cursor while
  you write.

This page will grow past "run the one example that works" as locals, function
arguments, and the binder land — that is the whole reason it says work in
progress at the top.
