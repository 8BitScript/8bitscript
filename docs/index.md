---
title: 8BitScript
nav_order: 0
---

# 8BitScript

8BitScript is a statically compiled, TypeScript-flavoured language for
classic 8-bit computers and the web.

**Nothing builds right now.** Version 0.2.0 replaces the external toolchains
(LLVM-MOS for the 6502 machines, `asc` for the web) with 8BitScript's own
code generators, assembler, linker, and file writers. Until the native
backend can build, `8bs build` and `8bs run` stop with a clear message on
every target.

The documentation that used to live here described the old pipeline. It has
been removed rather than rewritten against a plan. Each page returns when
the code it describes exists.

## The working document

The roadmap to the first program that boots — `HELLO WORLD` on a
Commodore PET — and the interim reference for every `8bs` command is the
working document titled **Hello, PET**:

<https://claude.ai/code/artifact/ada33539-fa98-46a7-a9a1-36532c8a2164>

The architecture behind it is the plan titled **Bare Metal**:

<https://claude.ai/code/artifact/98aec519-9820-497c-9556-c02d4f94c478>

## What works today

| Command | Status |
| ------- | ------ |
| `8bs check <files...>` | works: reports diagnostics from the front end |
| `8bs targets [--json]` | works: lists every target and its hardware catalog |
| `8bs doctor` | works: checks Node, pnpm, git, and the emulators; no compiler check |
| `8bs setup <mega65\|cx16>` | works: builds an emulator and installs a ROM |
| `8bs lsp` | works: the language server on stdio |
| `8bs build --target <t>` | fails honestly: the native backend is not implemented |
| `8bs run <t>` | fails honestly: stops before the emulator opens |
| `8bs dev` | planned |

## Still on this site

[Machines on the roadmap](project/machines/index.md) — hardware research
notes for the machines the toolchain does not target yet. They describe
hardware, not the toolchain, and are unchanged by the rewrite.
