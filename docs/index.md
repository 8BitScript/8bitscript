---
title: 8BitScript Documentation
nav_order: 0
---

# 8BitScript Documentation

8BitScript is a TypeScript-flavoured language for writing software that runs in
the browser and on real 6502-family 8-bit hardware. These pages are the
reference for using the language and its toolchain. For the project overview,
principles, and architecture diagram, see [About 8BitScript](about.md). For
the order in which target machines are being added, and why, see the
[roadmap](roadmap.md).

Everything here describes work in progress. `8bs check` and `8bs doctor`
work today. `8bs build` and `8bs run` refuse every target until the native
backends emit (0.2.0) — [the compiler](compiler.md) says exactly where the
line is. `8bs dev` is **planned and not yet implemented**.

## Setup

Start with [Install from npm](install.md) if you are writing a program.
Work on the compiler itself from the [setup guide](setup/index.md). It covers
the host toolchain, the emulators each target needs, and how to verify
the result. Its first page, [Host toolchain](setup/host-toolchain.md),
installs Node 26, pnpm 12, git, and an editor. The remaining pages, in order:

- [VICE](setup/vice.md) — install VICE 3.10, point it at the VIC-20 ROMs, and
  verify the emulator starts.
- [Verify](setup/verify.md) — confirm the host toolchain and emulators are both
  working.

## Getting started

Once setup is done, the [getting started tutorial](tutorial.md) walks through
the language subset the front end already accepts, and where to look next.
Until 0.2.0, `8bs build` refuses every target, so there is no program to
run end to end.

## Studio

[Studio](studio.md) is the asset editor that ships with the toolchain and
runs on the machines themselves — the full editor on the Commander X16, a
smaller one on an expanded VIC-20, and a read-only viewer (look, listen,
load) on the PET and the NES. Today it is a front door with nothing behind
it yet; the page says exactly what runs.

## The package model

[The package model](packages.md) describes how an 8BitScript project is laid
out, how the compiler resolves an import out of `node_modules`, and how the
capability packages (`@8bitscript/screen`, `@8bitscript/text`) resolve per
target. It is the specification the module resolver is written against.

## Language reference

The pages below are planned. None of them are written yet, and no stub files
exist for them:

- `overview` — *not written yet*
- `syntax` — *not written yet*
- `types` — *not written yet*
- `arithmetic` — *not written yet*
- `memory` — *not written yet*
- `modules` — *not written yet*
- `native-code` — *not written yet*
- `portability` — *not written yet*

Do not create placeholder files for these pages yet; add a page only when it has
real content.

## Publishing

This site is built from the `docs/` directory by `site/build-all.mjs` and served by
Cloudflare Workers at <https://8bitscript.org/>. Each release is frozen at
`/0.1.0/`, `/0.2.0/`, and so on; `/` is the latest. The header dropdown
jumps between them. [Publishing the docs](project/deployment.md) is the
runbook.

## Authoring conventions

These conventions apply to every file under `docs/`. Follow them exactly so the
published site stays consistent.

**Front matter.** Every page under `docs/` begins with a YAML front-matter block
containing exactly two keys — `title` and `nav_order` — and nothing else:

```yaml
---
title: Page Title
nav_order: 3
---
```

`title` is the page's display name; `nav_order` controls its position in the
sidebar within its directory. Do not add `layout`, `description`, `parent`, or
other keys unless this convention is updated first.

**Directory landing pages are `index.md`, not `README.md`.** Each directory
under `docs/` has an `index.md` that introduces the directory and links to its
pages. `README.md` exists only at the repository root, for GitHub; it is not a
documentation page and carries no front matter.

**Link with relative `.md` paths.** Link between documentation pages using
relative paths that include the `.md` extension — `setup/index.md`,
`../index.md`, `vice.md`. These resolve both when browsing the sources on GitHub
and on the published site. Do not use absolute site paths or bare URLs for
internal links.

**Prefer ASCII diagrams under `docs/`.** Diagrams on documentation pages should
be plain ASCII inside a fenced code block, so they render identically everywhere
regardless of the site's diagram support:

```
main.8bs  ->  compiler  ->  IR  ->  linker  -+->  6502 backend (not built yet, 0.2.0)
                                              |
                                              +->  web backend (not built yet, 0.2.0)
```

Mermaid is reserved for the root `README.md`, which GitHub renders directly.
