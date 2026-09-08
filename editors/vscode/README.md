# 8BitScript for VS Code and Cursor

Syntax highlighting, a real language server, and a project runner for `.8bs`
files. The extension itself is still a thin client: it finds the project's
`8bs` toolchain and runs `8bs lsp --stdio`, and every diagnostic, hover, and
completion it shows comes from `@8bitscript/compiler` through that server —
not from anything reimplemented here. The same goes for building and running:
the side bar's launcher only ever starts the `8bs run` and `8bs build`
commands you would otherwise type. See [Editor support](../../docs/language-server.md) for
the split between the compiler, the language server, and this extension.

## What it does

- Registers `.8bs` as the language **8BitScript**
- Colours comments, strings and template strings (with their `${...}`
  fields), numbers (including the `0.5` a `#frames(...)` duration takes),
  types, keywords, declarations, calls, the compile-time `#frames(...)`
  and `#system()` (any `#name` colours as compile-time), the reserved `waitFrame()`, and
  the `seconds` unit inside a `#frames(...)` call
- **Snippets** for the constructs that compile — `program`, `loop`,
  `countdown`, `print`, `#frames`, `const`, `let`, `for`, `array`,
  `table`, `address`, `namespace`, `asm6502`, `poke`/`peek`. Nothing is offered that the compiler would
  reject, and the compiler's own test suite is what holds that
- `//` line comments and `/* */` blocks, so comment-toggling works, and a
  `/** */` block continues its `*` column on Enter
- Bracket matching, auto-closing pairs, and `// #region` folding
- Starts the language server (`8bs lsp --stdio`) when a `.8bs` file is open
  and the toolchain is installed, giving you:
  - **Diagnostics** — lexical, syntax, and range errors, as you type
  - **Hover** — documentation for built-in types (`utinyint`, `int`, ...),
    constructs (`string`, `volatile`, `ptr`, `array`, `asm6502`,
    `@address`, `memory.read`/`memory.write`), and the builtins
    `#frames(...)`, its `seconds` unit, and `waitFrame()`
  - **Completion** — built-in type names in type position (after `:` or
    inside `ptr<...>`/`array<...>`/`volatile<...>`), the compile-time
    functions after a `#`, and the unit words inside a `#frames(...)`
    call — inside a template's `${...}` field as much as outside one

If no toolchain is found, the extension says so and falls back to syntax
highlighting alone — see "Installing it while developing" below.

## The side bar

The extension adds an **8BitScript** icon — the pixel "8" from the project
logo — to the Activity Bar, the strip of icons down the left edge where the
file explorer, search, and source control live. Clicking it opens a side
bar with one thing in it: a launcher.

```
8BITSCRIPT                              📖  🚀  ♥  ⟳  …

  ┌──────────────────────────────────────────────┐
  │  ▶   Run borders                             │
  │      Commodore 64 · reu512 sid=8580 · NTSC   │
  └──────────────────────────────────────────────┘

  SYSTEM
  [ c64 — Commodore 64                      ▾ ]

  PROJECT
  [ borders  —  examples/borders            ▾ ] 🔧 📄

  ▸ HARDWARE · REGION · FACTS   reu512 sid=8580

  RUNNING
    borders        run · c64                  ⏹

  8bs run c64 --profile reu512 --hardware sid=8580
```

This used to be two views — a panel of dropdowns stacked on a tree of
projects that could lay itself out three different ways. Between them they
answered a question nobody asks a side bar. The question people do ask is
*run this*, so that is what the side bar is now: **one loud button** that
says what it is about to do, and everything else folded away.

The order down the panel is how often a thing is touched. The **system** is
directly under the button, because that is what changes between two runs of
the same program; the **project** under that, because it changes less; and
**Build** is an icon on the project's own row rather than a second big
button — it is the occasional action, and it belongs beside the thing it
builds.

- **Run** — starts `8bs run <system>` for the selected project as a task in
  its own terminal, from the project's directory with the project's own
  `node_modules/.bin/8bs`, so what you see is exactly what the CLI prints.
  The button names the project, and the line under it names the machine,
  the hardware fitted to it, and the region — nothing has to be read off a
  dropdown to know what pressing it means. It greys out when the selected
  project does not target the selected system, or its toolchain is
  missing, and says which in the line below.
- **Build** (🔧 on the Project row) — the same as Run, but `8bs build
  --target <system>`, which stops at the built file instead of starting an
  emulator.
- **Project** — the project both buttons act on (`8bitscript.project`).
  Every directory in the workspace with an `8bs.config.ts` is in the list,
  grouped with the **Examples** from the repository's `examples/` and the
  **Apps** that ship with the toolchain — packages whose `package.json`
  declares an `8bitscript.app`, [Studio](../../docs/studio.md) being the
  first. The grouping appears only when the list holds more than one kind.
  The 📄 beside it opens the project's entry `.8bs` file. Picking a project
  loads what it is set up for — the first of its systems, hardware and
  region and all — and a project with none keeps the current machine when
  it targets it.

  **The examples are not in the list by default** (`8bitscript.showExamples`).
  In a checkout of the 8bitscript repository they outnumber the projects
  you are working on, and the picker exists to reach *yours*. The 📖 in the
  title bar puts them back, and is only offered when the toolchain brought
  examples along at all — inside the repository they are ordinary workspace
  projects and there is nothing to add. **Launch Example…** reaches them
  either way, and one that is already selected stays in the list even with
  the toggle off, so hiding them never blanks the picker.
- **System** — where the program runs. A project whose `8bs.config.ts`
  declares a
  [`systems` block](../../docs/systems.md#the-machines-a-project-is-set-up-for)
  gets those first, in a group of their own, above the nine bare machines
  (`8bitscript.system`); the list and the title beside each id come from
  `8bs targets --json`.

```
SYSTEM
[ ── This project ──────────────────── ]
[  Commander X16          —  cx16      ]
[  C64 with a mouse       —  c64 · port1=mouse1351 ]
[  VIC-20, expanded to 8K —  vic20 · ram=8k        ]
[ ── Machines ───────────────────────── ]
[  c64 — Commodore 64                   ]
[  nes — Nintendo …        (not a target)]
```

  A system marked **(too small)** is one the program cannot run on: the
  project's config sets a
  [floor](../../docs/systems.md#the-floor-a-program-sets) in its `requires`
  block — so much RAM, so much disk — and that machine, fitted that way,
  gives less. It is still listed and still runnable; the notice line says
  what is short, and `8bs build` is the authority that refuses.

  A named system is one choice that fits the machine, its hardware **and**
  its region together — it is a `8bs run` line the project wrote down.
  Picking one is the same as reaching that machine by hand, and reaching
  it by hand is recognised as that system: the button names it either way,
  because the panel compares what the options resolve to rather than
  remembering what was clicked.

  **Save as a System…** in the title bar's overflow menu goes the other
  way: name what the panel is set to and it is written into the project's
  `8bs.config.ts` as an entry in that block, so the arrangement is one
  choice from then on, for everyone who has the repository. The write is
  an ordinary editor edit — it lands in the undo stack, and a config this
  cannot safely rewrite (one that computes its targets rather than writing
  them out) is opened with the entry at your cursor to place.
- **Hardware · Region · Facts** — one disclosure holding everything a run
  usually does not care about, with the current fitting beside its name so
  a run that does not care never opens it.
- **Running** — a row per `8bs` task in flight, each with its own **Stop**,
  which ends the task and the emulator with it. The section is not there
  when nothing is running.
- The last line is the exact `8bs` command the Run button will start.

The view's title bar has 📖 **Show or Hide Examples**, 🚀 **Launch Studio**,
♥ **Doctor** (`8bs doctor`), and ⟳ **Refresh**; its overflow menu adds **Launch App…**, **Launch
Example…**, and **Save as a System…**. Those, and every choice the panel makes, are on the command
palette as well — **8BitScript: Select Project**, **Select System**,
**Select Region**, **Run**, **Build**, **Stop**, **Open Entry File**,
**Open 8bs.config.ts**.

### What is behind the fold

```
▾ HARDWARE · REGION · FACTS  reu512 sid=8580
  REGION
  [ NTSC — US/Japan, 60Hz          ▾ ]
  FITTED WITH
  [ reu512                         ▾ ]
    RAM Expansion Unit  build · probe
    [ REU, 512 KiB  [probe]        ▾ ]
    SID
    [ 8580 (the later SID)         ▾ ]
    Control port 1
    [ Commodore 1351 mouse         ▾ ]
    Back to stock
    ▸ What a program can rely on
```

- **Region** — NTSC (60Hz) or PAL (50Hz) for the machines that have one
  (`8bitscript.region`); greyed out while the system is `web`, which has no
  region, or `pet`, whose refresh rate is its model's (`8bs run pet
  --profile 4032` for a 50Hz machine) rather than a region's.
- **Fitted with** — a preset: *Stock machine*, then any profile this
  project composes in its `8bs.config.ts`, then the catalog presets
  (`reu512`, `8032`, `8k`, …).
- Under it, **every catalog option is its own dropdown** — RAM expansion,
  PET/Atari model, VIC-20 memory, SID, control ports — each showing the
  value the preset (or stock) ends up with. Change one to override the
  preset; those rows go bold. `[build]` marks a value that changes the
  program, not only the emulator; `probe` marks a value the machine finds
  at run time (a C64 REU, through `@8bitscript/c64/reu`), so one build
  serves it and the stock machine alike. The selection is
  `8bitscript.hardware`, an object keyed by system, and it rides on every
  Run and Build as `--profile` and `--hardware`. *Back to stock* clears it
  (stock is the catalog's default, or the project's own
  `targets.<system>.hardware` when its config sets one).
- **What a program can rely on** is the fact sheet that selection gives
  `@8bitscript/system`'s consts — the grid, the sprites, the voices, the
  RAM — with a run-time fact (a REU, a mouse) shown as *may use*.

The extension lists nothing of its own here: it asks the toolchain (`8bs
targets --json`), so a new option, or a new fact, in a package appears with
no extension update.

Each choice is an ordinary setting, written at workspace level when a folder
is open, so it also appears in the Settings editor and survives a restart.

### Projects, tasks, and what is missing

A project is any directory containing an `8bs.config.ts`; that file is
already the manifest the CLI reads for the entry file and the target list,
so the launcher uses it as the marker rather than a second list to
maintain. A `package.json` on its own does not count — every package in a
monorepo has one. The search covers every workspace folder, skips
`node_modules`, `.git`, and `.claude/worktrees`, and the launcher refreshes
itself when a config file is added, removed, or edited.
`8bitscript.examplesPath` names a different examples directory if you have
one.

**Launch Studio**, **Launch App…**, and **Launch Example…** start one of
the shipped programs without making it the selected project: pick it (when
there is a choice), pick where to open it — a program whose config
declares systems offers those by name, so Studio is launched on *"VIC-20,
expanded to 8K"* rather than on `vic20` — and it runs as an ordinary `8bs
run` task. The hardware that launch fits is the program's own; it does not
disturb what you have fitted for your work. An app is run with the
toolchain that found it, so an installed Studio launches even though its
own directory sits inside `node_modules`.

Every run and build is also a task of type `8bs`, so **Tasks: Run Task**
lists them, and a favourite can be pinned in `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "8bs",
      "command": "run",
      "project": "examples/borders",
      "target": "c64",
      "pal": true,
      "label": "borders on a PAL C64"
    }
  ]
}
```

`project` is relative to the workspace folder and defaults to the folder
itself; `command` is `run`, `build`, or `doctor`; `pal` is optional. This
is the way to keep a run the launcher's two dropdowns cannot express — a
second system, the other region — one keystroke away.

A project whose dependencies have never been installed — it declares some
and has no `node_modules` of its own, which is how a freshly cloned example
looks — gets a **Run `pnpm install`** button under the launch buttons (or
`npm`/`yarn`, whichever lockfile is nearest), which runs it in the project
as a task. Running such a project asks first, because otherwise the
compiler fails on the first import it cannot resolve, with a message about
the package rather than the install. A project whose toolchain is missing
altogether cannot be run at all, and the panel says so.

The Commodore targets need the LLVM-MOS SDK, which the CLI finds through
`LLVM_MOS_HOME`. A task's shell is non-interactive and does not read
`~/.zshrc`, so an `export` there is invisible to it and `8bs doctor` from the
side bar reports the SDK missing while the terminal has it. The extension
sets `LLVM_MOS_HOME` on every task it starts: from the `8bitscript.llvmMosHome`
setting if given, else from the editor's own environment, else from the
install location the setup guide uses (`~/.local/opt/llvm-mos`) when the SDK
is there. The durable fix is to export the variable from `~/.zshenv` or
`~/.profile` instead — see [the SDK setup](../../docs/setup/llvm-mos.md).

## The grammar is provisional

8BitScript's syntax is not fully specified yet. `syntaxes/8bs.tmLanguage.json`
covers the TypeScript-derived surface the project documentation actually
shows, the primitive integer types (both the friendly spelling — `utinyint`,
`int`, ... — and the low-level `u8`/`i8`-style aliases), and the hardware
escape hatches that already exist: `@address` decorators,
`volatile`/`ptr`/`array`, and `asm6502` blocks. A keyword the language turns
out not to have simply never matches, so a wrong guess costs a word that does
not colour rather than a broken file.

This is still only lexical colouring — it has no idea what a name refers to.
The language server layers semantic information over it once it has a binder
to draw on; until then, hover and completion (see above) are the only
compiler-backed intelligence in the editor.

## Installing it

Install **8BitScript** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=8bitscript.8bitscript-lang)
or from [Open VSX](https://open-vsx.org/extension/8bitscript/8bitscript-lang)
(Cursor uses Open VSX). The extension talks to `8bs` in the project:
`pnpm add -D @8bitscript/cli` so `node_modules/.bin/8bs` exists.

## Installing it while developing the extension

Link this directory into the editor's extensions folder, then reload the window.

Cursor:

```bash
ln -s "$PWD/editors/vscode" ~/.cursor/extensions/8bitscript.8bitscript-lang-0.1.0
```

VS Code:

```bash
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/8bitscript.8bitscript-lang-0.1.0
```

Run either from the repository root. Then **Developer: Reload Window** from the
command palette, open a `.8bs` file, and check that the language indicator in
the status bar reads *8BitScript*.

A symlink is used rather than a copy so that editing the grammar and reloading
the window is the whole development loop. There is a `node --test` suite for
the parts that do not need the editor — config reading, toolchain lookup, the
command each button runs, and the shape of the launcher page and the manifest
behind it — under `test/`; `pnpm test` from the repository root runs it along
with everything else. If the editor does not pick up the
symlink, copy the directory instead of linking it — some builds scan for real
directories. Remove it with `rm` on the link; nothing else is touched.

## Publishing

A `.vsix` is built with `@vscode/vsce` and published to the Visual Studio
Marketplace and to Open VSX. The tag workflow (`.github/workflows/release.yml`)
runs both when `v*` is pushed. Locally, from `editors/vscode`:

```bash
npx @vscode/vsce package
npx @vscode/vsce publish
npx ovsx publish
```
