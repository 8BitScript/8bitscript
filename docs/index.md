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

Everything here describes work in progress. `8bs check`, `8bs doctor`,
`8bs build`, and `8bs run` work today for the first-milestone subset of the
language — [the compiler](compiler.md) says exactly where the line is. `8bs dev`
is **planned and not yet implemented**.

## Setup

Start with the [setup guide](setup/index.md). It covers the host toolchain, the
LLVM-MOS SDK, the VICE emulator, and how to verify the result. Its first page,
[Host toolchain](setup/host-toolchain.md), installs Node 26, pnpm 12, git,
and an editor — start there if you only need a machine ready to work on the
compiler. The remaining pages, in order:

- [LLVM-MOS SDK](setup/llvm-mos.md) — install the SDK and configure it for this
  project, without adding its tools to the global `PATH`.
- [VICE](setup/vice.md) — install VICE 3.10, point it at the VIC-20 ROMs, and
  verify the emulator starts.
- [Verify](setup/verify.md) — confirm the host and retro toolchains are both
  working.

## Getting started

Once setup is done, the [getting started tutorial](tutorial.md) walks through
cloning the repository, building and running the `examples/border` program,
and where to look next. It is a work in progress, same as everything else
here — it covers the one path that goes end to end today.

## Learn 8BitScript

[Learn 8BitScript](learn/index.md) is a series of small runnable projects,
one per step, each with a page that explains every file and every line: what
it is for, what it does, and what the compiler turned it into. It starts with
[Step 1: The main file](learn/step1-main-loop.md) — the files a project has,
`main()`, and the `while (true)` loop every program on these machines is
built around.

## The package model

[The package model](packages.md) describes how an 8BitScript project is laid
out, how the compiler resolves an import out of `node_modules`, and how the
toolchain is developed against the `examples/hello-vic` project inside this
repository. It is the specification the module resolver is being written
against.

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

This site is built from the `docs/` directory by `site/build.mjs` and served by
Cloudflare Workers at <https://8bitscript.org/>.
[Publishing the docs](project/deployment.md) is the runbook for it: what the
build does, the one-time GitHub and Cloudflare setup, how to preview locally,
and what to check when a page renders unstyled or a link 404s.

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
main.8bs  ->  compiler  ->  HIR  ->  MIR  -+->  web backend
                                           |
                                           +->  LLVM-MOS backend
```

Mermaid is reserved for the root `README.md`, which GitHub renders directly.
