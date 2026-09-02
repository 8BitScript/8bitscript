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

8BitScript targets the 6502 family of 8-bit machines — the processors LLVM-MOS
compiles for — plus the browser. Machines are added in phases, and the phases
are ordered so that each one forces the compiler to prove something new: first
that the language is separate from the VIC-20's hardware, then that it is not
a game language in disguise, then that it is not tied to Commodore at all.

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

Phase 1 is where the work is now: `web`, `vic20` and `c64` are the only
targets that exist, and together they are 8BitScript 0.1. Each phase also
names a native reference machine (C64, then C128, then Commander X16) on which
8BitScript's own development tools are written and then ported forward. The
full plan, with the reasoning behind each phase, is in
[the roadmap](roadmap.md).
## Architecture

```
main.8bs
   |
   v
parser  ->  binder  ->  checker  ->  HIR  ->  MIR
                                              |
                    +-------------------------+-------------------------+
                    |                                                   |
                    v                                                   v
              web backend                                    LLVM-MOS backend
                    |                                                   |
                    v                                                   v
        generated AssemblyScript                                 generated C
                    |                                                   |
                    v                                                   v
                   asc                             mos-vic20-clang / mos-c64-clang
                    |                                                   |
                    v                                                   v
                  .wasm                                               .prg
                    |                                                   |
                    v                                                   v
                 browser                                              VICE
```

## What 8BitScript is not

- **Not TypeScript.** It borrows the syntax and nothing else. Existing
  TypeScript code will not compile, and a package written for Node or the
  browser cannot be imported. 8BitScript's own packages *are* distributed
  through npm — see [the package model](packages.md) — but a package has
  to be written in 8BitScript to be usable from it.
- **Not an interpreter.** There is no bytecode VM and no evaluation loop
  shipped with your program; everything is compiled ahead of time.
- **Not a 6502 assembler/linker/register-allocator (LLVM-MOS does that).**
- **Not a React framework.** It has no components, no virtual DOM, and no
  reactive rendering model. The web target is a compilation target, not a UI
  library.

## Status

Nothing compiles yet. What does work is error reporting: the compiler has a
lexer, one checker rule, and a diagnostics layer, and both `8bs check` and the
language server run on them. So this reports a real error, in the terminal and
under the cursor:

```
let score: u8 = 300;
```

```
error 8BS1021: 300 does not fit in u8 (0..255)
```

Imports are checked too, against the package model: an uninstalled package or
one that is not an 8BitScript package is reported rather than failing later in
a strange way.

The first milestone compiles and runs on both targets. `8bs build` takes a
program through lexer, parser, checker, IR, linker, and a backend — generated
C and LLVM-MOS for a VIC-20 or C64 `.prg`, generated AssemblyScript and asc
for a `.wasm` — and `8bs run vic20` opens the result in VICE.
`examples/counter` is the milestone program; `examples/border` is one source
file that cycles the border colours on the VIC-20 *and* the C64, importing
its colour API from `@8bitscript/machine` — a package whose entry resolves
per target to the machine package underneath.

Only the milestone subset compiles: globals, parameterless functions and
calls to them, arithmetic, `if`/`while`, hardware access, `asm6502`, and
imports, which the linker resolves across modules. Everything else —
calls with arguments, member access, locals — fails with a diagnostic naming
the construct rather than building without it. There is no binder yet, `8bs dev` is
**planned and not yet implemented**, and breaking changes arrive without
notice.

## Getting started

There is nothing here that produces a working program yet. What you can do is
prepare your machine — setup instructions for the host and retro toolchains
live in the [setup guide](setup/index.md) — and read
[the package model](packages.md), which is how projects will consume 8BitScript
and the specification the resolver is being written against.

## File extensions

| Extension      | Contents                                                       |
| -------------- | -------------------------------------------------------------- |
| `.8bs`         | 8BitScript source                                               |
| `.ts` / `.tsx` | TypeScript source for the compiler, tooling, and web runtime     |
| `.s`           | 6502 assembly, hand-written or emitted by the LLVM-MOS backend   |

## License

MIT. See the `LICENSE` file at the root of the repository.

## Branching

This project is trunk-only: all work lands on `trunk`. There are no long-lived
feature branches and no release branches. Keep changes small enough to merge
directly.
