---
title: About 8BitScript
nav_order: 1
---

# About 8BitScript

8BitScript is a statically compiled programming language for classic 8-bit
computers and the web, using TypeScript-inspired syntax without inheriting the
managed runtime that normally comes with it.

This page is the project overview for readers of the published documentation
site. The repository's root `README.md` carries the same overview for people
browsing the sources on GitHub.

## Project principles

- **Memory is explicit.** Layout, size, and lifetime are things you write down,
  not things the compiler decides for you behind your back.
- **Generated code is predictable.** A given construct lowers to the same shape
  every time, so you can read the output and know what the machine will do.
- **Zero hidden runtime cost.** There is no garbage collector, no boxing, and no
  implicit allocation. You pay only for what you write.
- **Portable APIs, without losing the target.** The standard APIs work the same
  on every target, and target-specific access stays available whenever you need
  the actual hardware underneath.
- **Native code is first class.** Inline assembly, external `.s` files, raw
  memory access, and platform-specific libraries are supported features of the
  language, not escape hatches bolted on the side.
- **The web build preserves native semantics.** The browser target is not a
  relaxed dialect: it honours the same memory model and the same arithmetic
  behaviour as the native build.

## Target systems

8BitScript targets the 6502 family of 8-bit machines, plus the browser.
Machines are added in phases, and the phases are ordered so that each one
forces the compiler to prove something new: first that the language is
separate from the VIC-20's hardware, then that it is not a game language in
disguise, then that it is not tied to Commodore at all.

| Phase | Targets | Goal |
| ----- | ------- | ---- |
| 0 | Web + 6502 simulator | Prove the compiler |
| 1 | VIC-20 + C64 + Web | Ship a usable 8BitScript (0.1) |
| 2 | PET + C128 | The Commodore family |
| 3 | Atari 8-bit + NES | Prove real portability |
| 4 | Commander X16 + MEGA65 | Powerful 65xx systems |
| 5 | Apple II + C16/Plus/4 + BBC Micro + Oric | Broaden the classics |
| 6 | Atari 5200 + Lynx + PC Engine + Supervision | Specialist platforms |
| 7 | Atari 2600 | Torture-test low-level control |
| 8 | Game Boy + Z80 family | First non-6502 backends |

Nine machine packages exist (`web`, `vic20`, `c64`, `pet`, `c128`, `atari8`,
`nes`, `cx16`, `mega65`). **No target builds on trunk until the native
backends land (0.2.0).** Each phase also names a native reference machine
(C64, then C128, then Commander X16) on which 8BitScript's own development
tools are written and then ported forward. The full plan, with the reasoning
behind each phase, is in [the roadmap](roadmap.md).

## Architecture

```
main.8bs
   |
   v
parser  ->  binder  ->  checker  ->  IR  ->  linker
                                              |
                    +-------------------------+-------------------------+
                    |                                                   |
                    v                                                   v
              web backend                                      6502 backend
         **Not built yet, 0.2.0**                         **Not built yet, 0.2.0**
                    |                                                   |
                    v                                                   v
                  .wasm                                         machine code
                                                                        |
                                                                        v
                                                          .prg / .xex / .nes / .rom
```

## How it compares

8BitScript sits between hand-written assembly and C on these machines, and
nowhere near BASIC.

**BASIC** (the ROM BASIC these machines shipped with) is tokenized and
interpreted: every line is re-parsed and dispatched by an interpreter loop
each time it runs. 8BitScript is compiled ahead of time to native machine
code — there is no interpreter shipped with your program and no per-line
dispatch cost at run time. An old BASIC line translates directly to a
compiler intrinsic rather than an interpreter call:

```basic
POKE 36879,27
```
```
memory.write(36879, 27);
```

**Assembly** gives you every byte and cycle, but you own register
allocation, memory layout, and stack discipline by hand, with no type
checking — nothing stops a two-byte pointer being treated as a one-byte
counter. 8BitScript keeps `asm6502` blocks, `@address` decorators, and
`memory.read`/`memory.write` as first-class language features, not
bolted-on escape hatches, so hand assembly is available inline wherever a
program actually needs it. 8BitScript is also its own assembler, linker,
and register allocator: that work is the 0.2.0 milestone, and the backends
that will do it exist today and refuse to emit. What the language already
controls is where every global lives — `.rodata`, `.data`, `.noinit`, or
`.zp.noinit` — decided by whether it is `const` or `let` and how it is
initialised, not left to a C-style runtime initialiser.

**C** is the closest relative on these machines: no garbage collector, no
boxing, no hidden allocation. 8BitScript adds range-checked, fixed-width
integers caught at compile time (`let score: u8 = 300;` fails to build with
`300 does not fit in u8 (0..255)` rather than silently wrapping), no
`malloc` and no heap (arrays and strings are laid out at compile time), and
portable APIs — `screen`, `text`, `input`, and so on — that resolve to each
machine's own implementation, so the same source targets nine different
machines without an `#ifdef` in sight. It does not go through C.

### What to expect for compiled size

There is no garbage collector, no boxing, and no hidden allocation in
either 8BitScript or C, so the two stay close by construction. The gap that
does exist is measured, not guessed at — the same C64 screen (blank it,
draw a line of text, loop), built three ways and checked pixel-identical in
VICE:

| Built as | Bytes |
| --- | --- |
| Hand-written C, screen codes precomputed into a table | 178 |
| 8BitScript, `screen.blank` + `text.print` calls | 482 |
| 8BitScript, the same through `@8bitscript/ui/menubar` | 809 |

The difference is what gets computed at compile time versus run time: the
hand-written version bakes the answer for one machine into a 24-byte table;
the portable calls convert ASCII to screen codes and lay out a menu bar at
run time, because the machine and the labels aren't known until then. Full
byte-by-byte accounting is in
[compiler.md](compiler.md#what-a-call-costs-on-a-6502-measured).

Those byte counts were measured against the pre-0.2.0 toolchain and remain
the absolute reference. Until the native backend's `build()` reports
`memory.program` and `memory.variables`, no new size claim can be made.

Absolute size is bounded by the machine, not the language. When the
backends emit, `8bs build` will print memory used —

```
memory: 3 bytes of RAM for variables, 771 bytes of program (code and data)
```

— and refuse to link a program that doesn't fit, saying by how many bytes.
The unexpanded VIC-20 — the machine 8BitScript targets first — has 3583
bytes of usable RAM; the web target caps static data (arrays and string
constants) at 8192 bytes.

## What 8BitScript is not

- **Not TypeScript.** It borrows the syntax and nothing else. Existing
  TypeScript code will not compile, and a package written for Node or the
  browser cannot be imported. 8BitScript's own packages *are* distributed
  through npm — see [the package model](packages.md) — but a package has
  to be written in 8BitScript to be usable from it.
- **Not an interpreter.** There is no bytecode VM and no evaluation loop
  shipped with your program; everything is compiled ahead of time.
- **It is a 6502 assembler, linker, and register allocator** — that work
  is the 0.2.0 milestone; the backends exist and do not yet emit.
- **Not a React framework.** It has no components, no virtual DOM, and no
  reactive rendering model. The web target is a compilation target, not a UI
  library.

## Status

**No target builds on trunk until the native backends land (0.2.0).** The
front end through the linker exists. Two backends live in
`@8bitscript/compiler` — `mos` and `wasm` — and both refuse: nothing
generates 6502 opcodes or WebAssembly, so `8bs build` fails for every
target. `8bs check` and the language server still run, so this reports a
real error in the terminal and under the cursor:

```
let score: u8 = 300;
```

```
error 8BS1021: 300 does not fit in u8 (0..255)
```

Imports are checked too, against the package model: an uninstalled package or
one that is not an 8BitScript package is reported rather than failing later in
a strange way.

The compiled subset lowers to IR: globals and locals, arrays (`let` in RAM,
`const` as data), `const`s (inlined at compile time), functions with
parameters and return values, arithmetic, `if`/`while`/`for`, hardware
access, `asm6502`, namespaces, strings (literals as `string` parameters,
`string` consts, `string<N>` variables, and templates —
`text.print(0, \`TICK ${ticks:1}\`)` — laid out at compile time), and
imports, which the linker resolves across modules. Everything else —
pointers and local arrays — fails with a diagnostic naming
the construct rather than lowering without it. There is no binder yet, `8bs
dev` is **planned and not yet implemented**, and breaking changes arrive
without notice.

`@8bitscript/screen`, `@8bitscript/text`, and [Studio](studio.md) exist as
packages. They do not produce an image until 0.2.0.

## Getting started

Setup is emulators only — the [setup guide](setup/index.md). There is no
external 6502 SDK. Until 0.2.0, `8bs build` refuses every target.
[The getting started tutorial](tutorial.md) walks through the language
subset the front end already accepts.

## File extensions

| Extension      | Contents                                                       |
| -------------- | -------------------------------------------------------------- |
| `.8bs`         | 8BitScript source                                               |
| `.ts` / `.tsx` | TypeScript source for the compiler, tooling, and web runtime     |
| `.s`           | Hand-written 6502 assembly the compiler will include; the backend does not emit `.s` files yet |

## License

MIT. See the `LICENSE` file at the root of the repository.

## Branching

This project is trunk-only: all work lands on `trunk`. There are no long-lived
feature branches and no release branches. Keep changes small enough to merge
directly.
