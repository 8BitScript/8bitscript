# 8BitScript for VS Code and Cursor

Syntax highlighting, a real language server, and a project runner for `.8bs`
files. The extension itself is still a thin client: it finds the project's
`8bs` toolchain and runs `8bs lsp --stdio`, and every diagnostic, hover, and
completion it shows comes from `@8bitscript/compiler` through that server —
not from anything reimplemented here. The same goes for building and running:
the side bar's Run buttons only ever start the `8bs run` and `8bs build` commands you
would otherwise type. See [Editor support](../../docs/language-server.md) for
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
file explorer, search, and source control live. Clicking it opens a side bar
with two sections.

**Run Settings** is four lines: what to run, where to run it, and — folded
away until you want it — the hardware fitted to that machine.

```
PROJECT
[ menubar — c64, nes, web ▾ ]  [ Run ] [ Build ]
SYSTEM                       REGION
[ c64 — Commodore 64     ▾ ] [ NTSC ▾ ]
▸ HARDWARE  reu512 sid=8580
8bs run c64 --profile reu512 --hardware sid=8580
```

Opening **Hardware** unfolds the preset and one dropdown per catalog
option, and nothing else moves on the screen:

```
▾ HARDWARE  reu512 sid=8580
[ reu512                      ▾ ]
  RAM Expansion Unit  build · probe
  [ REU, 512 KiB  [probe]     ▾ ]
  SID
  [ 8580 (the later SID)      ▾ ]
  Control port 1
  [ Commodore 1351 mouse      ▾ ]
  Back to stock
  ▸ What a program can rely on
```

- **Project** — the project Run and Build act on, with the systems it
  targets beside its name (`8bitscript.project`). The list is the same one
  the Projects view below shows: the workspace's own projects, the apps
  that ship with the toolchain, and its examples when those are turned on.
  **Run** and **Build** start the same task a row's buttons do, and are
  greyed out when the project does not target the selected system — the
  hint line says so in place of the command.
- **System** — one of the nine targets, every Run and Build uses
  (`8bitscript.system`). The list, and the title beside each id, come from
  `8bs targets --json`.
- **Region** — NTSC (60Hz) or PAL (50Hz) for the machines that have one
  (`8bitscript.region`); it is greyed out while the system is `web`, which
  has no region, or `pet`, whose refresh rate is its model's (`8bs run pet
  --profile 4032` for a 50Hz machine) rather than a region's.
- **Hardware** — what is on the selected system when it runs, folded away
  with the current fitting beside its name so a run that does not care
  never sees it. The top control is a preset: *Stock machine*, then any
  profile this project composes in its `8bs.config.ts`, then the catalog
  presets (`reu512`, `8032`, `8k`, …). Under that, **every catalog option
  is its own dropdown** — RAM expansion, PET/Atari model, VIC-20 memory,
  SID, control ports — each showing the value the preset (or stock) ends up with.
  Change one to override the preset; those rows go bold. `[build]` marks a
  value that changes the program, not only the emulator; `probe` marks a
  value the machine finds at run time (a C64 REU, through
  `@8bitscript/c64/reu`), so one build serves it and the stock machine
  alike. The selection is `8bitscript.hardware`, an object keyed by
  system, and it rides on every Run and Build as `--profile` and
  `--hardware` — the hint shows the exact `8bs run` line. *Back to stock*
  clears it (stock is the catalog's default, or the project's own
  `targets.<system>.hardware` when its config sets one). Under the
  options, *What a program can rely on* is the fact sheet that selection
  gives `@8bitscript/system`'s consts — the grid, the sprites, the voices,
  the RAM — with a run-time fact (a REU, a mouse) shown as *may use*. The
  extension lists nothing of its own here; it asks the toolchain (`8bs
  targets --json`), so a new option, or a new fact, in a package appears
  with no extension update.
How the Projects list below is laid out (`8bitscript.projectsView`) and
whether it shows the toolchain's examples (`8bitscript.showExamples`) are
buttons on **that** view's title bar, not rows in this panel — it sits
above the list and must not push the list off the screen.
`8bitscript.examplesPath` names a different examples directory if you have
one.

Each choice is an ordinary setting, written at workspace level when a folder
is open, so it also appears in the Settings editor and survives a restart.
The same choices are on the command palette as **8BitScript: Select
System**, **Select Region**, and **Change Projects View**.

**Projects** lists what can be run, in one of three layouts, and keeps
three kinds of project apart when the list holds more than one of them:
the workspace's own **Projects**; the **Examples** from the
8bitscript repository's `examples/`, there to exercise
the toolchain; and the **Apps** that ship with the toolchain — packages
whose `package.json` declares an `8bitscript.app`, found beside the
`@8bitscript/cli` in use. Studio is the first app.

```
PROJECTS  runnable on cx16                          ⊞ 📖 🚀 ♥ ⟳
  Projects
    my-game           src/my-game                     ▶ 🔧
  Examples
    borders           examples/borders                ▶ 🔧
  Apps
    Studio            @8bitscript/studio              ▶ 🔧
```

- **Runnable on the selected system** (the default) — one row per project
  that targets the selected system. Run and Build on the row use that
  system and region, so it is one click from the dropdowns to the emulator.
  A project that does not target the system is left out; if none do, the
  view says so.
- **By project** — every project, expanded into the systems it targets,
  with Run and Build on each system row.
- **By system** — every system with at least one project, expanded into the
  projects that target it; the selected system starts expanded.

The ⊞ button in the title switches layout, 📖 toggles the examples of
concept (only shown when there are any), 🚀 launches Studio, ♥ runs
`8bs doctor`, and ⟳ rescans.

**Launch Studio**, **Launch App…**, and **Launch Example…** on the
command palette start one of the shipped programs without hunting for its
row: pick it (when there is a choice), pick the system to open it on — the
selected system is offered first — and it runs as an ordinary `8bs run`
task. An app is run with the toolchain that found it, so an installed
Studio launches even though its own directory sits inside `node_modules`.

A project is any directory containing an `8bs.config.ts`; that file is
already the manifest the CLI reads for the entry file and the target list,
so the view uses it as the marker rather than a second list to maintain. A
`package.json` on its own does not count — every package in a monorepo has
one. The search covers every workspace folder, skips `node_modules`, `.git`,
and `.claude/worktrees`, and the view refreshes itself when a config file is
added, removed, or edited.

**Run** starts `8bs run <target>` and **Build** starts `8bs build --target
<target>` as a task in its own terminal, from the project's directory with
the project's own `node_modules/.bin/8bs`, so what you see is exactly what
the CLI prints. A row's right-click menu offers *Run (NTSC)*, *Run (PAL)*,
*Build (NTSC)*, and *Build (PAL)* explicitly for the Commodore systems. A
running row shows a spinner and a **Stop** button, which terminates the task
(and with it the emulator).

Clicking a project opens its entry `.8bs` file. Its right-click menu has
*Open 8bs.config.ts*, *Reveal in Explorer*, and *Open in Integrated
Terminal*. From the command palette, **8BitScript: Run** and **8BitScript:
Build** ask which project and system, offering the selected system first.

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
itself; `command` is `run`, `build`, or `doctor`; `pal` is optional.

A project whose dependencies have never been installed — it declares some
and has no `node_modules` of its own, which is how a freshly added example
of concept looks — is listed with a warning icon and *not installed*, and gets an
**Install** button that runs `pnpm install` (or `npm`/`yarn`, whichever
lockfile is nearest) in the project as a task. Running such a project asks
first, because otherwise the compiler fails on the first import it cannot
resolve, with a message about the package rather than the install. A
project whose toolchain is missing altogether is marked *toolchain not
installed*; running it explains how to fix that.

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

## Installing it while developing

Link this directory into the editor's extensions folder, then reload the window.

Cursor:

```bash
ln -s "$PWD/editors/vscode" ~/.cursor/extensions/8bitscript.8bitscript-lang-0.0.0
```

VS Code:

```bash
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/8bitscript.8bitscript-lang-0.0.0
```

Run either from the repository root. Then **Developer: Reload Window** from the
command palette, open a `.8bs` file, and check that the language indicator in
the status bar reads *8BitScript*.

A symlink is used rather than a copy so that editing the grammar and reloading
the window is the whole development loop. The projects view has a `node --test`
suite for the part that does not need the editor — config reading, toolchain
lookup, and the command each button runs — under `test/`; `pnpm test` from the
repository root runs it along with everything else. If the editor does not pick up the
symlink, copy the directory instead of linking it — some builds scan for real
directories. Remove it with `rm` on the link; nothing else is touched.

## Publishing it later

Distribution is a `.vsix` built with `@vscode/vsce` and either uploaded to the
marketplace or installed with `cursor --install-extension <file>.vsix`. That is
not set up yet, and it is not worth setting up until the grammar has settled.
