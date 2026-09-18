---
title: 8BitScript
nav_order: 0
---

# 8BitScript

8BitScript is a statically compiled, TypeScript-flavored language for
classic 8-bit computers and the web. Two source kinds share one compiler:
`.8bs` is the core language — range-checked integers, arrays and strings
laid out at compile time, `asm6502` as a first-class construct, nothing
hidden — and `.8bx` adds declarative composition on top of it, elements
and components that elaborate to the same calls you would write by hand,
at the same cost.

**This release, 0.11.0, builds for all nine targets:** the Commodore PET,
VIC-20, C64 and C128, the Commander X16, the MEGA65, the Atari 8-bit, the
NES, and the web. The list is `RELEASE_MACHINES` in the compiler's
resolver, read by the CLI and the editor rather than kept twice.
`.8bx` — the composition language — ships in this release too, through
the spec's PR 15: components, props, `<slot />`, conditional composition,
component state and methods, and IntelliSense for all of it.

## Where to start

[The language, by task](language/index.md) — the manual. Every entry is
one thing you can do, with real code from the compiler's own tests, the
shipped examples, or 2048. Hello world both ways is its first page.

[Project config](config.md) — `8bitscript.config.ts`: targets and their
hardware, advertised and personal systems, several programs in one
project, disk images, and pointing a project at a local checkout.

[Putting a program in a web page](web-embedding.md) — the web target's
bundle and how a page hosts it.

## The command line

| Command | Does |
| ------- | ---- |
| `8bs check <files...>` | Front-end diagnostics, no build. |
| `8bs build --target <t>` | The real image for that machine; `--profile`, `--hardware`, `--size`, `--program`, `--release`. |
| `8bs run <t>` | Builds and boots it in the machine's emulator, or a browser tab for `web`; `--screenshot` for a headless capture. |
| `8bs boot <t>` | The stock (or fitted) machine booting to its own prompt, with nothing loaded. |
| `8bs targets [--json]` | Every target and its hardware catalog. |
| `8bs doctor` | Checks Node, pnpm, git, and the emulators. |
| `8bs setup <mega65\|cx16>` | Builds that machine's emulator and installs a ROM. |
| `8bs controller` | Names the buttons of the pad plugged into this machine. |
| `8bs lsp` | The language server, on stdio. |

Each is described in the manual's [Project & CLI](language/project.md)
page.

## How it is built

[Compiler](compiler.md) — the pipeline as built: lexer, parser, fold,
binder, checker, 8BX elaboration, IR, and the two backends (MOS 6502 and
WebAssembly).

[8BX specification](spec/8bx.md) — the design record for `.8bx`: 27
parts, 142 sections, the rules and the reasoning. Other pages cite it as
`§N`.

[8BX: composition for 8BitScript](project/8bx.md) — what the compiler has
of that spec today, which of its PRs have landed as which changes, and
where the code and the spec still differ.

[Controllers, across nine machines](project/input.md) — how
`@8bitscript/input` maps pads, sticks, keys and pointers per machine.

[i18n: catalogs, character sets, and direction](project/i18n.md) —
research toward a more modern message-catalog format (YAML/TOML), and an
honest look at what non-portable character sets and RTL can and can't do
on real 8-bit text hardware.

[Distribution and media](project/distribution.md) — mapping how a build
reaches a physical machine or an emulator: the hardware-catalog's
existing machine/hardware/media axes, the unwritten disk-image writer,
and the unbuilt "deploy to real hardware" layer (SD2IEC, cartridges,
flash carts).

[Machines on the roadmap](project/machines/index.md) — hardware research
notes for the machines named in later phases, the ones no package exists
for yet.

## Authoring these pages

Every page under `docs/` is Markdown with a `title` / `nav_order`
front-matter block. Pages link to each other with relative `.md` paths, so
the sources read on GitHub, and `site/build.mjs` rewrites those links for
the published site — a directory's `index.md` becomes a directory URL,
every other page an extensionless one. `site/nav.mjs` is the sidebar;
a new page is added there by hand.
