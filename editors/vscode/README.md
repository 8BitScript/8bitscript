# 8BitScript for VS Code and Cursor

Syntax highlighting, a real language server, and a project runner for `.8bs`
files. The extension itself is still a thin client: it finds the project's
`8bs` toolchain and runs `8bs lsp --stdio`, and every diagnostic, hover, and
completion it shows comes from `@8bitscript/compiler` through that server —
not from anything reimplemented here. The same goes for building and running:
the side bar's launcher only ever starts the `8bs run` and `8bs build`
commands you would otherwise type. See [Editor support](../../docs/language-server.md) for
the split between the compiler, the language server, and this extension.

## New to 8BitScript?

It's a statically compiled language for 6502-based 8-bit machines and the
web — closer to C than to BASIC or hand-written assembly. There's no
interpreter and no garbage collector; 8BitScript's own backends lower IR
to machine code and WebAssembly, and the two that ship in 0.2.0 (the
Commodore PET and the web) now emit for real — `8bs build` and `8bs run`
work end to end for both, right from this extension's own launcher. A
range-checked type like `u8` is a compile error on overflow
(`300 does not fit in u8 (0..255)`) instead of a silent wrap, and one
source resolves per target through packages instead of `#ifdef`. The
language itself targets nine machines; **this extension's System list is
limited to the two 0.2.0 builds for — the Commodore PET and the web** —
until the rest come back with their native backends.

Compiled size sits close to hand-written C for that same reason: the same
screen built by hand in C came to 178 bytes on a C64, the equivalent
through 8BitScript's portable `screen`/`text` calls to 482, and through a
reusable UI component to 809 — the difference being what gets computed at
compile time (the hand-written version) versus resolved at run time (the
portable one). `8bs build` reports exactly what a program used, and a
build that doesn't fit its machine's RAM — 3583 bytes on the unexpanded
VIC-20 8BitScript targets first — is refused rather than truncated.

Full byte-by-byte accounting is in
[docs/compiler.md](../../docs/compiler.md#what-a-call-costs-on-a-6502-measured);
the project overview is in the [root README](../../README.md).

## What it does

- Registers `.8bs` as the language **8BitScript**
- Colors comments, strings and template strings (with their `${...}`
  fields), numbers (including the `0.5` a `#frames(...)` duration takes),
  types, keywords, declarations, calls, the compile-time `#frames(...)`
  and `#system()` (any `#name` colors as compile-time), the reserved `waitFrame()`, and
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
    `@address`, `memory.read`/`memory.write`), the builtins
    `#frames(...)`, its `seconds` unit, and `waitFrame()`, and a member of
    a named import's own namespace — `screen.blank(...)` shows its
    signature and doc comment, read from whichever module the import
    actually resolves to
  - **Completion** — built-in type names in type position (after `:` or
    inside `ptr<...>`/`array<...>`/`volatile<...>`), the compile-time
    functions after a `#`, the unit words inside a `#frames(...)` call, and
    — right after `object.` — the members a named import brings in
    (`screen.bl` offers `blank`) — inside a template's `${...}` field as
    much as outside one

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
  │  ▶   Run Studio                              │
  │      Commodore PET · 8032                    │
  └──────────────────────────────────────────────┘

  SYSTEM
  [ pet — Commodore PET                     ▾ ]

  PROJECT
  [ Studio  —  packages/studio              ▾ ] 🔧 📄

  ▸ HARDWARE · FACTS   model=8032

  RUNNING
    Studio         run · pet                  ⏹

  8bs run pet --profile 8032
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
  project does not target the selected system, or its emulator is
  missing, and says which in the line below. Run and Build work for real on
  `pet` and `web` — the two 0.2.0 targets; every other system still refuses,
  since its own backend doesn't exist yet.
- **Build** (🔧 on the Project row) — the same as Run, but `8bs build
  --target <system>`, which stops at the built file instead of starting an
  emulator.
- **Project** — the project both buttons act on (`8bitscript.project`).
  Every directory in the workspace with an `8bs.config.ts` is in the list,
  grouped with the **Apps** that ship with the toolchain — packages whose
  `package.json` declares an `8bitscript.app`, [Studio](../../docs/studio.md)
  being the first. The grouping appears only when the list holds more than one kind.
  The 📄 beside it opens the project's entry `.8bs` file. Picking a project
  loads what it is set up for — the first of its systems, hardware and
  region and all — and a project with none keeps the current machine when
  it targets it.

  **The examples that ship with the toolchain are in the list** under an
  *Examples* heading of their own (`8bitscript.showExamples`, on by
  default). They come from `@8bitscript/examples`, which `@8bitscript/cli`
  depends on, so any project that has installed the CLI has them — today
  that's `hello-world`, the program the 0.2.0 PET and web backends are
  built against. The 📖 in the title bar hides or shows them. **Launch
  Example…** reaches them either way, and one that is already selected
  stays in the list even with the toggle off, so hiding them never blanks
  the picker.
- **System** — where the program runs. A project whose `8bs.config.ts`
  declares a
  [`systems` block](../../docs/systems.md#the-machines-a-project-is-set-up-for)
  gets those first, in a group of their own, above the bare machines
  (`8bitscript.system`); the list and the title beside each id come from
  `8bs targets --json`. **0.2.0 limits the bare-machine list to `pet` and
  `web`** — `ALL_TARGETS` in `projects.cjs`, one array, is the whole of
  that restriction, and it grows again as a parked machine's native
  backend lands. A project's own `systems` block still shows whatever it
  names, even a parked machine, since that path reads the config directly.

```
SYSTEM
[ ── This project ──────────────────── ]
[  PET 8032               —  pet · profile=8032 ]
[  The browser            —  web       ]
[ ── Machines ───────────────────────── ]
[  pet — Commodore PET                  ]
[  web — Web                            ]
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
  it by hand is recognized as that system: the button names it either way,
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
▾ HARDWARE · FACTS  model=8032
  FITTED WITH
  [ 8032                           ▾ ]
    Model
    [ 8032: 80 columns, 32K, business keyboard, 50 Hz  ▾ ]
    Disk drive
    [ 2040/4040 (170K disk)              ▾ ]
    Back to stock
    ▸ What a program can rely on
```

- **Region** — NTSC (60Hz) or PAL (50Hz) for the machines that have one
  (`8bitscript.region`); greyed out while the system is `web`, which has no
  region, or `pet`, whose refresh rate is its model's (`8bs run pet
  --profile 4032` for a 50Hz machine) rather than a region's. Since 0.2.0's
  System list is only these two, this control currently has nothing to
  show — it comes back automatically once a machine with a region
  (`vic20`, `c64`, `c128`, `atari8`, `mega65`) is un-parked, with no code
  change needed for it.
- **Fitted with** — a preset: *Stock machine*, then any profile this
  project composes in its `8bs.config.ts`, then the catalog presets
  (`reu512`, `8032`, `8k`, …).
- Under it, **every catalog option is its own dropdown** — RAM expansion,
  PET/Atari model, VIC-20 memory, SID, control ports — each showing the
  value the preset (or stock) ends up with. Change one to override the
  preset; those rows go bold. The PET has two, `model` and `drive` — no
  option of either machine 0.2.0 supports has a run-time probe today, so
  neither shows a `probe` badge; a value that changes the program itself
  (the PET's `model`, which sets `__ram_size`) is marked `[build]`, the
  same as it would be on any machine with one. The selection is
  `8bitscript.hardware`, an object keyed by system, and it rides on every
  Run and Build as `--profile` and `--hardware`. *Back to stock* clears it
  (stock is the catalog's default, or the project's own
  `targets.<system>.hardware` when its config sets one).
- **What a program can rely on** is the fact sheet that selection gives
  `@8bitscript/system`'s consts — the grid, the RAM, storage — with a
  run-time-detected fact shown as *may use* on the machines that have one
  (a C64 REU is the example the catalog itself documents; neither the PET
  nor the web has one today).

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
`8bitscript.examplesPath` names a directory of your own examples instead of
the shipped ones, if you have one.

**Launch Studio**, **Launch App…**, and **Launch Example…** start one of
the shipped programs without making it the selected project: pick it (when
there is a choice), pick where to open it — a program whose config
declares systems offers those by name, so Studio is launched on *"PET
8032"* rather than on `pet` — and it runs as an ordinary `8bs
run` task. The hardware that launch fits is the program's own; it does not
disturb what you have fitted for your work. An app is run with the
toolchain that found it, so an installed Studio launches even though its
own directory sits inside `node_modules`.

Every run and build is also a task of type `8bs`, so **Tasks: Run Task**
lists them, and a favorite can be pinned in `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "8bs",
      "command": "run",
      "project": "packages/studio",
      "target": "pet",
      "label": "Studio on the PET"
    }
  ]
}
```

`project` is relative to the workspace folder and defaults to the folder
itself; `command` is `run`, `build`, or `doctor`; `pal` is optional. This
is the way to keep a run the launcher's two dropdowns cannot express — a
second system, the other region — one keystroke away.

A project whose dependencies have never been installed — it declares some
and has no `node_modules` of its own, which is how a freshly cloned
project looks — gets a **Run `pnpm install`** button under the launch buttons (or
`npm`/`yarn`, whichever lockfile is nearest), which runs it in the project
as a task. Running such a project asks first, because otherwise the
compiler fails on the first import it cannot resolve, with a message about
the package rather than the install. A project whose emulator is missing
altogether cannot be run at all, and the panel says so. `pet` and `web`
build and run for real; every other target is still refused.

## The grammar is provisional

8BitScript's syntax is not fully specified yet. `syntaxes/8bs.tmLanguage.json`
covers the TypeScript-derived surface the project documentation actually
shows, the primitive integer types (both the friendly spelling — `utinyint`,
`int`, ... — and the low-level `u8`/`i8`-style aliases), and the hardware
escape hatches that already exist: `@address` decorators,
`volatile`/`ptr`/`array`, and `asm6502` blocks. A keyword the language turns
out not to have simply never matches, so a wrong guess costs a word that does
not color rather than a broken file.

This is still only lexical coloring — it has no idea what a name refers to.
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
Marketplace and to Open VSX. The release workflow
(`.github/workflows/release.yml`) runs both. Locally, from `editors/vscode`:

```bash
pnpm package
```

That writes `dist/8bitscript-lang.vsix` (gitignored, same as the
minified bundle). CI publishes from `/tmp`; do not leave a `.vsix` in
this directory.

`vscode:prepublish` minifies the bundle. Diagnostics, hover, and completion
come from `8bs lsp` over a small stdio JSON-RPC client in this package, not
from Microsoft's `vscode-languageclient`. The remaining weight is the
launcher side bar, the grammar, and this README — not a second copy of the
compiler. See [Editor support](../../docs/language-server.md).
