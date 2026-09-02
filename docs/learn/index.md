---
title: Learn 8BitScript
nav_order: 6
---

# Learn 8BitScript

A series of small, runnable programs, one per step, each with a page here that
explains every part of it: what each file is for, what each line does, and
why it is written the way it is. [Getting started](../tutorial.md) shows you
how to build and run a program; this series shows you how to *read* one, and
grows into writing your own.

Every step is a complete project under `examples/` that builds and runs on
the VIC-20 and the C64 today. Nothing here describes behaviour the compiler
cannot deliver: if a step says a program does something, that program does
it, and the page says what the compiler turned it into.

## How a step is laid out

Each step is a directory named `stepN-<topic>` under `examples/`, with the
same shape every real 8BitScript project has:

```
examples/step1-main-loop/
  src/
    main.8bs        the program
  8bs.config.ts     which file the program starts from, which machines it builds for
  package.json      the packages it uses, and the pnpm scripts that build and run it
  README.md         a pointer back to the page for this step
```

The page for a step walks through those files in that order. Later steps add
files to `src/` and keep the rest the same.

## Running a step

All of the steps are run the same way. From the repository root, after
`pnpm install`:

```bash
cd examples/step1-main-loop
pnpm start
```

`pnpm start` builds for the VIC-20 and opens the result in VICE. Every step's
`package.json` has the same set of scripts:

| Command | Machine | Region |
| ------- | ------- | ------ |
| `pnpm start` | VIC-20 | NTSC |
| `pnpm run start:pal` | VIC-20 | PAL |
| `pnpm run start:c64` | C64 | NTSC |
| `pnpm run start:c64-pal` | C64 | PAL |

`pnpm run build` and its `:pal`, `:c64`, and `:c64-pal` variants compile
without opening the emulator. The output lands in `dist/` as a `.prg`, next
to the C the compiler generated on the way there; the steps quote that C, and
the 6502 code LLVM-MOS made from it, so you can see what the machine actually
runs.

The interactive launcher at the repository root lists every step as well:

```bash
pnpm run examples
```

## The steps

1. [The main file](step1-main-loop.md) — the smallest program worth
   looking at: what the files are called, what `main()` is, how the colours
   reach the video chip, and why the program ends in a loop that never ends.

Further steps are planned and not written yet. Each one arrives together with
its example project, and the compiler's [milestone subset](../compiler.md)
sets the pace: a step is added only once every line of it compiles and runs
on both machines.
